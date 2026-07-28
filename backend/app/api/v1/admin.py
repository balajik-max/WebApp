"""Admin-only system monitoring endpoints.

The original implementation exposed a single ``/services`` payload with
flat fields (api, database, storage, ai_engine, disk_used_percent,
backups, security). That payload is preserved as ``/services/legacy`` so
the older admin widgets and any external dashboards keep working.

The new primary endpoint is ``/services/monitoring`` and returns a
grouped, schema-validated structure that drives the redesigned Services
UI. See ``app/schemas/service_monitoring.py`` for the response shape and
``app/services/service_health.py`` for the per-probe implementations.

All probes are non-fatal — a hung remote becomes "offline" on the
corresponding card, not a 500 for the whole endpoint.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import ollama
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin
from app.api.v1.system import system_storage
from app.core.config import get_settings
from app.db.session import get_db
from app.models import (
    ActivityAction,
    ActivityLog,
    Dataset,
    DatasetStatus,
    PointVerification,
    RemediationWorkflowStatus,
    ReviewItem,
    ReviewPriority,
    ReviewStatus,
    User,
    UserRole,
    UserSession,
)
from app.schemas.admin import (
    ActivityEntryOut,
    AdminActivityOut,
    AdminDatasetsOut,
    AdminServicesOut,
    AdminUserActivityOut,
    AdminWorkflowsOut,
    DatasetStatusCounts,
    FailedDatasetOut,
    SecurityInfo,
    ServiceProbe,
    SessionOut,
    StuckWorkflowOut,
    UserActivityStatsOut,
    UserRoleCount,
    UserSummaryOut,
)
from app.schemas.service_monitoring import (
    ServiceMonitoringGroup,
    ServiceMonitoringItem,
    ServiceMonitoringOut,
    ServiceMonitoringStatus,
    ServiceMonitoringSummary,
)
from app.schemas.security_monitoring import SecurityMonitoringOut
from app.services import security_monitoring, service_health, service_inventory
from app.services.storage import bucket_health

log = logging.getLogger("davangere.admin")
router = APIRouter()

STUCK_WORKFLOW_HOURS = 72
_OPEN_REVIEW_STATES = (ReviewStatus.OPEN, ReviewStatus.REVIEWING, ReviewStatus.IN_PROGRESS)


# ---------------------------------------------------------------------------
# Legacy /services endpoint (preserved)
# ---------------------------------------------------------------------------


async def _ai_health(base_url: str) -> ServiceProbe:
    def _ping() -> None:
        ollama.Client(host=base_url, timeout=4).list()

    try:
        await asyncio.to_thread(_ping)
        return ServiceProbe(status="ok")
    except Exception as exc:  # noqa: BLE001
        return ServiceProbe(status="error", detail=str(exc))


@router.get("/services/legacy", response_model=AdminServicesOut, dependencies=[Depends(require_admin)])
async def admin_services_legacy(db: AsyncSession = Depends(get_db)) -> AdminServicesOut:
    """Pre-redesign flat payload. Preserved for backward compatibility."""
    settings = get_settings()

    try:
        postgis = (await db.execute(text("SELECT PostGIS_Full_Version()"))).scalar()
        database = ServiceProbe(status="ok", detail=postgis)
    except Exception as exc:  # noqa: BLE001
        database = ServiceProbe(status="error", detail=str(exc))

    storage_probe = ServiceProbe(**await bucket_health())
    ai_probe = await _ai_health(settings.ollama_base_url)

    try:
        disk = await system_storage()
        disk_percent = disk.get("used_percent")
    except Exception:  # noqa: BLE001
        disk_percent = None

    return AdminServicesOut(
        api=ServiceProbe(status="ok", detail=settings.app_env),
        database=database,
        storage=storage_probe,
        ai_engine=ai_probe,
        disk_used_percent=disk_percent,
        backups=ServiceProbe(status="unavailable", detail="No backup system is configured for this deployment."),
        security=SecurityInfo(
            csrf_protection=True,
            rate_limit_max=settings.rate_limit_max,
            rate_limit_window_seconds=settings.rate_limit_window_seconds,
            failed_login_tracking=False,
        ),
    )


# ---------------------------------------------------------------------------
# New grouped /services/monitoring endpoint
# ---------------------------------------------------------------------------


def _item(
    *,
    key: str,
    name: str,
    kind: str,
    status: str,
    criticality: str,
    description: str,
    probe: service_health.ProbeResult | None = None,
    dependencies: list[str] | None = None,
    primary_metric: dict[str, Any] | None = None,
    endpoint_label: str | None = None,
    parent_key: str | None = None,
    details: dict[str, Any] | None = None,
) -> ServiceMonitoringItem:
    """Build a ServiceMonitoringItem from a probe result + display fields."""
    return ServiceMonitoringItem(
        key=key,
        name=name,
        kind=kind,
        status=status,
        criticality=criticality,
        description=description,
        primary_metric=primary_metric,
        response_time_ms=probe.response_time_ms if probe else None,
        endpoint_label=endpoint_label,
        last_checked_at=probe.last_checked_at if probe else None,
        detail=probe.detail if probe else None,
        dependencies=dependencies or [],
        parent_key=parent_key,
        details=details or (probe.data if probe else {}),
    )


async def _probe_or_cached(key: str, ttl: float, coro) -> service_health.ProbeResult:
    cached = service_health.monitoring_cache.get(key)
    if cached is not None:
        return cached
    result = await coro
    service_health.monitoring_cache.set(key, result, ttl)
    return result


def _group_status(items: list[ServiceMonitoringItem]) -> str:
    """Roll up item statuses into a single group status.

    Order of precedence (per spec):
    - any ``critical`` or ``offline`` → ``critical``
    - any ``degraded`` → ``degraded``
    - any ``unknown`` and nothing else → ``unknown``
    - all ``not_configured`` → ``not_configured``
    - mixed ``healthy`` + ``partial`` → ``partial``
    - otherwise ``healthy``
    """
    if not items:
        return "unknown"
    statuses = {i.status for i in items}
    if "critical" in statuses or "offline" in statuses:
        return "critical"
    if "degraded" in statuses:
        return "degraded"
    if "unknown" in statuses:
        return "unknown"
    if statuses == {"not_configured"}:
        return "not_configured"
    if statuses == {"healthy"}:
        return "healthy"
    if statuses == {"partial"}:
        return "partial"
    if "healthy" in statuses and "partial" in statuses:
        return "partial"
    if statuses == {"disabled"}:
        return "disabled"
    if "not_configured" in statuses and "healthy" in statuses:
        return "partial"
    return "partial"


def _overall_status(summary: ServiceMonitoringSummary) -> str:
    if summary.critical > 0 or summary.offline > 0:
        return "critical"
    if summary.degraded > 0 or summary.partial > 0:
        return "degraded"
    if summary.healthy == 0 and summary.not_configured > 0:
        return "partial"
    if summary.healthy > 0:
        return "healthy"
    return "unknown"


@router.get(
    "/services",
    response_model=ServiceMonitoringOut,
    dependencies=[Depends(require_admin)],
)
async def admin_services_monitoring(db: AsyncSession = Depends(get_db)) -> ServiceMonitoringOut:
    """Grouped Services payload that drives the redesigned admin UI."""
    settings = get_settings()

    # --- run independent probes concurrently ----------------------------
    frontend_probe, db_probe, storage_probe, ai_probe, dataset_probe, disk_probe = await asyncio.gather(
        _probe_or_cached("frontend", service_health.CACHE_TTL_FRONTEND, service_health.probe_frontend()),
        _probe_or_cached("database", service_health.CACHE_TTL_DATABASE, service_health.probe_database(db)),
        _probe_or_cached("storage", service_health.CACHE_TTL_STORAGE, service_health.probe_storage()),
        _probe_or_cached("ollama", service_health.CACHE_TTL_OLLAMA, service_health.probe_ollama()),
        _probe_or_cached("dataset", service_health.CACHE_TTL_DATASET, service_health.probe_dataset_processing(db)),
        _probe_or_cached("disk", service_health.CACHE_TTL_DISK, service_health.probe_storage_capacity()),
        return_exceptions=False,
    )

    # Database size (best-effort, non-blocking)
    db_size = await service_health.probe_database_size(db)

    # ------------------------------------------------------------------
    # Build every group
    # ------------------------------------------------------------------

    # ---- Core Platform ----------------------------------------------
    backend_probe = service_health.ProbeResult(
        status="healthy",
        detail=f"{settings.app_name} · {settings.app_env}",
        data={
            "app_name": settings.app_name,
            "app_env": settings.app_env,
            "version": "0.1.0",
        },
    )
    pool_probe = service_health.probe_db_pool()
    worker_info = service_health.probe_worker_count()

    frontend_item = _item(
        key="frontend_web",
        name="Frontend Web Application",
        kind="service",
        status=frontend_probe.status,
        criticality="critical",
        description="Serves the Urban Intelligence web interface to users.",
        probe=frontend_probe,
        dependencies=["backend_api"],
        endpoint_label=os.environ.get("FRONTEND_INTERNAL_URL") or "http://frontend:3000",
        details={
            "container": "davangere_frontend",
            "runtime": "node 22 + serve",
            "build_target": "production",
        },
    )
    backend_item = _item(
        key="backend_api",
        name="Backend API",
        kind="service",
        status="healthy",
        criticality="critical",
        description="Provides authentication, datasets, GIS tools, AI integration, workflows, and all application APIs.",
        probe=backend_probe,
        dependencies=["postgres_postgis", "object_storage", "ai_engine"],
        primary_metric={"label": "Version", "value": "0.1.0"},
        details={
            **backend_probe.data,
            "endpoints": ["/api/health", "/api/ready"],
        },
    )
    database_item = _item(
        key="postgres_postgis",
        name="PostgreSQL / PostGIS",
        kind="service",
        status=db_probe.status,
        criticality="critical",
        description="Stores application data and provides spatial database capabilities.",
        probe=db_probe,
        dependencies=[],
        endpoint_label="postgresql+asyncpg",
        primary_metric=(
            {"label": "Database size", "value": _format_bytes(db_size.get("database_size_bytes"))}
            if db_size.get("database_size_bytes") is not None
            else None
        ),
        details={
            "postgis_version": db_probe.data.get("postgis_version", ""),
            "postgis_short": db_probe.data.get("postgis_short", ""),
            **db_size,
        },
    )

    core_platform = ServiceMonitoringGroup(
        id="core_platform",
        label="Core Platform",
        description="The three services the application cannot run without.",
        status=_group_status([frontend_item, backend_item, database_item]),
        item_count=3,
        items=[frontend_item, backend_item, database_item],
    )

    # ---- Data and Storage -------------------------------------------
    storage_item = _item(
        key="object_storage",
        name="Object Storage (MinIO)",
        kind="service",
        status=storage_probe.status,
        criticality="high",
        description="Stores uploaded datasets, raster previews, OBJ textures, photos, and generated outputs.",
        probe=storage_probe,
        dependencies=[],
        endpoint_label=storage_probe.data.get("endpoint_label", "minio"),
        primary_metric={"label": "Objects", "value": storage_probe.detail or "—"},
        details={
            "bucket": storage_probe.data.get("bucket"),
        },
    )
    dataset_item = _item(
        key="dataset_processing",
        name="Dataset Processing",
        kind="service",
        status=dataset_probe.status,
        criticality="high",
        description="Processes uploaded GIS, raster, LiDAR, 3D, and image datasets through the ingestion pipeline.",
        probe=dataset_probe,
        dependencies=["postgres_postgis", "object_storage"],
        primary_metric=_dataset_primary_metric(dataset_probe),
        details=dataset_probe.data,
    )
    capacity_item = _item(
        key="storage_capacity",
        name="Storage Capacity",
        kind="service",
        status=disk_probe.status,
        criticality="medium",
        description="Tracks available storage space on the monitored filesystem path.",
        probe=disk_probe,
        dependencies=[],
        primary_metric={
            "label": "Used",
            "value": f"{disk_probe.data.get('used_percent', 0)}%",
        },
        details={
            "monitored_path": disk_probe.data.get("path", "/data"),
            "total_bytes": disk_probe.data.get("total_bytes"),
            "used_bytes": disk_probe.data.get("used_bytes"),
            "free_bytes": disk_probe.data.get("free_bytes"),
            "warning_threshold_percent": 80,
            "critical_threshold_percent": 95,
        },
    )

    data_storage = ServiceMonitoringGroup(
        id="data_and_storage",
        label="Data and Storage",
        description="Object storage, dataset processing pipeline, and on-disk capacity.",
        status=_group_status([storage_item, dataset_item, capacity_item]),
        item_count=3,
        items=[storage_item, dataset_item, capacity_item],
    )

    # ---- Intelligence and Analysis ----------------------------------
    ai_item = _item(
        key="ai_engine",
        name="AI Engine (Ollama)",
        kind="service",
        status=ai_probe.status,
        criticality="high",
        description="Provides language-model and embedding capabilities used by AI-assisted workflows.",
        probe=ai_probe,
        dependencies=[],
        endpoint_label=ai_probe.data.get("endpoint_label", settings.ollama_base_url),
        primary_metric={"label": "Chat model", "value": settings.ollama_model},
        details={
            "configured_chat_model": settings.ollama_model,
            "configured_embed_model": settings.ollama_embed_model,
            "chat_model_available": ai_probe.data.get("chat_model_available"),
            "embed_model_available": ai_probe.data.get("embed_model_available"),
            "available_models": ai_probe.data.get("available_models", []),
        },
    )

    # Capability rows under the AI engine and processing items
    cap_map = service_health.capability_summary()

    def _capability_items(parent_key: str) -> list[ServiceMonitoringItem]:
        bucket = cap_map.get(parent_key)
        if not bucket:
            return []
        items: list[ServiceMonitoringItem] = []
        for cap in bucket["available"]:
            items.append(
                ServiceMonitoringItem(
                    key=cap["key"],
                    name=cap["label"],
                    kind="capability",
                    status="healthy",
                    criticality="low",
                    description=f"Required library installed and importable.",
                    parent_key=parent_key,
                    details={"required": cap["required"]},
                )
            )
        for cap in bucket["missing"]:
            required = cap["required"]
            items.append(
                ServiceMonitoringItem(
                    key=cap["key"],
                    name=cap["label"],
                    kind="capability",
                    status="offline" if required else "degraded",
                    criticality="low",
                    description=(
                        "Required library is missing from the backend image."
                        if required
                        else "Optional library is missing — some formats/features unavailable."
                    ),
                    parent_key=parent_key,
                    details={"required": required},
                )
            )
        return items

    # Children of AI engine (none defined yet — placeholder for embedding
    # and grounded-completion rows)
    ai_children: list[ServiceMonitoringItem] = [
        ServiceMonitoringItem(
            key="ai_chat_grounded",
            name="AI Chat and Grounded Completion",
            kind="capability",
            status="healthy" if ai_probe.status == "healthy" else "degraded",
            criticality="low",
            description="Generates answers that cite only the supplied database context.",
            parent_key="ai_engine",
        ),
        ServiceMonitoringItem(
            key="ai_embeddings",
            name="Embedding Generation",
            kind="capability",
            status="healthy" if ai_probe.data.get("embed_model_available") else "degraded",
            criticality="low",
            description="Embeds category names and survey text using the local embedding model.",
            parent_key="ai_engine",
        ),
        ServiceMonitoringItem(
            key="ai_classification_fallback",
            name="Classification Fallback",
            kind="capability",
            status="healthy" if ai_probe.status in ("healthy", "degraded") else "offline",
            criticality="low",
            description="Used when deterministic matching fails for an unseen category name.",
            parent_key="ai_engine",
        ),
        ServiceMonitoringItem(
            key="ai_explanation",
            name="AI Explanation",
            kind="capability",
            status="healthy" if ai_probe.status == "healthy" else "degraded",
            criticality="low",
            description="Produces Markdown explanations of analytics results.",
            parent_key="ai_engine",
        ),
        ServiceMonitoringItem(
            key="ai_urban_planning",
            name="Urban Planning Solution",
            kind="capability",
            status="healthy" if ai_probe.status == "healthy" else "degraded",
            criticality="low",
            description="Generates urban-planning solution narratives from analytics scope.",
            parent_key="ai_engine",
        ),
        ServiceMonitoringItem(
            key="ai_road_inspection",
            name="Road Inspection Analysis",
            kind="capability",
            status="healthy" if ai_probe.status == "healthy" else "degraded",
            criticality="low",
            description="Summarizes road-inspection findings for the commissioner view.",
            parent_key="ai_engine",
        ),
    ]

    # Spatial audit + manhole recommendation rows
    spatial_audit_item = ServiceMonitoringItem(
        key="spatial_audit",
        name="Spatial Audit",
        kind="capability",
        status="healthy",
        criticality="medium",
        description="Deterministic PostGIS rules run automatically after GIS datasets become READY.",
        parent_key="backend_api",
    )
    manhole_cap_items = _capability_items("manhole_recommendation")
    manhole_recommendation_item = ServiceMonitoringItem(
        key="manhole_recommendation",
        name="Manhole Recommendation",
        kind="capability",
        status=(
            "healthy" if all(c.status == "healthy" for c in manhole_cap_items)
            else "degraded" if any(c.status == "healthy" for c in manhole_cap_items)
            else "offline"
        ) if manhole_cap_items else "degraded",
        criticality="medium",
        description="Uses NetworkX and PostGIS to recommend manhole and pipe-routing solutions.",
        parent_key="backend_api",
    )
    classification_item = ServiceMonitoringItem(
        key="classification",
        name="Classification and Embeddings",
        kind="capability",
        status="healthy",
        criticality="medium",
        description="Resolves new category names to canonical classes via deterministic rules + embedding similarity.",
        parent_key="backend_api",
    )

    intelligence_items: list[ServiceMonitoringItem] = [ai_item]
    intelligence_items.extend(ai_children)
    intelligence_items.append(spatial_audit_item)
    intelligence_items.append(manhole_recommendation_item)
    intelligence_items.extend(manhole_cap_items)
    intelligence_items.append(classification_item)

    intelligence = ServiceMonitoringGroup(
        id="intelligence_and_analysis",
        label="Intelligence and Analysis",
        description="AI engine plus the deterministic spatial and graph capabilities that run inside the backend process.",
        status=_group_status(intelligence_items),
        item_count=len(intelligence_items),
        items=intelligence_items,
    )

    # ---- GIS and File Processing -------------------------------------
    gis_items: list[ServiceMonitoringItem] = []
    for parent in ("dataset_processing", "report_generation"):
        for cap in cap_map.get(parent, {}).get("available", []):
            gis_items.append(
                ServiceMonitoringItem(
                    key=cap["key"],
                    name=cap["label"],
                    kind="capability",
                    status="healthy",
                    criticality="low",
                    description="Required library installed and importable.",
                    parent_key=parent,
                )
            )
        for cap in cap_map.get(parent, {}).get("missing", []):
            required = cap["required"]
            gis_items.append(
                ServiceMonitoringItem(
                    key=cap["key"],
                    name=cap["label"],
                    kind="capability",
                    status="offline" if required else "degraded",
                    criticality="low",
                    description=(
                        "Required library is missing from the backend image."
                        if required
                        else "Optional library is missing — this format/feature is unavailable."
                    ),
                    parent_key=parent,
                    details={"required": required},
                )
            )

    # Raster tile rendering is a dedicated service-level capability
    gis_items.append(
        ServiceMonitoringItem(
            key="raster_tile_rendering",
            name="Raster Tile Rendering",
            kind="capability",
            status="healthy",
            criticality="medium",
            description="Renders zoom-aware PNG tiles from uploaded GeoTIFFs.",
            parent_key="dataset_processing",
        )
    )
    gis_items.append(
        ServiceMonitoringItem(
            key="crs_transformation",
            name="CRS Transformation",
            kind="capability",
            status="healthy",
            criticality="low",
            description="PyProj-based reprojection between uploaded source CRS and the application SRID (EPSG:4326).",
            parent_key="dataset_processing",
        )
    )
    gis_items.append(
        ServiceMonitoringItem(
            key="visualization_manifests",
            name="Visualization Manifest Generation",
            kind="capability",
            status="healthy",
            criticality="low",
            description="Builds universal dashboard payloads from any vector dataset.",
            parent_key="report_generation",
        )
    )

    gis_group = ServiceMonitoringGroup(
        id="gis_and_file_processing",
        label="GIS and File Processing",
        description="File formats and processing libraries available to the ingestion pipeline.",
        status=_group_status(gis_items) if gis_items else "unknown",
        item_count=len(gis_items),
        items=gis_items,
    )

    # ---- Application Services ---------------------------------------
    auth_status = "healthy"
    notif_status = "healthy"
    app_items = [
        ServiceMonitoringItem(
            key="authentication",
            name="Authentication",
            kind="subsystem",
            status=auth_status,
            criticality="critical",
            description="Internal JWT-based user authentication with httpOnly cookies and bcrypt password hashing.",
            parent_key="backend_api",
            details={
                "rate_limit_max": settings.rate_limit_max,
                "rate_limit_window_seconds": settings.rate_limit_window_seconds,
                "csrf_protection": True,
                "failed_login_tracking": False,
            },
        ),
        ServiceMonitoringItem(
            key="user_management",
            name="User Management",
            kind="subsystem",
            status="healthy",
            criticality="medium",
            description="Admin-controlled user and role management backed by the database.",
            parent_key="backend_api",
        ),
        ServiceMonitoringItem(
            key="notifications",
            name="In-app Notifications",
            kind="subsystem",
            status=notif_status,
            criticality="low",
            description="Database-backed in-app notifications. No SMTP, SMS, or push delivery is configured.",
            parent_key="backend_api",
            details={"delivery": ["db"], "absent": ["smtp", "sms", "push"]},
        ),
        ServiceMonitoringItem(
            key="report_generation",
            name="Report Generation",
            kind="subsystem",
            status="healthy" if any(
                c.key == "report_pdf" and c.status == "healthy" for c in gis_items
            ) else "degraded",
            criticality="low",
            description="PDF, Excel, CSV, and GeoJSON export paths used by the analytics and reporting views.",
            parent_key="backend_api",
        ),
        ServiceMonitoringItem(
            key="activity_audit",
            name="Activity and Audit Logging",
            kind="subsystem",
            status="healthy",
            criticality="medium",
            description="Database-backed audit log of dataset, workflow, and admin actions.",
            parent_key="backend_api",
        ),
        ServiceMonitoringItem(
            key="point_verification",
            name="Point Verification",
            kind="subsystem",
            status="healthy",
            criticality="medium",
            description="Field-engineer workflow for confirming or disputing AI-detected features.",
            parent_key="backend_api",
        ),
        ServiceMonitoringItem(
            key="remediation",
            name="Remediation",
            kind="subsystem",
            status="healthy",
            criticality="medium",
            description="Field-remediation evidence collection and review queue.",
            parent_key="backend_api",
        ),
        ServiceMonitoringItem(
            key="workflow",
            name="Workflow and Task Processing",
            kind="subsystem",
            status="healthy",
            criticality="medium",
            description="Task creation, assignment, AEE review, and Commissioner acceptance.",
            parent_key="backend_api",
        ),
        ServiceMonitoringItem(
            key="analytics",
            name="Analytics",
            kind="subsystem",
            status="healthy",
            criticality="low",
            description="Ward, severity, category, and readiness analytics over the verified scope.",
            parent_key="backend_api",
        ),
        ServiceMonitoringItem(
            key="coordinate_search",
            name="Coordinate Search",
            kind="subsystem",
            status="healthy",
            criticality="low",
            description="Reverse-geocodes lat/lon lookups to nearby features.",
            parent_key="backend_api",
        ),
        ServiceMonitoringItem(
            key="placemark_management",
            name="Placemark Management",
            kind="subsystem",
            status="healthy",
            criticality="low",
            description="User-created map markers with optional note and category.",
            parent_key="backend_api",
        ),
    ]
    app_group = ServiceMonitoringGroup(
        id="application_services",
        label="Application Services",
        description="Application-level capabilities backed by the database and the FastAPI layer.",
        status=_group_status(app_items),
        item_count=len(app_items),
        items=app_items,
    )

    # ---- External Dependencies --------------------------------------
    cadastral_url = service_inventory.vite_cadastral_url()
    google_configured = service_inventory.vite_google_maps_key() is not None
    davangere_available = service_inventory.davangere_census_url() is not None

    external_items = [
        ServiceMonitoringItem(
            key="external_cadastral",
            name="External Cadastral Tile Service",
            kind="external_dependency",
            status="healthy" if cadastral_url else "not_configured",
            criticality="low",
            description="Optional overlay source for the official cadastral map. Configured at frontend build time.",
            details={"configured_url": _scrub_query(cadastral_url) if cadastral_url else None},
        ),
        ServiceMonitoringItem(
            key="external_google_maps",
            name="Google Maps / Street View",
            kind="external_dependency",
            status="healthy" if google_configured else "not_configured",
            criticality="low",
            description="Optional Google Maps and Street View panoramas. Configured at frontend build time.",
            details={"configured": google_configured},
        ),
        ServiceMonitoringItem(
            key="external_davangere_census",
            name="Davangere Corporation Census Source",
            kind="external_dependency",
            status="healthy" if davangere_available else "not_configured",
            criticality="low",
            description="Optional external population source used by analytics. Never marks the platform Critical.",
            details={"fallback_available": True},
        ),
    ]
    external_group = ServiceMonitoringGroup(
        id="external_dependencies",
        label="External Dependencies",
        description="Optional third-party services that are only used when configured.",
        status=_group_status(external_items),
        item_count=len(external_items),
        items=external_items,
    )

    # ---- Runtime and Persistent Resources ----------------------------
    resource_items = [
        ServiceMonitoringItem(
            key="volume_postgres",
            name="PostgreSQL Persistent Volume",
            kind="resource",
            status="healthy",
            criticality="high",
            description="postgis_data named volume holding all application, spatial, workflow, and user data.",
            details={"backup": "not configured"},
        ),
        ServiceMonitoringItem(
            key="volume_minio",
            name="MinIO Persistent Volume",
            kind="resource",
            status="healthy",
            criticality="high",
            description="minio_data named volume holding datasets, photos, textures, and generated files.",
            details={"backup": "not configured"},
        ),
        ServiceMonitoringItem(
            key="volume_ollama",
            name="Ollama Model Volume",
            kind="resource",
            status="healthy",
            criticality="medium",
            description="ollama_data named volume holding the downloaded language and embedding models.",
            details={"backup": "not configured"},
        ),
        ServiceMonitoringItem(
            key="db_connection_pool",
            name="Database Connection Pool",
            kind="resource",
            status=pool_probe.status,
            criticality="medium",
            description="Async SQLAlchemy pool used by the FastAPI workers.",
            probe=pool_probe,
        ),
        ServiceMonitoringItem(
            key="backend_workers",
            name="Backend Worker Processes",
            kind="resource",
            status="healthy",
            criticality="medium",
            description="Uvicorn worker count; background work runs in-process via FastAPI BackgroundTasks.",
            details=worker_info,
        ),
        ServiceMonitoringItem(
            key="frontend_build",
            name="Frontend Build Information",
            kind="resource",
            status="healthy",
            criticality="low",
            description="Container runs the production build served by `serve` on port 3000.",
            details={
                "runtime": "node 22 + serve",
                "build_target": "production",
                "container": "davangere_frontend",
            },
        ),
        ServiceMonitoringItem(
            key="application_environment",
            name="Application Environment",
            kind="resource",
            status="healthy",
            criticality="low",
            description=f"Currently running in {settings.app_env}.",
            details={"app_env": settings.app_env},
        ),
        capacity_item,  # keep storage capacity in the resources group too
    ]
    resource_group = ServiceMonitoringGroup(
        id="runtime_and_persistent_resources",
        label="Runtime and Persistent Resources",
        description="Named volumes, connection pool, worker count, and frontend build metadata.",
        status=_group_status(resource_items),
        item_count=len(resource_items),
        items=resource_items,
    )

    # ---- Recovery and Infrastructure Readiness ----------------------
    recovery_items = [
        ServiceMonitoringItem(
            key="backup_system",
            name="Backup System",
            kind="configuration",
            status="not_configured",
            criticality="medium",
            description="No automated backup system is configured for PostgreSQL, MinIO, or Ollama data.",
            details={"warning": "Recovery protection is not configured."},
        ),
        ServiceMonitoringItem(
            key="reverse_proxy",
            name="Reverse Proxy",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="Frontend and backend are currently exposed directly through host ports (development).",
        ),
        ServiceMonitoringItem(
            key="dedicated_worker",
            name="Dedicated Background Worker",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="Dataset processing runs inside FastAPI background tasks (no separate worker container).",
        ),
        ServiceMonitoringItem(
            key="failed_login_tracking",
            name="Failed-Login Tracking",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="Authentication is rate-limited, but failed-login history is not currently persisted.",
        ),
        ServiceMonitoringItem(
            key="host_cpu_monitoring",
            name="Host CPU Monitoring",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="No host CPU metrics are collected; this deployment ships no psutil or agent.",
        ),
        ServiceMonitoringItem(
            key="host_ram_monitoring",
            name="Host RAM Monitoring",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="No host RAM metrics are collected; the storage path is the only resource probe.",
        ),
        ServiceMonitoringItem(
            key="host_gpu_monitoring",
            name="Host GPU Monitoring",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="GPU metrics are not collected; Ollama uses CPU by default in this image.",
        ),
        ServiceMonitoringItem(
            key="external_monitoring",
            name="External Monitoring Platform",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="Prometheus, Grafana, Sentry, and OpenTelemetry are not configured.",
        ),
    ]
    recovery_group = ServiceMonitoringGroup(
        id="recovery_and_infrastructure_readiness",
        label="Recovery and Infrastructure Readiness",
        description="Backup, reverse proxy, and host-monitoring capabilities — only present when explicitly configured.",
        status="not_configured" if all(i.status == "not_configured" for i in recovery_items) else "partial",
        item_count=len(recovery_items),
        items=recovery_items,
    )

    # ---- Observability ----------------------------------------------
    observability_items = [
        ServiceMonitoringItem(
            key="backend_logs",
            name="Backend stdout logs",
            kind="configuration",
            status="partial",
            criticality="low",
            description="Backend logs are written to stdout and captured by Docker.",
        ),
        ServiceMonitoringItem(
            key="docker_logs",
            name="Docker container logs",
            kind="configuration",
            status="healthy",
            criticality="low",
            description="All five compose services emit container logs accessible via `docker compose logs`.",
        ),
        ServiceMonitoringItem(
            key="frontend_error_reporting",
            name="Frontend error reporting",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="No Sentry, LogRocket, or other client error-reporting SDK is configured.",
        ),
        ServiceMonitoringItem(
            key="structured_request_ids",
            name="Structured request IDs",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="Requests are not currently tagged with structured request IDs.",
        ),
        ServiceMonitoringItem(
            key="metrics_endpoint",
            name="Metrics endpoint",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="No /metrics endpoint is exposed for Prometheus scraping.",
        ),
        ServiceMonitoringItem(
            key="prometheus",
            name="Prometheus",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="Prometheus is not part of this deployment.",
        ),
        ServiceMonitoringItem(
            key="grafana",
            name="Grafana",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="Grafana is not part of this deployment.",
        ),
        ServiceMonitoringItem(
            key="sentry",
            name="Sentry",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="Sentry is not part of this deployment.",
        ),
        ServiceMonitoringItem(
            key="opentelemetry",
            name="OpenTelemetry",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="OpenTelemetry instrumentation is not configured.",
        ),
        ServiceMonitoringItem(
            key="distributed_tracing",
            name="Distributed tracing",
            kind="configuration",
            status="not_configured",
            criticality="low",
            description="No distributed-tracing backend is configured.",
        ),
    ]
    observability_group = ServiceMonitoringGroup(
        id="observability",
        label="Observability",
        description="Backend logs, Docker logs, and external observability platforms.",
        status="partial" if any(i.status == "healthy" for i in observability_items) else "not_configured",
        item_count=len(observability_items),
        items=observability_items,
    )

    groups = [
        core_platform,
        data_storage,
        intelligence,
        gis_group,
        app_group,
        external_group,
        resource_group,
        recovery_group,
        observability_group,
    ]

    # ---- summary + index --------------------------------------------
    summary = ServiceMonitoringSummary()
    item_index: dict[str, str] = {}
    for g in groups:
        for item in g.items:
            item_index[item.key] = g.id
            setattr(summary, item.status, getattr(summary, item.status) + 1)

    overall = _overall_status(summary)
    overall_detail: str | None = None
    if not service_inventory.vite_cadastral_url() and not service_inventory.vite_google_maps_key():
        # Don't downgrade overall status for missing external deps; keep
        # the warning copy in the recovery section only.
        pass
    if any(i.key == "backup_system" for i in recovery_items) and any(
        i.key == "backup_system" and i.status == "not_configured" for i in recovery_items
    ):
        overall_detail = "Recovery protection is not configured."

    return ServiceMonitoringOut(
        generated_at=datetime.now(timezone.utc).isoformat(),
        overall_status=overall,
        overall_detail=overall_detail,
        summary=summary,
        groups=groups,
        item_index=item_index,
    )


# ---------------------------------------------------------------------------
# Backwards-compatible /services alias
# ---------------------------------------------------------------------------
# Older callers that still hit ``/services`` get the new grouped payload —
# the legacy flat payload is now at ``/services/legacy``. We re-use the same
# handler so admins see the new UI everywhere.


# ---------------------------------------------------------------------------
# Other existing admin endpoints (datasets / workflows / activity)
# ---------------------------------------------------------------------------


@router.get("/datasets", response_model=AdminDatasetsOut, dependencies=[Depends(require_admin)])
async def admin_datasets(db: AsyncSession = Depends(get_db)) -> AdminDatasetsOut:
    rows = (await db.execute(select(Dataset.status, func.count()).group_by(Dataset.status))).all()
    counts = {s.value: 0 for s in DatasetStatus}
    for status, count in rows:
        counts[status.value] = count

    failures = (
        await db.execute(
            select(Dataset)
            .where(Dataset.status == DatasetStatus.FAILED)
            .order_by(Dataset.updated_at.desc())
            .limit(10)
        )
    ).scalars().all()

    return AdminDatasetsOut(
        counts=DatasetStatusCounts(**counts),
        recent_failures=[
            FailedDatasetOut(
                id=d.id, name=d.name, processing_error=d.processing_error, updated_at=d.updated_at
            )
            for d in failures
        ],
    )


@router.get("/workflows", response_model=AdminWorkflowsOut, dependencies=[Depends(require_admin)])
async def admin_workflows(db: AsyncSession = Depends(get_db)) -> AdminWorkflowsOut:
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(hours=STUCK_WORKFLOW_HOURS)
    not_done = PointVerification.workflow_status != RemediationWorkflowStatus.COMMISSIONER_ACCEPTED

    open_count = (
        await db.execute(select(func.count()).select_from(PointVerification).where(not_done))
    ).scalar_one()

    stuck_rows = (
        await db.execute(
            select(PointVerification)
            .where(not_done, PointVerification.updated_at < cutoff)
            .order_by(PointVerification.updated_at.asc())
            .limit(20)
        )
    ).scalars().all()

    stuck = [
        StuckWorkflowOut(
            id=row.id,
            feature_id=row.feature_id,
            workflow_status=row.workflow_status.value,
            updated_at=row.updated_at,
            hours_stuck=round((now - row.updated_at).total_seconds() / 3600, 1),
        )
        for row in stuck_rows
    ]

    blocked_reviews = (
        await db.execute(select(func.count()).select_from(ReviewItem).where(ReviewItem.status == ReviewStatus.BLOCKED))
    ).scalar_one()

    p0_open = (
        await db.execute(
            select(func.count())
            .select_from(ReviewItem)
            .where(
                ReviewItem.priority == int(ReviewPriority.P0),
                ReviewItem.status.in_(_OPEN_REVIEW_STATES),
            )
        )
    ).scalar_one()

    return AdminWorkflowsOut(
        open_point_verifications=open_count,
        stuck_point_verifications=stuck,
        blocked_review_items=blocked_reviews,
        open_p0_review_items=p0_open,
    )


def _device_category(ua: str | None) -> str:
    """Classify a User-Agent string as desktop/mobile/tablet/unknown.

    Order matters: tablet checks must run before the generic mobile check,
    since iPadOS/Android tablets are otherwise indistinguishable from
    phones by a naive "Mobile" substring match.
    """
    if not ua:
        return "unknown"
    if "iPad" in ua or ("Android" in ua and "Mobile" not in ua) or "Tablet" in ua:
        return "tablet"
    if any(tok in ua for tok in ("Mobi", "iPhone", "iPod", "BlackBerry", "IEMobile", "Opera Mini")):
        return "mobile"
    return "desktop"


def _orientation(width: int | None, height: int | None) -> str | None:
    if not width or not height:
        return None
    return "landscape" if width >= height else "portrait"


def _entry(row: ActivityLog) -> ActivityEntryOut:
    payload = row.payload if isinstance(row.payload, dict) else {}
    return ActivityEntryOut(
        id=row.id,
        actor_id=row.actor_id,
        actor_name=row.actor.name if row.actor else None,
        actor_role=row.actor.role.value if row.actor else None,
        action=row.action.value,
        entity_type=row.entity_type,
        created_at=row.created_at,
        ip_address=payload.get("ip"),
        user_agent=payload.get("user_agent"),
    )


def _session_entry(session: UserSession, user_name: str, user_role: str, cutoff: datetime) -> SessionOut:
    end = session.logout_at or session.last_seen_at
    duration_minutes = max(0.0, round((end - session.login_at).total_seconds() / 60, 1))
    return SessionOut(
        id=session.id,
        user_id=session.user_id,
        user_name=user_name,
        user_role=user_role,
        ip_address=session.ip_address,
        user_agent=session.user_agent,
        device_category=_device_category(session.user_agent),
        screen_width=session.screen_width,
        screen_height=session.screen_height,
        orientation=_orientation(session.screen_width, session.screen_height),
        login_at=session.login_at,
        last_seen_at=session.last_seen_at,
        logout_at=session.logout_at,
        duration_minutes=duration_minutes,
        is_active=session.logout_at is None and session.last_seen_at >= cutoff,
    )


@router.get("/activity", response_model=AdminActivityOut, dependencies=[Depends(require_admin)])
async def admin_activity(db: AsyncSession = Depends(get_db)) -> AdminActivityOut:
    # Window for "active users right now". A session counts as active while
    # it has no logout and its last heartbeat fell inside this window. Kept
    # short on purpose so the count is meaningful in real time.
    active_window_minutes = 15
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=active_window_minutes)

    # The System Administrator is the one watching this dashboard, not a
    # subject of it — every list and count here excludes the admin role.
    not_admin = User.role != UserRole.ADMIN

    total_users = (
        await db.execute(
            select(func.count()).select_from(User).where(User.is_active.is_(True), not_admin)
        )
    ).scalar_one()

    role_rows = (
        await db.execute(
            select(User.role, func.count())
            .where(User.is_active.is_(True), not_admin)
            .group_by(User.role)
        )
    ).all()

    active_session_rows = (
        await db.execute(
            select(UserSession, User.name, User.role)
            .join(User, User.id == UserSession.user_id)
            .where(UserSession.logout_at.is_(None), UserSession.last_seen_at >= cutoff, not_admin)
            .order_by(UserSession.last_seen_at.desc())
        )
    ).all()
    active_users = len({row[0].user_id for row in active_session_rows})

    recent_session_rows = (
        await db.execute(
            select(UserSession, User.name, User.role)
            .join(User, User.id == UserSession.user_id)
            .where(not_admin)
            .order_by(UserSession.login_at.desc())
            .limit(15)
        )
    ).all()

    recent_logins = (
        await db.execute(
            select(ActivityLog)
            .join(User, User.id == ActivityLog.actor_id)
            .where(ActivityLog.action == ActivityAction.LOGIN, not_admin)
            .order_by(ActivityLog.created_at.desc())
            .limit(10)
        )
    ).scalars().all()

    return AdminActivityOut(
        total_users=total_users,
        active_users=active_users,
        active_users_window_minutes=active_window_minutes,
        users_by_role=[UserRoleCount(role=role.value, count=count) for role, count in role_rows],
        recent_logins=[_entry(r) for r in recent_logins],
        active_sessions=[
            _session_entry(session, name, role.value, cutoff)
            for session, name, role in active_session_rows
        ],
        recent_sessions=[
            _session_entry(session, name, role.value, cutoff)
            for session, name, role in recent_session_rows
        ],
    )


@router.get(
    "/users/{user_id}/activity",
    response_model=AdminUserActivityOut,
    dependencies=[Depends(require_admin)],
)
async def admin_user_activity(user_id: uuid.UUID, db: AsyncSession = Depends(get_db)) -> AdminUserActivityOut:
    """Full tracking detail for a single user — every session and logged
    action, plus summary stats. Backs the right-hand drawer opened by
    clicking a user anywhere in Admin → Users & Activity.

    The System Administrator is excluded: this feature tracks other
    accounts, not the admin viewing the dashboard.
    """
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None or user.role == UserRole.ADMIN:
        raise HTTPException(status_code=404, detail="User not found")

    active_window_minutes = 15
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=active_window_minutes)
    # LOGIN/LOGOUT are self-referential (entity_type "user") and already
    # fully covered by the session history below — the event log below
    # should only show what this user actually *did*, not their comings
    # and goings.
    non_session_actions = ActivityAction.LOGIN, ActivityAction.LOGOUT

    sessions = (
        await db.execute(
            select(UserSession)
            .where(UserSession.user_id == user_id)
            .order_by(UserSession.login_at.desc())
            .limit(100)
        )
    ).scalars().all()

    events = (
        await db.execute(
            select(ActivityLog)
            .where(ActivityLog.actor_id == user_id, ActivityLog.action.notin_(non_session_actions))
            .order_by(ActivityLog.created_at.desc())
            .limit(100)
        )
    ).scalars().all()

    total_sessions = (
        await db.execute(
            select(func.count()).select_from(UserSession).where(UserSession.user_id == user_id)
        )
    ).scalar_one()

    total_events = (
        await db.execute(
            select(func.count())
            .select_from(ActivityLog)
            .where(ActivityLog.actor_id == user_id, ActivityLog.action.notin_(non_session_actions))
        )
    ).scalar_one()

    total_logins = (
        await db.execute(
            select(func.count())
            .select_from(ActivityLog)
            .where(ActivityLog.actor_id == user_id, ActivityLog.action == ActivityAction.LOGIN)
        )
    ).scalar_one()

    is_online = any(s.logout_at is None and s.last_seen_at >= cutoff for s in sessions)
    current_ip = sessions[0].ip_address if sessions and is_online else None
    current_device = sessions[0].user_agent if sessions and is_online else None
    current_location = await _approximate_location(current_ip)
    current_screen_width = sessions[0].screen_width if sessions and is_online else None
    current_screen_height = sessions[0].screen_height if sessions and is_online else None

    return AdminUserActivityOut(
        user=UserSummaryOut(
            id=user.id,
            name=user.name,
            email=user.email,
            role=user.role.value,
            is_active=user.is_active,
            created_at=user.created_at,
        ),
        stats=UserActivityStatsOut(
            total_sessions=total_sessions,
            total_events=total_events,
            total_logins=total_logins,
            is_online=is_online,
            current_ip=current_ip,
            current_device=current_device,
            current_location=current_location,
            current_device_category=_device_category(current_device) if current_device else None,
            current_screen_width=current_screen_width,
            current_screen_height=current_screen_height,
            current_orientation=_orientation(current_screen_width, current_screen_height),
        ),
        sessions=[_session_entry(s, user.name, user.role.value, cutoff) for s in sessions],
        events=[_entry(e) for e in events],
    )


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

_GEO_LOOKUP_TIMEOUT = httpx.Timeout(2.5)
_geo_location_cache: dict[str, str | None] = {}


def _is_internal_ip(ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return True
    return addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved or addr.is_unspecified


async def _approximate_location(ip: str | None) -> str | None:
    """Best-effort "City, Region, Country" label for a public IP address,
    via a free reverse-geocoding lookup. Internal/private addresses
    (docker network, localhost, LAN) never leave the box and are labeled
    directly. Results are cached per-IP for the life of the process.

    Never raises — an unreachable or rate-limited lookup service just
    means the field comes back empty; it must never fail the drawer
    this backs.
    """
    if not ip:
        return None
    if ip in _geo_location_cache:
        return _geo_location_cache[ip]
    if _is_internal_ip(ip):
        _geo_location_cache[ip] = "Internal network"
        return _geo_location_cache[ip]

    label: str | None = None
    try:
        async with httpx.AsyncClient(timeout=_GEO_LOOKUP_TIMEOUT) as client:
            resp = await client.get(f"https://ipapi.co/{ip}/json/")
        if resp.status_code == 200:
            data = resp.json()
            if not data.get("error"):
                parts = [p for p in (data.get("city"), data.get("region"), data.get("country_name")) if p]
                label = ", ".join(parts) or None
    except Exception:  # noqa: BLE001 - any network/parsing failure just yields "unknown"
        label = None

    _geo_location_cache[ip] = label
    return label


def _format_bytes(n: int | None) -> str:
    if n is None:
        return "—"
    if n < 1024:
        return f"{n} B"
    for unit in ("KB", "MB", "GB", "TB"):
        n /= 1024
        if n < 1024:
            return f"{n:.1f} {unit}"
    return f"{n:.1f} PB"


def _scrub_query(url: str) -> str:
    """Mask query-string parameters for display."""
    if "?" not in url:
        return url
    base, query = url.split("?", 1)
    parts = [p for p in query.split("&") if p]
    if not parts:
        return base
    return f"{base}?<{len(parts)} param(s)>"


def _dataset_primary_metric(probe: service_health.ProbeResult) -> dict[str, str] | None:
    counts = (probe.data or {}).get("counts") or {}
    if not counts:
        return None
    failed = int(counts.get("failed", 0))
    processing = int(counts.get("processing", 0))
    ready = int(counts.get("ready", 0))
    if failed:
        return {"label": "Recent failures", "value": str(failed)}
    if processing:
        return {"label": "Processing", "value": str(processing)}
    return {"label": "Ready", "value": str(ready)}


# ---------------------------------------------------------------------------
# /security endpoint (grouped Security payload for the Admin UI)
# ---------------------------------------------------------------------------


@router.get(
    "/security",
    response_model=SecurityMonitoringOut,
    dependencies=[Depends(require_admin)],
)
async def admin_security_monitoring(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> SecurityMonitoringOut:
    """Grouped Security payload that drives the Admin Security section.

    Builds a sanitized, schema-validated inventory of every security
    control, risk finding, and group status using static configuration,
    database-derived counts, and lightweight non-destructive runtime
    probes (CORS pre-flight, header inspection, admin auth check,
    OpenAPI exposure, JWT secret length). The implementation never
    returns secret values, never modifies persisted state, and never
    performs destructive operations.
    """
    return await security_monitoring.build_security_monitoring(db=db, request=request)
