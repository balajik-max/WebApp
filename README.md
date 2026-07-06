# Davangere Smart Urban Survey & Architecture Dashboard

Production-grade, backend-first spatial platform for surveying, reviewing,
versioning, and AI-assisted analysis of civic infrastructure across
Davangere City.  Everything runs locally in Docker — **no paid APIs, no
cloud dependencies, no telemetry**.

---

## Stack at a glance

| Layer      | Tech                                                              |
|------------|-------------------------------------------------------------------|
| Database   | PostgreSQL 16 + **PostGIS 3.4** (SRID 4326, GIST + GIN indexes)   |
| Backend    | FastAPI (async) · SQLAlchemy 2 async · asyncpg · GeoAlchemy2      |
| Object storage | **MinIO** (S3-compatible) for datasets + revised design files |
| AI engine  | **Ollama** serving `llama3:8b` (offline after first pull)         |
| Frontend   | React 18 · TypeScript · Vite · MapLibre GL JS · Recharts          |
| Auth       | JWT (bcrypt hashes) + httpOnly cookies · roles `admin` \| `architect` |
| Orchestration | Docker Compose on the `urban_net` bridge network               |

---

## 1. Prerequisites

* Docker Engine ≥ 24 with Compose v2
* 8 GB free RAM (needed for `llama3:8b` + Postgres + MinIO + Vite)
* 15 GB free disk (Ollama model + Postgres data + MinIO buckets)
* An open outbound connection **only for the first-ever run**, to pull:
  * container images (postgis/postgis, minio/minio, ollama/ollama, node, python)
  * the `llama3:8b` weights (~4.7 GB)

After the first `docker compose up` completes, everything runs fully offline.

---

## 2. First-time boot

```bash
git clone <this-repo>
cd davangere-urban-survey

# 1. Provision your environment
cp .env.example .env
# then edit .env — at minimum change:
#   JWT_SECRET_KEY   (python -c "import secrets; print(secrets.token_hex(32))")
#   POSTGRES_PASSWORD
#   MINIO_ROOT_PASSWORD
#   ADMIN_PASSWORD / ARCHITECT_PASSWORD (for the seed users)

# 2. Build + start everything
docker compose up --build -d

# 3. Watch the AI engine pull the model on first launch (one-time, ~4.7 GB)
docker compose logs -f ai_engine
# You will see:
#   [ollama-bootstrap] pulling llama3:8b (first-run only)...
#   pulling manifest ...
#   verifying sha256 digest ...
#   writing manifest ...
#   [ollama-bootstrap] ready.
# Ctrl-C once you see "ready."  (the pull continues in the background if you exit)

# 4. Confirm every service reports healthy
docker compose ps
```

Expected `docker compose ps` output:

```
NAME                    STATUS
davangere_db            Up (healthy)
davangere_storage       Up (healthy)
davangere_ai            Up (healthy)
davangere_backend       Up (healthy)
davangere_frontend      Up
```

### If you need to pull the model manually

The bootstrap script pulls automatically, but you can also do it by hand
at any time:

```bash
docker compose exec ai_engine ollama pull llama3:8b
# or, to warm the runtime + verify it responds:
docker compose exec ai_engine ollama run llama3:8b "hello"
```

---

## 3. Access points

Once healthy, the following URLs are live on the host:

| URL                              | What                                     |
|----------------------------------|------------------------------------------|
| http://localhost:3000            | Dashboard (MapLibre + analytics + AI)    |
| http://localhost:8001/api/docs   | FastAPI Swagger UI                       |
| http://localhost:8001/api/health | Backend liveness probe                   |
| http://localhost:8001/api/ready  | Readiness (verifies PostGIS is reachable)|
| http://localhost:9001            | MinIO web console                        |
| http://localhost:11434/api/tags  | Ollama's own API (advanced)              |

### Seeded credentials (idempotently created by `entrypoint.sh`)

```
Admin      admin@davangere.gov.in       Admin@12345
Architect  architect@davangere.gov.in   Architect@12345
```

Rotate them by changing `ADMIN_PASSWORD` / `ARCHITECT_PASSWORD` in `.env`
and restarting the backend container — the entrypoint will refresh the
bcrypt hashes without touching any other user.

---

## 4. Daily operation cheat-sheet

```bash
# start / stop
docker compose up -d
docker compose down                       # keeps volumes
docker compose down -v                    # WIPES all data + models

# rebuild after code changes to the backend or frontend image
docker compose build backend frontend
docker compose up -d backend frontend

# live logs
docker compose logs -f backend
docker compose logs -f frontend
docker compose logs -f ai_engine

# shell into a service
docker compose exec backend bash
docker compose exec db bash

# re-run only the seed (idempotent, safe any time)
docker compose exec backend python seed.py

# inspect PostGIS
docker compose exec db psql -U ${POSTGRES_USER} -d ${POSTGRES_DB}
# useful commands inside psql:
#   \d+ features
#   SELECT PostGIS_Full_Version();
#   EXPLAIN ANALYZE SELECT id FROM features
#     WHERE ST_Intersects(geom, ST_MakeEnvelope(75.8,14.4,76.1,14.55,4326));
```

---

## 5. End-to-end smoke test (post-boot)

