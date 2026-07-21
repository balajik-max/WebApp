"""
Authoritative point cloud inspection service that handles LAS/LAZ files with optional CRS.

This service provides comprehensive inspection of point cloud files without requiring
full file loading, supporting all the required CRS detection methods in a structured way.
"""
from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import numpy as np
from pydantic import BaseModel

log = logging.getLogger("davangere.point_cloud_inspector")


@dataclass(slots=True)
class PointCloudBounds:
    """XY bounds and Z range."""
    min_x: float
    min_y: float
    max_x: float
    max_y: float
    min_z: float
    max_z: float


@dataclass(slots=True)
class PointCloudWarning:
    """Non-fatal warning for point cloud processing."""
    code: str
    message: str


class PointCloudInspection(BaseModel):
    """
    Comprehensive point cloud inspection result.
    
    Valid LAS/LAZ files without CRS metadata should still return valid=True with
    crs_status='unknown' and appropriate warnings.
    """
    
    model_config = {
        "from_attributes": True,
        "json_schema_extra": {
            "examples": [
                {
                    "valid": True,
                    "format": "laz",
                    "las_version": "1.4",
                    "point_format": 6,
                    "point_count": 1711459,
                    "scales": [0.01, 0.01, 0.01],
                    "offsets": [0, 0, 0],
                    "bounds": {"min_x": 560630.77, "max_x": 560692.87, "min_y": 5111605.35, "max_y": 5111825.76, "min_z": 141.60, "max_z": 390.16},
                    "dimensions": ["X", "Y", "Z", "intensity", "classification"],
                    "compressed": True,
                    "source_crs": None,
                    "crs_status": "unknown",
                    "georeferenced": False,
                    "warnings": [
                        {
                            "code": "POINT_CLOUD_CRS_UNKNOWN",
                            "message": "No embedded coordinate reference system was found. The point cloud has been loaded using its original local coordinates."
                        }
                    ]
                }
            ]
        }
    }
    
    valid: bool
    format: Literal["las", "laz"]
    las_version: str
    point_format: int
    point_count: int
    scales: list[float]
    offsets: list[float]
    bounds: PointCloudBounds
    dimensions: list[str]
    compressed: bool
    source_crs: str | None
    crs_status: Literal["embedded", "sidecar", "user_assigned", "project_default", "unknown"]
    georeferenced: bool
    warnings: list[PointCloudWarning] = field(default_factory=list)
    
    def has_warning(self, code: str) -> bool:
        """Check if a specific warning code exists."""
        return any(w.code == code for w in self.warnings)


def _detect_crs_from_vlrs(header: Any) -> str | None:
    """
    Method 2: Inspect VLR/EVLR records for CRS information.
    
    Looks for:
    - user_id 'LASF_Projection' with standard record IDs
    - record_id 34735: GeoKeyDirectoryTag
    - record_id 34736: GeoDoubleParamsTag
    - record_id 34737: GeoAsciiParamsTag
    - record_id 2111: Math Transform WKT
    - record_id 2112: Coordinate System WKT
    """
    try:
        for vlr in header.vlrs:
            user_id = getattr(vlr, 'user_id', '') or ''
            record_id = getattr(vlr, 'record_id', 0)
            
            # Standard LASF_Projection VLRs
            if user_id.strip() == 'LASF_Projection':
                if record_id in (34735, 34736, 34737):
                    # GeoKeys present — CRS exists but we need parse_crs() to decode it
                    return None
            
            # WKT VLR (LAS 1.4)
            if record_id in (2111, 2112):
                try:
                    wkt_data = bytes(vlr.record_data)
                    if wkt_data:
                        wkt_str = wkt_data.decode('utf-8', errors='ignore').rstrip('\x00')
                        if wkt_str.startswith('GEOGCS') or wkt_str.startswith('PROJCS') or wkt_str.startswith('GEOGCS|'):
                            return f"WKT:{wkt_str[:100]}"
                except Exception:
                    pass
    except Exception as exc:
        log.debug("VLR inspection failed: %s", exc)
    
    return None


def _detect_crs_from_sidecar(file_path: Path) -> str | None:
    """
    Method 6: Check for explicit sidecar metadata files.
    
    Looks for .prj, .wkt, .json, .projjson files matching the base filename.
    """
    base = file_path.with_suffix('')
    sidecar_extensions = ['.prj', '.wkt', '.json', '.projjson']
    
    for ext in sidecar_extensions:
        sidecar = base.with_suffix(ext)
        if sidecar.exists():
            try:
                content = sidecar.read_text(encoding='utf-8', errors='ignore').strip()
                if content:
                    if content.startswith('GEOGCS') or content.startswith('PROJCS'):
                        return f"WKT:{content[:100]}"
                    try:
                        data = json.loads(content)
                        if isinstance(data, dict):
                            crs_info = data.get('crs') or data.get('CRS') or data.get('coordinate_system')
                            if crs_info:
                                return str(crs_info)[:100]
                    except json.JSONDecodeError:
                        pass
            except Exception:
                pass
    
    return None


