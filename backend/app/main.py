"""
FastAPI application factory & lifespan.
Boots the async engine, creates spatial tables (via Alembic in prod),
seeds admin + architect users, and mounts all API routers.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.core.logging import configure_logging
from app.core.middleware import SecurityMiddleware
from app.db.init_db import init_database
from app.services.storage import ensure_bucket
from app.api.v1.router import api_router

log = logging.getLogger("davangere.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level)
    log.info("Booting %s (env=%s)", settings.app_name, settings.app_env)
    # Initialize schema + seed data (idempotent).  Errors are logged but do
    # not crash the process — this lets the API stay reachable for a
    # /api/health probe even if the database is temporarily unavailable.
    try:
        await init_database()
    except Exception as exc:  # noqa: BLE001
        log.exception("Database initialization failed: %s", exc)
    try:
        await ensure_bucket()
    except Exception as exc:  # noqa: BLE001
        log.exception("MinIO bucket provisioning failed: %s", exc)
    yield
    log.info("Shutting down %s", settings.app_name)


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=settings.app_name,
        version="0.1.0",
        docs_url="/api/docs",
        redoc_url="/api/redoc",
        openapi_url="/api/openapi.json",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.add_middleware(SecurityMiddleware)

    app.include_router(api_router, prefix="/api")
    return app


app = create_app()
