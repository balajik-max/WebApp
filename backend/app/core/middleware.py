"""
Security middleware: rate limiting, CSRF origin check, request size limit.
All checks run before request reaches route handlers.
"""
from __future__ import annotations

import hashlib
import logging
import time
from collections import defaultdict
from typing import Any

from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.status import HTTP_429_TOO_MANY_REQUESTS, HTTP_403_FORBIDDEN

from app.core.config import MAX_UPLOAD_BYTES, get_settings

log = logging.getLogger("davangere.middleware")

# ---------------------------------------------------------------------------
# In-memory sliding-window rate limiter (per IP)
# ---------------------------------------------------------------------------
class _SlidingWindowCounter:
    def __init__(self) -> None:
        self._buckets: dict[str, list[float]] = defaultdict(list)

    def allow(self, key: str, max_requests: int, window_seconds: int) -> bool:
        now = time.monotonic()
        bucket = self._buckets[key]
        cutoff = now - window_seconds
        # Prune expired timestamps
        while bucket and bucket[0] < cutoff:
            bucket.pop(0)
        if len(bucket) >= max_requests:
            return False
        bucket.append(now)
        return True


_rate_limiter = _SlidingWindowCounter()


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"


# ---------------------------------------------------------------------------
# FastAPI middleware class
# ---------------------------------------------------------------------------
class SecurityMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        settings = get_settings()

        # ── 1. Request body size limit (for all endpoints) ──────────────
        content_length = request.headers.get("content-length")
        if content_length:
            try:
                cl = int(content_length)
            except ValueError:
                return Response(
                    status_code=400,
                    content='{"detail":"Invalid Content-Length header"}',
                    media_type="application/json",
                )
            # +1MB headroom over the file-size cap for multipart boundaries/
            # form-field overhead, so a file right at the cap isn't rejected
            # here for reasons unrelated to the file's own size.
            if cl > MAX_UPLOAD_BYTES + 1024 * 1024:
                return Response(
                    status_code=413,
                    content='{"detail":"Request too large"}',
                    media_type="application/json",
                )

        # ── 2. Rate limit on auth endpoints ────────────────────────────
        if request.url.path.startswith("/api/auth/"):
            ip = _client_ip(request)
            key = f"{request.url.path}:{ip}"
            if not _rate_limiter.allow(
                key,
                max_requests=settings.rate_limit_max,
                window_seconds=settings.rate_limit_window_seconds,
            ):
                log.warning("Rate limit hit for %s from %s", request.url.path, ip)
                return Response(
                    status_code=HTTP_429_TOO_MANY_REQUESTS,
                    content='{"detail":"Too many requests. Please wait before trying again."}',
                    media_type="application/json",
                    headers={"Retry-After": str(settings.rate_limit_window_seconds)},
                )

        # ── 3. CSRF origin check for state-changing requests ───────────
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            origin = request.headers.get("origin", "")
            referer = request.headers.get("referer", "")

            if not origin and not referer:
                if request.url.path.startswith("/api/auth/login"):
                    pass
                elif request.url.path.startswith("/api/"):
                    pass
            else:
                allowed = [settings.frontend_url.rstrip("/")]
                valid = False
                for source in (origin, referer):
                    if not source:
                        continue
                    for a in allowed:
                        if source.startswith(a):
                            valid = True
                            break
                if not valid:
                    log.warning(
                        "CSRF check failed for %s: origin=%s referer=%s",
                        request.url.path, origin, referer,
                    )
                    return Response(
                        status_code=HTTP_403_FORBIDDEN,
                        content='{"detail":"CSRF check failed: invalid origin"}',
                        media_type="application/json",
                    )

        response = await call_next(request)

        # ── 4. Security headers ────────────────────────────────────────
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Strict-Transport-Security"] = (
            "max-age=31536000; includeSubDomains" if settings.app_env == "production" else "max-age=0"
        )

        return response
