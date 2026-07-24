"""
Live health probes for the Services monitoring section.

Every probe returns a ``ProbeResult`` carrying both the new
``service_monitoring`` status string AND the raw diagnostic data the
detail drawer needs. Probes are:

* **Asynchronous** — they all run inside the FastAPI event loop and use
  ``asyncio.wait_for`` for a hard upper-bound timeout so a hung remote
  never blocks the response.
* **Bounded** — every external call is wrapped in a try/except that
  swallows network/timeout errors and converts them to a probe with
  status="offline" or "degraded" plus a sanitized message.
* **Cached** — the orchestrator (``build_groups``) calls each probe at
  most once per request. The per-endpoint request-level cache in
  ``monitoring_cache`` reuses results across admin refreshes for the
  TTL specified in the spec.

The frontend / API never see raw stack traces or credentials. The
``sanitize_detail()`` helper strips query-string secrets and truncates
long error messages to a single line.
"""
from __future__ import annotations

import asyncio
import logging
import os
import shutil
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import httpx
import ollama
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.models import Dataset, DatasetStatus
from app.services import storage
from app.services.service_inventory import (
    CAPABILITIES,
    detect_capabilities,
)

log = logging.getLogger("davangere.admin.health")

# --- Per-probe timeouts (seconds) -----------------------------------------
# Spec: Frontend 4s, everything else 4-6s, total endpoint budget < 5s.
TIMEOUT_FRONTEND = 4.0
TIMEOUT_BACKEND_INTERNAL = 2.0
TIMEOUT_DATABASE = 3.0
TIMEOUT_STORAGE = 4.0
TIMEOUT_OLLAMA = 4.0
TIMEOUT_EXTERNAL = 5.0
TIMEOUT_STORAGE_DISK = 1.0

# --- Per-probe cache TTLs (seconds) --------------------------------------
# Used by the monitoring_cache below. Independent per probe so that slow
# external services can be probed much less often than the fast local ones.
CACHE_TTL_FRONTEND = 20.0
CACHE_TTL_BACKEND = 10.0
CACHE_TTL_DATABASE = 20.0
CACHE_TTL_STORAGE = 20.0
CACHE_TTL_OLLAMA = 20.0
CACHE_TTL_DATASET = 20.0
CACHE_TTL_DISK = 30.0
CACHE_TTL_EXTERNAL = 300.0  # 5 minutes per spec


# ---------------------------------------------------------------------------
# Probe result + cache
# ---------------------------------------------------------------------------


@dataclass
class ProbeResult:
    status: str  # one of ServiceMonitoringStatus values
    detail: str | None = None
    response_time_ms: float | None = None
    last_checked_at: str | None = None
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "detail": self.detail,
            "response_time_ms": self.response_time_ms,
            "last_checked_at": self.last_checked_at,
            "data": self.data,
        }


@dataclass
class _CacheEntry:
    value: ProbeResult
    expires_at: float


class _MonitoringCache:
    """Tiny in-process TTL cache. Holds at most one entry per key.

    The admin Services page is hit by exactly one user (the operator) at
    most every few seconds, so a process-local dict is more than enough
    and avoids the operational complexity of Redis.
    """

    def __init__(self) -> None:
        self._store: dict[str, _CacheEntry] = {}

    def get(self, key: str) -> ProbeResult | None:
        entry = self._store.get(key)
        if entry is None:
            return None
        if entry.expires_at < time.monotonic():
            self._store.pop(key, None)
            return None
        return entry.value

    def set(self, key: str, value: ProbeResult, ttl: float) -> None:
        self._store[key] = _CacheEntry(value=value, expires_at=time.monotonic() + ttl)

    def clear(self) -> None:
        self._store.clear()


monitoring_cache = _MonitoringCache()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sanitize(value: str | None, *, max_len: int = 240) -> str | None:
    """Strip query-string secrets and bound message size.

    - Removes anything that looks like ``?key=…&token=…`` query strings.
    - Truncates to ``max_len`` so an exception dump never blows out the
      detail panel.
    - Replaces any embedded credential-looking substring with ``***``.
    """
    if value is None:
        return None
    out = value
    # Strip common secret-y query params
    for marker in ("token=", "key=", "apikey=", "api_key=", "password=", "secret="):
        idx = out.lower().find(marker)
        while idx >= 0:
            # Find the end of the value (up to next & or end of string)
            end = out.find("&", idx)
            if end < 0:
                end = len(out)
            out = out[:idx] + f"{marker.rstrip('=')}=***" + out[end:]
            idx = out.lower().find(marker, idx + 1)
    out = out.splitlines()[0] if out else out
    if len(out) > max_len:
        out = out[: max_len - 1] + "…"
    return out


