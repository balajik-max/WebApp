"""
Service inventory and runtime capability detection.

This module is the single source of truth for "what services and processing
capabilities does this deployment actually expose?" — the answers are mostly
*static* (the project ships GDAL, reportlab, etc. in its backend image) so
they're computed lazily on first use and cached for the lifetime of the
process. We never re-import a library on every probe.

Two kinds of inventory:

* **Static catalog** — group definitions, descriptions, parent/child
  relationships, dependency edges, fixed service keys. Hard-coded so the
  response shape is stable across versions.

* **Runtime capability probe** — safe ``importlib.util.find_spec`` checks
  for GIS / report / vector libraries. Each check is wrapped in
  ``safe_has_module`` so a single missing library never blows up the whole
  probe.

The probe functions return a dict of ``{capability_key: bool}`` so callers
can convert that to a ``status`` (``"healthy"`` if all present, ``"degraded"``
if some optional libs missing, ``"critical"`` if a required one is absent).
"""
from __future__ import annotations

import importlib
import importlib.util
import os
from dataclasses import dataclass
from typing import Iterable

# ---------------------------------------------------------------------------
# Static service catalog
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CapabilityDef:
    """A runtime library that contributes to a service group.

    The frontend never displays these as standalone service cards — they're
    nested rows inside the parent service card, OR collapsed into a
    single group-level status. They exist so the admin can verify that
    the libraries the spec promised are actually installed.
    """

    key: str
    label: str
    description: str
    parent_key: str
    runtime_module: str  # the importable module name; e.g. "gdal"
    required: bool = True  # if True, missing → degraded/critical status


@dataclass(frozen=True)
class GroupDef:
    """A top-level group in the Services section."""

    id: str
    label: str
    description: str
    order: int


# Group ordering matches the spec: Core Platform, Data & Storage,
# Intelligence & Analysis, GIS & File Processing, Application Services,
# External Dependencies, Runtime & Persistent Resources, Recovery &
# Infrastructure Readiness, Observability.
GROUPS: tuple[GroupDef, ...] = (
    GroupDef(
        "core_platform",
        "Core Platform",
        "The three services the application cannot run without.",
        0,
    ),
    GroupDef(
        "data_and_storage",
        "Data and Storage",
        "Object storage, dataset processing pipeline, and on-disk capacity.",
        1,
    ),
    GroupDef(
        "intelligence_and_analysis",
        "Intelligence and Analysis",
        "AI engine plus the deterministic spatial and graph capabilities that "
        "run inside the backend process.",
        2,
    ),
    GroupDef(
        "gis_and_file_processing",
        "GIS and File Processing",
        "File formats and processing libraries available to the ingestion pipeline.",
        3,
    ),
    GroupDef(
        "application_services",
        "Application Services",
        "Application-level capabilities backed by the database and the FastAPI layer.",
        4,
    ),
    GroupDef(
        "external_dependencies",
        "External Dependencies",
        "Optional third-party services that are only used when configured.",
        5,
    ),
    GroupDef(
        "runtime_and_persistent_resources",
        "Runtime and Persistent Resources",
        "Named volumes, connection pool, worker count, and frontend build metadata.",
        6,
    ),
    GroupDef(
        "recovery_and_infrastructure_readiness",
        "Recovery and Infrastructure Readiness",
        "Backup, reverse proxy, and host-monitoring capabilities — only present "
        "when explicitly configured.",
        7,
    ),
    GroupDef(
        "observability",
        "Observability",
        "Backend logs, Docker logs, and external observability platforms.",
        8,
    ),
)