```bash
API=http://localhost:8001

# 1. login
curl -c c.txt -X POST $API/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"architect@davangere.gov.in","password":"Architect@12345"}'

# 2. confirm session
curl -b c.txt $API/api/auth/me

# 3. upload a survey dataset (any GeoJSON / CSV / .xlsx / zipped Shapefile)
curl -b c.txt -X POST $API/api/v1/datasets/upload \
  -F 'file=@sample_points.csv' -F 'name=Ward 12 lights' -F 'ward=12'
# response is 202 with dataset.id + poll_url

# 4. poll ingestion status
curl -b c.txt $API/api/v1/datasets/<dataset-id>

# 5. query the viewport around Davangere
curl -b c.txt "$API/api/v1/features?bbox=75.8,14.4,76.1,14.55&ward=12"

# 6. ask the local AI a grounded question
curl -b c.txt -X POST $API/api/v1/ai/prioritize \
  -H 'Content-Type: application/json' -d '{"ward":"12","limit":25}'
```

If step 6 returns markdown ending in a `## Notes` section, the whole
stack is live and grounded.  An answer that reads *"Sufficient local
survey data is not available…"* means the DB has no matching rows —
which is a **safety guarantee**, not a bug (see `services/ai.py`).

---

## 6. Verifying the safety invariants

```bash
# 1. Bcrypt hashes present (never plaintext)
docker compose exec db psql -U $POSTGRES_USER -d $POSTGRES_DB -c \
"SELECT email, substr(password_hash,1,7) AS bcrypt_prefix FROM users;"
#   admin@…      $2b$12
#   architect@…  $2b$12

# 2. GIST index in use
docker compose exec db psql -U $POSTGRES_USER -d $POSTGRES_DB -c \
"EXPLAIN SELECT id FROM features
 WHERE ST_Intersects(geom, ST_MakeEnvelope(75.8,14.4,76.1,14.55,4326));"
#   -> Bitmap Index Scan on idx_features_geom

# 3. GIN index on JSONB attributes
docker compose exec db psql -U $POSTGRES_USER -d $POSTGRES_DB -c \
"\d+ features" | grep idx_features_attributes_gin
#   idx_features_attributes_gin  gin  (attributes jsonb_path_ops)

# 4. Immutable audit trail is being written
docker compose exec db psql -U $POSTGRES_USER -d $POSTGRES_DB -c \
"SELECT action, COUNT(*) FROM activity_log GROUP BY action ORDER BY 2 DESC;"

# 5. AI insufficient-data guard triggers WITHOUT calling the model
curl -b c.txt -X POST $API/api/v1/ai/summarize \
  -H 'Content-Type: application/json' -d '{"ward":"ward-that-does-not-exist"}'
#   -> { "grounded": false, "context_rows": 0,
#        "answer_markdown": "Sufficient local survey data is not available…" }
```

---

## 7. Runbook: common incidents

| Symptom                                             | Fix                                                                                                     |
|-----------------------------------------------------|---------------------------------------------------------------------------------------------------------|
| `backend` container restart loop                    | `docker compose logs backend` — usually a missing `.env` key. Every value in `.env.example` is required.|
| `/api/ai/*` returns 500 with `ollama_error`         | `docker compose exec ai_engine ollama list` — if `llama3:8b` is missing, pull it manually.              |
| MinIO console shows no bucket                       | Bucket is created on-demand by the first upload; call `POST /api/v1/datasets/upload` once.              |
| Postgres reports "extension postgis does not exist" | You are running an image other than `postgis/postgis`. Reset the `postgis_data` volume.                 |
| Frontend cannot reach backend                       | Confirm `VITE_API_BASE_URL` matches the host-side URL of the backend (default `http://localhost:8001`). |
| Model download stalls                               | `docker compose exec ai_engine ollama pull llama3:8b` — resumes with an unstable network.               |

---

## 8. Directory layout

```
.
├── docker-compose.yml           # 5-service orchestration with healthchecks
├── .env.example                 # canonical environment template (this repo)
├── backend/
│   ├── Dockerfile               # slim-python + libgdal-dev + PostGIS client libs
│   ├── entrypoint.sh            # waits for DB → runs seed → execs uvicorn
│   ├── requirements.txt
│   ├── init.sql                 # CREATE EXTENSION postgis on volume init
│   ├── seed.py                  # idempotent admin+architect bootstrap
│   ├── server.py                # ASGI shim → app.main:app
│   └── app/
│       ├── main.py              # FastAPI factory + lifespan
│       ├── core/                # config, security, logging
│       ├── db/                  # engine, session, init_db (create + indexes)
│       ├── models/              # 9 tables (users, datasets, features, review_items,
│       │                        #   comments, feature_versions, survey_requests,
│       │                        #   activity_log, notifications)
│       ├── schemas/              # Pydantic response models
│       ├── api/v1/              # auth, datasets, features, review_items,
│       │                        #   survey_requests, analytics, ai routers
│       └── services/            # storage, ingestion, ai, ai_context, mentions,
│                                #   readers/ (strategy pattern: GISReader, TableReader)
├── frontend/                    # Vite + TS scaffold (MapCanvas, AnalyticsPanel,
│                                #   ArchitectWorkspace, AiAssistant)
└── scripts/
    └── ollama_bootstrap.sh      # first-boot llama3:8b pull, then `ollama serve`
```

---

## 9. Uninstall / reset

```bash
# nuke everything (containers, volumes, model weights, uploaded datasets)
docker compose down -v
docker image prune -f
rm .env
```