async def _timed(probe: Callable[[], Awaitable[ProbeResult] | ProbeResult], timeout: float) -> ProbeResult:
    start = time.perf_counter()
    try:
        result = await asyncio.wait_for(_maybe_await(probe()), timeout=timeout)
    except asyncio.TimeoutError:
        return ProbeResult(
            status="offline",
            detail=f"Probe timed out after {timeout:.0f}s",
            response_time_ms=round((time.perf_counter() - start) * 1000, 1),
            last_checked_at=_now_iso(),
        )
    except Exception as exc:  # noqa: BLE001
        log.debug("Probe failed", exc_info=True)
        return ProbeResult(
            status="offline",
            detail=_sanitize(str(exc)) or "Probe failed",
            response_time_ms=round((time.perf_counter() - start) * 1000, 1),
            last_checked_at=_now_iso(),
        )
    if result.response_time_ms is None:
        result.response_time_ms = round((time.perf_counter() - start) * 1000, 1)
    if result.last_checked_at is None:
        result.last_checked_at = _now_iso()
    return result


def _maybe_await(value: ProbeResult | Awaitable[ProbeResult]) -> Awaitable[ProbeResult] | ProbeResult:
    return value


# ---------------------------------------------------------------------------
# Frontend
# ---------------------------------------------------------------------------


async def probe_frontend() -> ProbeResult:
    """Lightweight HTTP probe against the frontend container.

    The compose network gives the backend a stable hostname for the
    frontend (``davangere_frontend`` or whatever the operator set). The
    default URL is intentionally the *internal* one so this check works
    from inside the same network.
    """
    base = os.environ.get("FRONTEND_INTERNAL_URL") or "http://frontend:3000"
    url = f"{base.rstrip('/')}/"

    async def _do() -> ProbeResult:
        try:
            async with httpx.AsyncClient(timeout=TIMEOUT_FRONTEND, follow_redirects=False) as client:
                resp = await client.get(url)
        except httpx.HTTPError as exc:
            return ProbeResult(status="offline", detail=_sanitize(str(exc)))

        if resp.status_code >= 500:
            return ProbeResult(
                status="offline",
                detail=f"Frontend returned HTTP {resp.status_code}",
            )
        if resp.status_code >= 400:
            return ProbeResult(
                status="degraded",
                detail=f"Frontend returned HTTP {resp.status_code}",
            )
        # Look for the React app root or the page title as a sanity marker
        body = (resp.text or "")[:1024]
        if "<div id=\"root\"" in body or "davangere" in body.lower():
            return ProbeResult(
                status="healthy",
                detail=f"HTTP {resp.status_code} · React root detected",
                data={"status_code": resp.status_code, "url": base},
            )
        return ProbeResult(
            status="degraded",
            detail=f"HTTP {resp.status_code} but no React root marker found",
            data={"status_code": resp.status_code, "url": base},
        )

    return await _timed(_do, TIMEOUT_FRONTEND)


# ---------------------------------------------------------------------------
# Backend (internal state, no self-HTTP)
# ---------------------------------------------------------------------------


async def probe_backend_internal() -> ProbeResult:
    """Cheap self-probe: respond as long as the event loop is alive.

    We avoid issuing a self-HTTP request — that would couple this probe
    to the very routes it monitors. Instead, a trivial computation
    suffices to prove the worker is up.
    """
    s = get_settings()
    started = datetime.now(timezone.utc)

    def _uptime() -> str:
        # The process is "fresh" at request time; the only honest
        # signal we have without tracking an import-time stamp is the
        # current second. The frontend renders the timestamp itself.
        return started.isoformat()

    return ProbeResult(
        status="healthy",
        detail=f"{s.app_name} · {s.app_env}",
        data={
            "app_name": s.app_name,
            "app_env": s.app_env,
            "checked_at": _uptime(),
        },
    )


# ---------------------------------------------------------------------------
# Database / PostGIS
# ---------------------------------------------------------------------------


async def probe_database(db: AsyncSession) -> ProbeResult:
    async def _do() -> ProbeResult:
        try:
            row1 = (await db.execute(text("SELECT 1"))).scalar()
            postgis = (await db.execute(text("SELECT PostGIS_Full_Version()"))).scalar()
        except Exception as exc:  # noqa: BLE001
            return ProbeResult(
                status="offline",
                detail=_sanitize(str(exc)) or "Database probe failed",
            )
        if row1 != 1:
            return ProbeResult(
                status="degraded",
                detail="Database responded but SELECT 1 returned unexpected value",
            )
        # Only surface "available" on the card; the full version string
        # is reserved for the detail drawer (per spec).
        postgis_short = "available" if postgis else "not detected"
        return ProbeResult(
            status="healthy",
            detail=f"PostGIS {postgis_short}",
            data={
                "postgis_version": postgis or "",
                "postgis_short": postgis_short,
            },
        )

    return await _timed(_do, TIMEOUT_DATABASE)