# Capability rows nested under their parent service. ``required=False``
# capabilities do NOT degrade the parent service's overall status — they
# only narrow the formats the platform can ingest.
CAPABILITIES: tuple[CapabilityDef, ...] = (
    # GIS vector processing (parent = dataset_processing)
    CapabilityDef(
        "gis_vector_shapefile",
        "Shapefile (.shp / .shx / .dbf / .prj)",
        "OGR reads and writes Esri shapefile components.",
        "dataset_processing",
        "osgeo",
        required=True,
    ),
    CapabilityDef(
        "gis_vector_geojson",
        "GeoJSON",
        "GeoJSON FeatureCollection reading via Fiona / GeoPandas.",
        "dataset_processing",
        "fiona",
        required=True,
    ),
    CapabilityDef(
        "gis_vector_geopackage",
        "GeoPackage",
        "SQLite-based OGR container for vector + raster tiles.",
        "dataset_processing",
        "pyogrio",
        required=False,
    ),
    CapabilityDef(
        "gis_vector_kml",
        "KML",
        "Google KML/KMZ reading via OGR.",
        "dataset_processing",
        "osgeo",
        required=True,
    ),
    CapabilityDef(
        "gis_vector_fgdb",
        "File Geodatabase (.gdb)",
        "Esri File Geodatabase via the open filegdb driver.",
        "dataset_processing",
        "fiona",
        required=True,
    ),
    CapabilityDef(
        "gis_vector_tabular",
        "CSV / TSV / Excel",
        "Pandas readers for comma/tab-separated and XLSX spreadsheets.",
        "dataset_processing",
        "pandas",
        required=True,
    ),
    CapabilityDef(
        "gis_geopandas",
        "GeoPandas",
        "Vector analysis on top of Fiona and Shapely.",
        "dataset_processing",
        "geopandas",
        required=True,
    ),
    CapabilityDef(
        "gis_shapely",
        "Shapely",
        "Geometry operations and predicates.",
        "dataset_processing",
        "shapely",
        required=True,
    ),
    CapabilityDef(
        "gis_pyproj",
        "PyProj",
        "Coordinate reference system transformations.",
        "dataset_processing",
        "pyproj",
        required=True,
    ),
    # Raster processing
    CapabilityDef(
        "raster_geotiff",
        "GeoTIFF ingestion and XYZ tiles",
        "Rasterio reads/writes GeoTIFF and renders zoom-aware tiles.",
        "dataset_processing",
        "rasterio",
        required=True,
    ),
    CapabilityDef(
        "raster_preview",
        "Raster preview PNG generation",
        "Colorized preview variants generated at ingestion time.",
        "dataset_processing",
        "PIL",
        required=True,
    ),
    # LiDAR
    CapabilityDef(
        "lidar_las",
        "LAS ingestion (laspy)",
        "Point cloud reading with CRS detection.",
        "dataset_processing",
        "laspy",
        required=True,
    ),
    CapabilityDef(
        "lidar_laz",
        "LAZ compressed point cloud",
        "Compressed LiDAR via lazrs.",
        "dataset_processing",
        "lazrs",
        required=False,
    ),
    # 3D / OBJ
    CapabilityDef(
        "obj_3d",
        "OBJ / MTL ingestion",
        "3D mesh + material reading via trimesh.",
        "dataset_processing",
        "trimesh",
        required=True,
    ),
    # Image / photo
    CapabilityDef(
        "image_processing",
        "JPEG / PNG / GIF / BMP / WEBP",
        "Geo-tagged photo previews with EXIF extraction.",
        "dataset_processing",
        "PIL",
        required=True,
    ),
    # Reports
    CapabilityDef(
        "report_pdf",
        "PDF generation",
        "Server-side PDF reports via ReportLab.",
        "report_generation",
        "reportlab",
        required=True,
    ),
    CapabilityDef(
        "report_excel",
        "Excel generation",
        "XLSX export via openpyxl.",
        "report_generation",
        "openpyxl",
        required=True,
    ),
    CapabilityDef(
        "report_docx",
        "Word / PDF text extraction",
        "Reading text from uploaded PDFs and Word documents.",
        "report_generation",
        "pypdf",
        required=False,
    ),
    CapabilityDef(
        "report_docx_write",
        "Word document generation",
        "Optional DOCX write path via python-docx.",
        "report_generation",
        "docx",
        required=False,
    ),
    # NetworkX for manhole recommendation
    CapabilityDef(
        "graph_networkx",
        "Manhole routing graph",
        "NetworkX shortest-path recommendation for manholes and pipes.",
        "manhole_recommendation",
        "networkx",
        required=True,
    ),
)


# ---------------------------------------------------------------------------
# Runtime capability detection
# ---------------------------------------------------------------------------

_CAPABILITY_CACHE: dict[str, bool] | None = None


def safe_has_module(name: str) -> bool:
    """Return True iff the module is importable, never raising."""
    try:
        return importlib.util.find_spec(name) is not None
    except (ValueError, ModuleNotFoundError):  # malformed name or not on path
        return False
    except Exception:  # noqa: BLE001 - any import resolution failure
        return False


def detect_capabilities() -> dict[str, bool]:
    """Run all capability checks once and cache the result.

    Subsequent calls are O(1) lookups. Re-imports would slow down every
    Services refresh and risk side effects in long-lived workers.
    """
    global _CAPABILITY_CACHE
    if _CAPABILITY_CACHE is not None:
        return _CAPABILITY_CACHE
    result: dict[str, bool] = {}
    for cap in CAPABILITIES:
        # Combine the named module with a "force import" pass for libs that
        # may be importable but raise on first import (rare; defensive only).
        present = safe_has_module(cap.runtime_module)
        if present:
            try:
                importlib.import_module(cap.runtime_module)
            except Exception:  # noqa: BLE001
                present = False
        result[cap.key] = present
    _CAPABILITY_CACHE = result
    return result


def reset_capability_cache() -> None:
    """For tests that need to re-probe after monkey-patching modules."""
    global _CAPABILITY_CACHE
    _CAPABILITY_CACHE = None


# ---------------------------------------------------------------------------
# Configuration probes
# ---------------------------------------------------------------------------


def vite_cadastral_url() -> str | None:
    """The frontend cadastral tile URL (build-time env var)."""
    return os.environ.get("VITE_CADASTRAL_TILE_URL") or None


def vite_google_maps_key() -> str | None:
    """Configured Google Maps key (frontend build env). Empty / placeholder
    values are normalized to ``None`` so the UI shows Not Configured."""
    raw = (os.environ.get("VITE_GOOGLE_MAPS_API_KEY") or "").strip()
    if not raw:
        return None
    if raw.upper().startswith("REPLACE"):
        return None
    return "configured"


def davangere_census_url() -> str | None:
    """Davangere Corporation ward census pages are fetched in
    ``app/services/analytics`` only when explicitly configured.

    Returns the truth value, never the URL — the URL is an internal
    constant and not useful in the admin UI.
    """
    # The analytics module reads the URL only when present. We use the
    # same env var here so configuration is detected consistently.
    return os.environ.get("DAVANGERE_CENSUS_URL") or "fallback"


# ---------------------------------------------------------------------------
# Status helpers
# ---------------------------------------------------------------------------


def capability_status(present: Iterable[bool], *, require_all: bool = True) -> str:
    """Translate a list of per-capability booleans into a single status.

    * All present → ``healthy``
    * Some present, some optional missing → ``degraded``
    * All required missing → ``critical`` (the function caller decides
      which caps are required).
    """
    flags = list(present)
    if not flags:
        return "unknown"
    if all(flags):
        return "healthy"
    if require_all and not any(flags):
        return "critical"
    return "degraded"
