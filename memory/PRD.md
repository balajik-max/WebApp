# Davangere Smart Urban Survey & Architecture Dashboard — PRD

## Original problem statement
Build the "Davangere Smart Urban Survey & Architecture Dashboard" strictly
backend-first with production-grade, modular code. The full brief is
implemented across seven executed phases; this document tracks scope,
architecture, and progress.

## Architecture (final)
- **Backend**: FastAPI (async) · SQLAlchemy 2.x async · asyncpg · GeoAlchemy2
- **Database**: PostgreSQL 16 + PostGIS 3.4 (SRID 4326, GIST + GIN indexes)
- **Object storage**: MinIO (S3-compatible) for dataset uploads + design revisions
- **AI engine**: Ollama serving `llama3:8b` locally (fully offline after first pull)
- **Frontend**: React 18 + TypeScript + Vite + MapLibre GL JS + Recharts
- **Auth**: JWT (bcrypt-hashed passwords), roles = `admin` | `architect`
- **Orchestration**: Docker Compose (5 services on `urban_net` bridge)

## Personas
- **Admin** — manages datasets, users, oversees audit trail, and full workflow.
- **Architect** — reviews features, edits designs (versioned), requests fresh surveys, comments with @mentions.

## Delivered phases (2026-01)

### Phase 1 — Infrastructure ✅
- `docker-compose.yml` orchestrating **db**, **storage**, **backend**, **frontend**, **ai_engine** on `urban_net`.
- Backend Dockerfile with `libgdal-dev`, GEOS, PROJ, libspatialindex.
- Backend restructured into modular `app/` package (`core/`, `db/`, `models/`, `schemas/`, `api/v1/`, `services/`).
- 8 SQLAlchemy models: users, datasets, features (`GEOMETRY(GEOMETRY, 4326)` + `attributes` JSONB), review_items (SLA timestamps), comments (threaded), feature_versions (unique per feature+version), survey_requests (POINT 4326), activity_log (immutable audit).
- Named GIST index `idx_features_geom` + JWT auth with bcrypt + idempotent seed of admin/architect users.

### Phase 2/3 — Ingestion pipeline (Strategy Pattern) ✅
- `DatasetReader` Protocol + `GISReader` (geopandas: `.shp` in `.zip`, `.geojson`, `.gpkg`, `.kml`) + `TableReader` (pandas: `.csv`, `.xlsx`, `.tsv`).
- Reader registry dispatches by extension.
- MinIO async wrapper (`boto3` + `asyncio.to_thread`).
- `POST /api/v1/datasets/upload` → **202** with `poll_url`; `FastAPI.BackgroundTasks` runs the pipeline (`queued → processing → ready/failed`), writing `ActivityLog` rows throughout.
- All CPU-bound geopandas/pandas work offloaded via `asyncio.to_thread`; event loop never blocks.

### Phase 4 — Viewport API + MapLibre canvas ✅
- `GET /api/v1/features?bbox=…&ward=&category=&severity=&limit=` → strict GeoJSON `FeatureCollection`.
- SQL uses `ST_Intersects(ST_MakeEnvelope(...))` so `idx_features_geom` engages.
- Frontend `MapCanvas.tsx`: OSM raster tiles, Davangere-centered, four typed layers (points/lines/polys) with severity-gradient styling, 250 ms debounced `moveend`/`zoomend` fetch with `AbortController`, click → `onFeatureSelect`.

### Phase 4/5 — Dashboard + workflow ✅
- Three-column dual-panel layout: **Analytics** (KPIs + Recharts status bar + ward stacked bar + datasets list) · **Map** · **Architect Workspace** (hidden until a feature is selected).
- Backend endpoints:
  - `GET /api/v1/review-items/{feature_id}` (+ create / status PATCH / comments).
  - `POST /api/v1/review-items/{id}/comments` parses `@mentions` → writes `notifications` rows.
  - `POST /api/v1/features/{id}/versions` uploads to MinIO + auto-increments `version = MAX+1`.
  - `POST /api/v1/survey-requests` creates a POINT 4326 request.
  - `GET /api/v1/features/{id}/activity` returns the immutable timeline.
  - `GET /api/v1/analytics/overview` powers the left panel.
- Every mutation writes to `activity_log` with an `action_string`.
- `notifications` model added for @mention inbox rows.

### Phase 6 — Grounded Ollama RAG loop ✅
- `services/ai_context.py` builds deterministic textual context from PostGIS rows.
- `services/ai.py` calls `ollama.Client` targeting `llama3:8b` with a fixed anti-hallucination system prompt.
- **Structural guarantee**: `context_rows == 0` → returns `INSUFFICIENT_ANSWER` **without invoking the model**.
- Four endpoints: `/api/v1/ai/summarize`, `/query`, `/prioritize`, `/recommend` (last one server-enforces the `*AI recommendation — requires engineer approval*` disclaimer).
- Frontend floating `AiAssistant` with FAB + quick-actions + markdown streaming via `react-markdown`.

### Phase 11 — Production deployment ✅
- Canonical `.env.example` (`POSTGRES_*`, `MINIO_*`, `OLLAMA_*`, `JWT_SECRET_KEY`, `ACCESS_TOKEN_EXPIRE_MINUTES`).
- Backend config accepts BOTH canonical and legacy env names via `AliasChoices`.
- `docker-compose.yml` hardened: `pg_isready` healthcheck on `db`, curl-based healthchecks on `storage` / `ai_engine` / `backend`, `depends_on: service_healthy` gates the boot order (`backend` waits on `db` and `storage`, `frontend` waits on `backend`).
- `backend/entrypoint.sh`: waits for DB → runs schema bootstrap + seed idempotently → execs uvicorn.
- Comprehensive `README.md` runbook: prerequisites, first-time boot, model pull, daily commands, smoke test, safety-invariant verification queries, incident matrix, directory layout, uninstall.

## Prioritized backlog (post-launch)
- **P1**: WebSocket-driven live activity feed + notification inbox push.
- **P1**: Alembic migrations replacing `Base.metadata.create_all`.
- **P2**: Streaming Ollama responses (currently one-shot markdown).
- **P2**: Ingestion progress percentage (currently just status transitions).
- **P2**: Feature-level RBAC (currently role-based only).
- **P3**: Nginx reverse proxy + TLS for a "real" prod deployment.
- **P3**: Prometheus/Grafana metrics on ingestion + AI latency.

## What's next
Ready for **Phase 7** (WebSocket live workspace) whenever you say the word.