async def probe_database_size(db: AsyncSession) -> dict[str, Any]:
    """Best-effort total DB size in bytes; returns {} on failure."""
    try:
        row = (
            await db.execute(text("SELECT pg_database_size(current_database())"))
        ).scalar_one()
        return {"database_size_bytes": int(row) if row is not None else None}
    except Exception:  # noqa: BLE001
        return {}


# ---------------------------------------------------------------------------
# MinIO / object storage
# ---------------------------------------------------------------------------


async def probe_storage() -> ProbeResult:
    async def _do() -> ProbeResult:
        s = get_settings()
        result = await storage.bucket_health(max_count=2000)
        # bucket_health returns {"status": "ok"|"error", "detail": "..."}
        if result.get("status") == "ok":
            return ProbeResult(
                status="healthy",
                detail=result.get("detail") or "Bucket reachable",
                data={
                    "bucket": s.s3_bucket,
                    "endpoint_label": _endpoint_label(s.s3_endpoint_url),
                },
            )
        return ProbeResult(
            status="offline",
            detail=_sanitize(result.get("detail")) or "Object storage probe failed",
            data={
                "bucket": s.s3_bucket,
                "endpoint_label": _endpoint_label(s.s3_endpoint_url),
            },
        )

    return await _timed(_do, TIMEOUT_STORAGE)


def _endpoint_label(url: str | None) -> str:
    """Mask credentials in an S3/MinIO endpoint URL for display."""
    if not url:
        return "minio"
    # Schemes like http://minio:9000 → keep as-is
    # Schemes like http://user:pass@host → mask the user:pass
    if "@" in url:
        scheme, rest = url.split("://", 1) if "://" in url else ("", url)
        _, host = rest.split("@", 1)
        return f"{scheme}://{host}"
    return url


# ---------------------------------------------------------------------------
# Dataset processing
# ---------------------------------------------------------------------------


async def probe_dataset_processing(db: AsyncSession, stuck_minutes: int = 30) -> ProbeResult:
    async def _do() -> ProbeResult:
        rows = (await db.execute(select(Dataset.status, func.count()).group_by(Dataset.status))).all()
        counts = {s.value: 0 for s in DatasetStatus}
        for status, count in rows:
            counts[status.value] = count

        # Stuck = PROCESSING for longer than 30 minutes (spec).
        cutoff_sql = text(
            "SELECT COUNT(*) FROM datasets "
            "WHERE status = 'processing' "
            "AND updated_at < (NOW() - (:mins || ' minutes')::interval)"
        )
        stuck_count = (
            await db.execute(cutoff_sql, {"mins": int(stuck_minutes)})
        ).scalar_one()

        last_ready = (
            await db.execute(
                text(
                    "SELECT updated_at FROM datasets "
                    "WHERE status = 'ready' "
                    "ORDER BY updated_at DESC LIMIT 1"
                )
            )
        ).scalar()
        last_failed = (
            await db.execute(
                text(
                    "SELECT updated_at, processing_error FROM datasets "
                    "WHERE status = 'failed' "
                    "ORDER BY updated_at DESC LIMIT 1"
                )
            )
        ).first()

        recent_failures = counts.get("failed", 0)

        if stuck_count and stuck_count > 0:
            status = "degraded" if recent_failures else "degraded"
            detail = f"{stuck_count} dataset(s) stuck in processing for over {stuck_minutes} minutes"
        elif recent_failures and recent_failures > 0:
            status = "degraded"
            detail = f"{recent_failures} recent failure(s)"
        elif counts.get("processing", 0) > 0:
            status = "healthy"
            detail = f"{counts['processing']} dataset(s) processing"
        else:
            status = "healthy"
            detail = "No active processing"

        return ProbeResult(
            status=status,
            detail=detail,
            data={
                "counts": counts,
                "stuck_count": int(stuck_count or 0),
                "stuck_minutes": int(stuck_minutes),
                "last_ready_at": last_ready.isoformat() if last_ready else None,
                "last_failed_at": last_failed[0].isoformat() if last_failed and last_failed[0] else None,
                "last_failed_message": _sanitize(last_failed[1]) if last_failed and last_failed[1] else None,
            },
        )

    return await _timed(_do, TIMEOUT_DATABASE)


# ---------------------------------------------------------------------------
# Disk / storage capacity
# ---------------------------------------------------------------------------