def inspect_point_cloud(file_path: Path) -> PointCloudInspection:
    """
    Inspect a LAS/LAZ file without loading all points into memory.
    
    Handles both LAS and LAZ formats, validates structure, and attempts
    multiple CRS detection methods in order.
    
    Returns:
        PointCloudInspection: Comprehensive metadata about the file
    """
    try:
        import laspy
    except ImportError as exc:
        raise ValueError(
            "laspy is required to inspect LAS/LAZ files. "
            "Install with: pip install laspy[lazrs]"
        ) from exc
    
    try:
        with laspy.open(file_path) as reader:
            header = reader.header
            point_format = int(header.point_format.id)
            
            # Determine compression from suffix
            compressed = file_path.suffix.lower() == ".laz"
            
            # Try to detect compression from VLRs if suffix is ambiguous
            if not compressed:
                try:
                    for vlr in header.vlrs:
                        user_id = getattr(vlr, 'user_id', '') or ''
                        if 'laszip' in user_id.lower():
                            compressed = True
                            break
                except Exception:
                    pass
            
            # Get basic metadata from header
            las_version = f"{header.version.major}.{header.version.minor}"
            point_count = int(header.point_count)
            
            if point_count == 0:
                return PointCloudInspection(
                    valid=False,
                    format="las" if not compressed else "laz",
                    las_version=las_version,
                    point_format=point_format,
                    point_count=0,
                    scales=[float(v) for v in header.scales[:3]],
                    offsets=[float(v) for v in header.offsets[:3]],
                    bounds=PointCloudBounds(
                        min_x=0.0, max_x=0.0, min_y=0.0, max_y=0.0, min_z=0.0, max_z=0.0
                    ),
                    dimensions=[],
                    compressed=compressed,
                    source_crs=None,
                    crs_status="unknown",
                    georeferenced=False,
                    warnings=[PointCloudWarning(code="POINT_CLOUD_INVALID_DATA", message="LAS/LAZ file has no points")]
                )
            
            min_x, min_y, min_z = header.mins[:3]
            max_x, max_y, max_z = header.maxs[:3]
            bounds = PointCloudBounds(
                min_x=float(min_x),
                min_y=float(min_y),
                max_x=float(max_x),
                max_y=float(max_y),
                min_z=float(min_z),
                max_z=float(max_z),
            )
            
            # Get scales and offsets
            scales = [float(v) for v in header.scales[:3]]
            offsets = [float(v) for v in header.offsets[:3]]
            
            # Get dimension names
            dim_names = set(header.point_format.dimension_names)
            dimensions = sorted(list(dim_names))
            
            # Attempt CRS detection methods in order
            crs = None
            crs_status = "unknown"
            warnings: list[PointCloudWarning] = []
            
            # METHOD 1: LASPY header.parse_crs()
            try:
                header_crs = header.parse_crs()
                if header_crs is not None:
                    crs = _format_crs(header_crs)
                    crs_status = "embedded"
            except Exception as e:
                warnings.append(PointCloudWarning(
                    code="POINT_CLOUD_CRS_MALFORMED", 
                    message=f"Failed to parse CRS from header: {str(e)}"
                ))
            
            # METHOD 2: Raw VLR and EVLR inspection
            if crs is None:
                vlr_crs = _detect_crs_from_vlrs(header)
                if vlr_crs:
                    crs = vlr_crs
                    crs_status = "embedded"
            
            # METHOD 6: Sidecar files
            if crs is None:
                sidecar_crs = _detect_crs_from_sidecar(file_path)
                if sidecar_crs:
                    crs = sidecar_crs
                    crs_status = "sidecar"
            
            # If no CRS found, add warning (NOT an error)
            if crs is None:
                crs_status = "unknown"
                warnings.append(PointCloudWarning(
                    code="POINT_CLOUD_CRS_UNKNOWN",
                    message="No embedded coordinate reference system was found. "
                           "The point cloud will be loaded using its original coordinates."
                ))
            
            # Check bounds validity
            if math.isnan(bounds.min_x) or math.isnan(bounds.min_y) or math.isnan(bounds.max_x) or math.isnan(bounds.max_y):
                warnings.append(PointCloudWarning(
                    code="POINT_CLOUD_INVALID_BOUNDS",
                    message="File has NaN coordinate values in bounding box"
                ))
            elif bounds.max_x <= bounds.min_x or bounds.max_y <= bounds.min_y:
                warnings.append(PointCloudWarning(
                    code="POINT_CLOUD_DEGENERATE_BOUNDS",
                    message="File has a degenerate (zero-area) bounding box"
                ))
            
            # Determine georeferenced status
            georeferenced = crs is not None and crs_status != "unknown"
            
            return PointCloudInspection(
                valid=True,
                format="laz" if compressed else "las",
                las_version=las_version,
                point_format=point_format,
                point_count=point_count,
                scales=scales,
                offsets=offsets,
                bounds=bounds,
                dimensions=dimensions,
                compressed=compressed,
                source_crs=crs,
                crs_status=crs_status,
                georeferenced=georeferenced,
                warnings=warnings,
            )
            
    except Exception as exc:
        log.exception("Failed to inspect point cloud file: %s", file_path)
        suffix = file_path.suffix.lower()
        return PointCloudInspection(
            valid=False,
            format="laz" if suffix == ".laz" else "las",
            las_version="",
            point_format=0,
            point_count=0,
            scales=[0.0, 0.0, 0.0],
            offsets=[0.0, 0.0, 0.0],
            bounds=PointCloudBounds(
                min_x=0.0, max_x=0.0, min_y=0.0, max_y=0.0, min_z=0.0, max_z=0.0
            ),
            dimensions=[],
            compressed=suffix == ".laz",
            source_crs=None,
            crs_status="unknown",
            georeferenced=False,
            warnings=[PointCloudWarning(code="POINT_CLOUD_PROCESSING_FAILED", message=f"Inspection failed: {str(exc)}")],
        )


def _format_crs(crs_obj: Any) -> str:
    """Format a CRS object to a consistent string representation."""
    try:
        epsg = crs_obj.to_epsg()
        if epsg:
            return f"EPSG:{epsg}"
    except Exception:
        pass
    
    try:
        return crs_obj.to_string()
    except Exception:
        pass
    
    try:
        return str(crs_obj)
    except Exception:
        return "Unknown CRS"