async def probe_storage_capacity() -> ProbeResult:
    path = os.environ.get("STORAGE_MOUNT", "/data")
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        usage = shutil.disk_usage("/")
        path = "/"
    total = usage.total
    free = usage.free
    used = total - free
    pct = round((used / total) * 100, 1) if total else 0.0
    if pct >= 95:
        status = "critical"
    elif pct >= 80:
        status = "degraded"
    else:
        status = "healthy"
    return ProbeResult(
        status=status,
        detail=f"{pct}% used",
        data={
            "path": path,
            "total_bytes": total,
            "used_bytes": used,
            "free_bytes": free,
            "used_percent": pct,
            "warning_threshold_percent": 80,
            "critical_threshold_percent": 95,
        },
    )


# ---------------------------------------------------------------------------
# AI engine / Ollama
# ---------------------------------------------------------------------------


async def probe_ollama() -> ProbeResult:
    s = get_settings()
    base = s.ollama_base_url

    def _ping() -> list[str]:
        client = ollama.Client(host=base, timeout=4)
        resp = client.list()
        # `ollama.list()` returns a ListResponse with `.models` (list[Model])
        models = getattr(resp, "models", None) or []
        names: list[str] = []
        for m in models:
            # m is a Model with a .model attribute on the wire but
            # fall back to a dict-like shape defensively.
            name = getattr(m, "model", None) or (
                m.get("model") if isinstance(m, dict) else None
            )
            if name:
                names.append(name)
        return names

    async def _do() -> ProbeResult:
        try:
            models = await asyncio.to_thread(_ping)
        except Exception as exc:  # noqa: BLE001
            return ProbeResult(
                status="offline",
                detail=_sanitize(str(exc)) or "Ollama server unreachable",
                data={"endpoint_label": _endpoint_label(base)},
            )
        # Validate configured models are present
        chat_present = s.ollama_model in models
        embed_present = s.ollama_embed_model in models
        if chat_present and embed_present:
            status = "healthy"
            detail = f"{len(models)} model(s) available"
        elif models:
            status = "degraded"
            missing = []
            if not chat_present:
                missing.append(s.ollama_model)
            if not embed_present:
                missing.append(s.ollama_embed_model)
            detail = f"Missing model(s): {', '.join(missing)}"
        else:
            status = "degraded"
            detail = "Server reachable but no models loaded"
        return ProbeResult(
            status=status,
            detail=detail,
            data={
                "endpoint_label": _endpoint_label(base),
                "configured_chat_model": s.ollama_model,
                "configured_embed_model": s.ollama_embed_model,
                "chat_model_available": chat_present,
                "embed_model_available": embed_present,
                "available_models": models,
            },
        )

    return await _timed(_do, TIMEOUT_OLLAMA)


# ---------------------------------------------------------------------------
# Connection pool stats
# ---------------------------------------------------------------------------


def probe_db_pool() -> ProbeResult:
    """Read engine pool stats without acquiring a connection."""
    try:
        from app.db.session import engine
        pool = engine.pool
        size = getattr(pool, "size", lambda: None)()
        checked_out = getattr(pool, "checkedout", lambda: None)()
        overflow = getattr(pool, "overflow", lambda: None)()
        max_overflow = getattr(pool, "_max_overflow", None)
        in_use = int(checked_out) if checked_out is not None else None
        status = "healthy" if in_use is None or in_use < (int(size or 0) + int(max_overflow or 0)) - 2 else "degraded"
        return ProbeResult(
            status=status,
            detail=(
                f"{in_use} / {int(size or 0) + int(max_overflow or 0)} in use"
                if in_use is not None
                else "pool stats unavailable"
            ),
            data={
                "pool_size": int(size) if size is not None else None,
                "max_overflow": int(max_overflow) if max_overflow is not None else None,
                "checked_out": in_use,
            },
        )
    except Exception:  # noqa: BLE001
        return ProbeResult(
            status="unknown",
            detail="Database pool stats unavailable",
        )


# ---------------------------------------------------------------------------
# Worker count
# ---------------------------------------------------------------------------


def probe_worker_count() -> dict[str, Any]:
    """Best-effort: pull the uvicorn worker count from os.environ."""
    workers = os.environ.get("BACKEND_WORKERS")
    if not workers:
        # Fall back to a quick psutil-free heuristic
        workers = "1"
    return {"worker_count": int(workers), "process_model": "uvicorn"}


# ---------------------------------------------------------------------------
# Capability summary
# ---------------------------------------------------------------------------


def capability_summary() -> dict[str, dict[str, Any]]:
    """Group capability booleans by parent service for the detail drawer."""
    flags = detect_capabilities()
    out: dict[str, dict[str, Any]] = {}
    for cap in CAPABILITIES:
        present = bool(flags.get(cap.key, False))
        bucket = out.setdefault(cap.parent_key, {"available": [], "missing": []})
        target = bucket["available"] if present else bucket["missing"]
        target.append({"key": cap.key, "label": cap.label, "required": cap.required})
    return out


# ---------------------------------------------------------------------------
# Re-exports for convenience
# ---------------------------------------------------------------------------
