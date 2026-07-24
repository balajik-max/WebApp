# Unified Shared Backend & Database Architecture Investigation Report

**Project:** Davangere Smart Urban Survey & Architecture Dashboard  
**Investigation Date:** $(date +%Y-%m-%d)  
**Status:** Read-only architecture analysis (no code/schema/Docker changes made)

---

## 1. Executive Summary

The Davangere Smart Urban Survey platform is a **single-tenant, single-organization** GIS application built for the Davangere Municipal Corporation. It is deployed via Docker Compose with five services, using PostgreSQL/PostGIS for all structured data, MinIO for object/file storage, and Ollama for local AI inference.

**Current Tenancy Model:** Single-tenant. All authenticated users share the same datasets, features, and database records. Ward is stored as a plain text string. No organization, project, or tenant isolation exists at any layer (database, API, storage, or frontend).

**Key Findings:**
- No `organization_id`, `project_id`, or multi-ward membership fields exist anywhere
- Ward is a plain `VARCHAR(128)` column on `datasets`, `features`, and `spatial_anomalies` tables — not a foreign key entity
- All users can see all datasets and features via the API (no ownership filtering)
- Only role-based access control exists (Admin, Architect, Commissioner, AEE, AE, MLA)
- MinIO uses a single bucket with flat key pattern: `datasets/{dataset_id}/{filename}`
- Background processing runs in-process via FastAPI `BackgroundTasks` (not durable)
- The project currently serves one municipality but the architecture is designed to be extensible

**Recommended Architecture: Option A — Single Shared Database + Shared Schema** with organization/project scope columns. This provides the simplest migration path, lowest operational complexity, and sufficient isolation for the expected scale (one municipality with potential expansion to a few more).

---

## 2. Current Deployment Architecture

```
Browser
  │
  ▼
Frontend (React + Vite, port 3000)
  │  Dev: Vite proxy /api → backend
  │  Prod: serve static + /api/ → backend via VITE_API_BASE_URL
  │
  ▼
FastAPI Backend (Uvicorn, port 8001, 2 workers)
  │          │              │
  ▼          ▼              ▼
PostGIS   MinIO/S3      Ollama AI
(5432)    (9000/9001)   (11434)
```

**Network:** All services on `urban_net` bridge network  
**Volumes:** `postgis_data`, `minio_data`, `ollama_data` (Docker named volumes)

---

## 3. Current Docker Services

| Service | Container Name | Image | Port(s) | Stateful | Scale Ready | Notes |
|---------|---------------|-------|---------|----------|-------------|-------|
| `db` | `davangere_db` | `postgis/postgis:16-3.4` | 5432 | ✅ Yes | Requires connection pooling | Named volume `postgis_data` |
| `storage` | `davangere_storage` | `minio/minio:latest` | 9000, 9001 | ✅ Yes | Distributed MinIO possible | Named volume `minio_data` |
| `ai_engine` | `davangere_ai` | `ollama/ollama:latest` | 11434 | ✅ Yes | Single container | Named volume `ollama_data` |
| `backend` | `davangere_backend` | Custom (Dockerfile) | 8001 | ❌ No | ✅ Yes (stateless) | 2 workers, BackgroundTasks in-process |
| `frontend` | `davangere_frontend` | Custom (Dockerfile) | 3000 | ❌ No | ✅ Yes (stateless) | Static files via `serve` |

**Key Architecture Observations:**
- Backend assumes `localhost` names for dependent services via Docker DNS (`db`, `storage`, `ai_engine`)
- Multiple backend replicas would work but BackgroundTasks would be duplicated/competing
- No Redis, Celery, or external job queue exists
- No reverse proxy or TLS termination in current compose
- Health checks exist for all services

---

## 4. Frontend Architecture

| Aspect | Current Implementation | Tenant Readiness |
|--------|----------------------|------------------|
| API base URL | `VITE_API_BASE_URL` env var, dev proxy `/api` → backend | ✅ Configurable |
| Auth mechanism | httpOnly JWT cookies (access + refresh), auto-refresh on 401 | ✅ Works with replicas |
| Auth state | `localStorage` key `davangere.user` | ⚠️ Assumes single user session |
| Routing | React Router v6, `AuthShield` wrapper | ✅ Standard |
| State management | React context (AuthContext, ThemeContext, LanguageContext) | ⚠️ No tenant/org context |
| API client | Thin `fetch` wrapper with cookie support | ⚠️ No tenant header |
| Map library | MapLibre GL JS | ✅ |
| 3D viewer | Three.js | ✅ |

**API Domains Used by Frontend:**
- `/api/auth/*` — login, logout, me, refresh
- `/api/health`, `/api/ready`
- `/api/v1/datasets/*` — upload, list, get, delete, features, bounds, raster
- `/api/v1/features/*` — list (bbox), table, categories, versions, activity, photo
- `/api/v1/analytics/*` — overview, quality, features, export, water-demand, drain-encroachment, manhole-readiness
- `/api/v1/ai/*` — query, report, recommend, spacing, audit, explain, manhole-recommend, urban-planning-solution
- `/api/v1/review-items/*`
- `/api/v1/survey-requests/*`
- `/api/v1/placemarks/*`
- `/api/v1/point-verifications/*`
- `/api/v1/classification/*`
- `/api/v1/visualization/*`
- `/api/v1/map-context/*`
- `/api/v1/admin/*` — services, datasets, workflows, activity, security

**Security Analysis:**
- Frontend does **not** filter data by user — it receives all data the backend returns
- User data persists in `localStorage` after logout (if logout fails)
- No tenant/organization selection UI exists
- No ward-scoped data loading — all wards are loaded for all users

---

## 5. Backend Architecture

| Module | Classification | Purpose |
|--------|---------------|---------|
| `app/main.py` | Core infrastructure | FastAPI app factory, lifespan, CORS, middleware |
| `app/core/` | Core infrastructure | Config, security (JWT/bcrypt), logging, middleware |
| `app/db/` | Core infrastructure | Engine, sessions, init_db |
| `app/models/` | Business domain | 14 ORM models |
| `app/api/v1/` | Business domain | 17 router modules |
| `app/services/` | Business domain | ~25 service modules |
| `app/schemas/` | Shared utility | Pydantic request/response schemas |

**Application Startup:**
1. Initialize database tables + spatial indexes
2. Seed default users (Admin, Architect, Commissioner, AEE, AE, MLA)
3. Ensure MinIO bucket exists
4. Mount all API routers under `/api`

**Middleware Stack:**
1. `CORSMiddleware` — allows frontend URL
2. `SecurityMiddleware` — body size limit, rate limiting, CSRF check, security headers

**Dependency Injection:**
- `get_db` — yields async SQLAlchemy session, auto-commits
- `get_current_user` — extracts JWT from cookie/header, validates, returns User
- `require_roles(...)` — role guard factory

---

## 6. API Inventory

### Authentication (prefix: `/api/auth`)
| Method | Route | Auth | Roles | Tables Used |
|--------|-------|------|-------|-------------|
| POST | `/login` | ❌ | All | users, activity_log |
| POST | `/logout` | ✅ | All | — |
| GET | `/me` | ✅ | All | users |
| POST | `/refresh` | ✅ | All | users |

### Datasets (prefix: `/api/v1/datasets`)
| Method | Route | Auth | Roles | Tables Used |
|--------|-------|------|-------|-------------|
| POST | `/upload` | ✅ | Any | datasets, activity_log, MinIO |
| GET | `/` | ✅ | Any | datasets |
| GET | `/{id}` | ✅ | Any | datasets |
| PATCH | `/{id}` | ✅ | Any | datasets, activity_log |
| DELETE | `/{id}` | ✅ | Any | datasets, activity_log, MinIO |
| GET | `/{id}/features` | ✅ | Any | datasets, features |
| GET | `/{id}/bounds` | ✅ | Any | features |
| GET | `/wards/list` | ✅ | Any | datasets, features |
| POST | `/{id}/source-crs` | ✅ | Any | datasets, activity_log |
| GET | `/{id}/raster-preview.png` | ✅ | Any | datasets, MinIO |
| GET | `/{id}/raster-tiles/{z}/{x}/{y}.png` | ✅ | Any | datasets, MinIO |
| GET | `/{id}/raw-file` | ✅ | Any | datasets, MinIO |
| GET | `/{id}/model-asset/{filename}` | ✅ | Any | datasets, MinIO |
| GET | `/{id}/model-assets/{path}` | ✅ | Any | datasets, MinIO |
| GET | `/{id}/dem-grid` | ✅ | Any | datasets, MinIO |
| GET | `/building-heights` | ✅ | Any | datasets, features, MinIO |

### Features (prefix: `/api/v1/features`)
| Method | Route | Auth | Roles | Tables Used |
|--------|-------|------|-------|-------------|
| GET | `/` | ✅ | Any | features, datasets |
| GET | `/table` | ✅ | Any | features, datasets |
| GET | `/categories` | ✅ | Any | features, datasets |
| GET | `/fid-search` | ✅ | Any | features, datasets |
| POST | `/{id}/versions` | ✅ | Any | features, feature_versions, MinIO |
| GET | `/{id}/versions` | ✅ | Any | feature_versions |
| GET | `/{id}/activity` | ✅ | Any | activity_log |
| GET | `/{id}/photo` | ✅ | Any | features, MinIO |

### Analytics (prefix: `/api/v1/analytics`)
| Method | Route | Auth | Roles | Tables Used |
|--------|-------|------|-------|-------------|
| GET | `/overview` | ✅ | Any | datasets, features, review_items |
| GET | `/features` | ✅ | Any | features, datasets |
| GET | `/quality` | ✅ | Any | features |
| GET | `/export` | ✅ | Any | features |
| GET | `/water-demand` | ✅ | Any | ward_census, features |
| GET | `/drain-encroachment` | ✅ | Any | features |
| GET | `/manhole-readiness` | ✅ | Any | features |
| GET | `/manhole-readiness/features` | ✅ | Any | features |

### AI (prefix: `/api/v1/ai`)
| Method | Route | Auth | Roles | Tables Used |
|--------|-------|------|-------|-------------|
| POST | `/query` | ✅ | Any | features |
| POST | `/report` | ✅ | Any | features |
| POST | `/recommend` | ✅ | Any | features |
| POST | `/spacing` | ✅ | Any | features |
| POST | `/audit` | ✅ | Any | spatial_anomalies, features |
| GET | `/audit/anomalies` | ✅ | Any | spatial_anomalies |
| POST | `/audit/anomalies/{id}/explain` | ✅ | Any | spatial_anomalies, Ollama |
| PATCH | `/audit/anomalies/{id}` | ✅ | Any | spatial_anomalies |
| GET | `/audit/roads/{id}` | ✅ | Any | spatial_anomalies |
| POST | `/manhole-recommend` | ✅ | Any | features |
| POST | `/urban-planning-solution` | ✅ | Any | features, spatial_anomalies, Ollama |

### Admin (prefix: `/api/v1/admin`)
| Method | Route | Auth | Roles | Tables Used |
|--------|-------|------|-------|-------------|
| GET | `/services/legacy` | ✅ | Admin | PostGIS, MinIO, Ollama |
| GET | `/services` | ✅ | Admin | PostGIS, MinIO, Ollama |
| GET | `/datasets` | ✅ | Admin | datasets |
| GET | `/workflows` | ✅ | Admin | point_verifications, review_items |
| GET | `/activity` | ✅ | Admin | users, activity_log |
| GET | `/security` | ✅ | Admin | Config + probes |

### Other
| Method | Route | Auth | Roles | Tables Used |
|--------|-------|------|-------|-------------|
| GET | `/api/health` | ❌ | — | — |
| GET | `/api/ready` | ❌ | — | PostGIS probe |
| Various | `/api/v1/placemarks/*` | ✅ | Any | placemarks |
| Various | `/api/v1/point-verifications/*` | ✅ | Role-specific | point_verifications, features |
| Various | `/api/v1/review-items/*` | ✅ | Any | review_items, features |
| Various | `/api/v1/survey-requests/*` | ✅ | Any | survey_requests |
| Various | `/api/v1/classification/*` | ✅ | Any | category_class_map |
| Various | `/api/v1/visualization/*` | ✅ | Any | features |
| Various | `/api/v1/map-context/*` | ✅ | Any | features, spatial_anomalies |

---

## 7. Database Schema Inventory

| Table | Purpose | Key Columns | Spatial | Ownership Fields | Ward Field |
|-------|---------|-------------|---------|-----------------|------------|
| `users` | User accounts | id, name, email, password_hash, role, is_active | ❌ | N/A (self) | ❌ |
| `datasets` | Uploaded survey inputs | id, name, ward, file_type, storage_key, status, uploaded_by, metadata (JSONB) | ❌ | `uploaded_by` (FK→users) | `ward VARCHAR(128)` |
| `features` | GIS features | id, dataset_id, label, category, severity, attributes (JSONB) | ✅ GEOMETRY(GEOMETRY,4326) | Via dataset | Via dataset |
| `feature_versions` | Version history | id, feature_id, version, change_note, edited_by, attributes (JSONB) | ✅ GEOMETRY(GEOMETRY,4326) | `edited_by` (FK→users) | Via feature |
| `spatial_anomalies` | AI audit findings | id, dataset_id, ward, anomaly_type, color, severity_score, status, feature_ids (UUID[]), anomaly_metadata (JSONB) | ✅ POINT(4326) | Via dataset (ward string) | `ward VARCHAR(128)` |
| `point_verifications` | AE/AEE/Commissioner workflow | id, feature_id, workflow_status, field_submitter_id, aee_id, commissioner_id, before/after photo keys | ❌ (lon/lat fields) | Via user IDs | Via feature |
| `review_items` | Architect review | id, feature_id, title, description, priority, status, assigned_to, created_by | ❌ | `assigned_to`, `created_by` | Via feature |
| `comments` | Threaded discussions | id, feature_id, review_item_id, parent_id, author_id, body | ❌ | `author_id` | Via feature |
| `placemarks` | User map markers | id, owner_id, dataset_id, name, category, longitude, latitude | ✅ POINT(4326) | `owner_id` (FK→users) | Via dataset |
| `notifications` | In-app notifications | id, user_id, actor_id, source, source_id, feature_id, message, read_at | ❌ | `user_id`, `actor_id` | Via feature |
| `activity_log` | Immutable audit trail | id, actor_id, action, entity_type, entity_id, payload (JSONB) | ❌ | `actor_id` | In payload |
| `survey_requests` | Field survey requests | id, requested_by, title, reason, ward, priority, status | ✅ POINT(4326) | `requested_by` | `ward VARCHAR(128)` |
| `ward_census` | Census data cache | id, ward_no, ward_name, males, females, persons, area_sq_km | ❌ | ❌ | `ward_no INT` |
| `city_census_summary` | City-level cache | id (PK int), total_population, total_area_sq_km, number_of_wards | ❌ | ❌ | ❌ |
| `category_class_map` | Category→Class cache | id, raw_category, canonical_class, match_method, confidence, resolved_by | ❌ | `resolved_by` | ❌ |

**Spatial Indexes:**
- `idx_features_geom` — GIST on `features.geom`
- `idx_features_attributes_gin` — GIN on `features.attributes`
- `idx_spatial_anomalies_geom` — GIST on `spatial_anomalies.geom`
- `idx_placemarks_geom` — GIST on `placemarks.geom`

---

## 8. User Model

```python
class User(Base):
    __tablename__ = "users"
    id: UUID (PK)
    name: String(255)
    email: String(320) (UNIQUE, INDEX)
    password_hash: String(255) (bcrypt)
    role: UserRole (VARCHAR(32), stored as string)
    is_active: Boolean (default True)
    created_at: DateTime(timezone)
    updated_at: DateTime(timezone)
```

**Missing Fields for Shared Production:**
- ❌ `organization_id` — which org/municipality the user belongs to
- ❌ `department_id` — department within org
- ❌ `ward_id` / `jurisdiction` — which ward(s) the user can access
- ❌ `project_membership` — which projects the user belongs to
- ❌ `token_version` — for session revocation
- ❌ `last_login` — last login timestamp
- ❌ `account_expiry` — expiration date
- ❌ `lock_state` — account lock status
- ✅ Role is present (but global, not org-specific)

**User Creation:** Only through `seed.py` (6 seeded users). No user registration API exists in the backend.

---

## 9. Role and Permission Model

| Role | Read Access | Write Access | Admin Access | Notes |
|------|-------------|--------------|--------------|-------|
| `admin` | ✅ All | ✅ All | ✅ Full | System administrator |
| `architect` | ✅ All | ✅ Review/design | ❌ | Design workspace |
| `commissioner` | ✅ All | ✅ Approve workflows | ❌ | Final approval authority |
| `aee` | ✅ All | ✅ Review/approve remediation | ❌ | AEE review |
| `ae` | ✅ All | ✅ Submit field remediation | ❌ | Field engineer |
| `mla` | ✅ Read-only | ❌ (except logout) | ❌ | Elected representative |

**Permission Implementation:**
- Hardcoded role checks in `app/api/deps.py` via `require_roles()`
- MLA gets special handling in `get_current_user()` — rejects non-GET/POST/logout
- No database-level permissions
- No organization-specific roles
- No custom roles or permission overrides

---

## 10. Data Ownership Matrix

| Entity | Owner Field | Organization Field | Ward Field | Project Field | Backend Access Rule | Current Isolation | Gap |
|--------|-------------|-------------------|------------|---------------|---------------------|-------------------|-----|
| datasets | `uploaded_by` | ❌ | `ward` (string) | ❌ | Any authenticated user | **None** — all users see all datasets | Must add org/project scope |
| features | Via dataset | ❌ | Via dataset (string) | ❌ | Any authenticated user | **None** — all users see all features | Must inherit dataset scope |
| spatial_anomalies | Via dataset | ❌ | `ward` (string) | ❌ | Any authenticated user | **None** | Must inherit dataset scope |
| point_verifications | `field_submitter_id`, `aee_id`, `commissioner_id` | ❌ | Via feature | ❌ | Role-based | **Partial** — role gating but no ward/org isolation | Must add scope |
| review_items | `assigned_to`, `created_by` | ❌ | Via feature | ❌ | Any authenticated user | **None** | Must add scope |
| comments | `author_id` | ❌ | Via feature | ❌ | Any authenticated user | **None** | Must add scope |
| placemarks | `owner_id` | ❌ | Via dataset | ❌ | Owner only (via API filtering) | **Partial** — owner-scoped | Must add org |
| notifications | `user_id` | ❌ | Via feature | ❌ | User-specific (recipient) | **Partial** — recipient-scoped | Must add org |
| survey_requests | `requested_by` | ❌ | `ward` (string) | ❌ | Any authenticated user | **None** | Must add scope |
| activity_log | `actor_id` | ❌ | ❌ | ❌ | Any authenticated user (Admin for all) | **None** | Must add scope for filtering |

---

## 11. Current Tenancy Classification

**Classification: Single-tenant (single-organization, multi-user)**

Evidence:
1. All users share the same `datasets` table — no dataset-level access restrictions
2. The `GET /api/v1/datasets` endpoint returns **all** datasets regardless of uploader
3. The `GET /api/v1/features` endpoint returns **all** features matching bbox/category
4. The `GET /api/v1/analytics/overview` endpoint aggregates across **all** datasets
5. MinIO uses a single bucket — `datasets/{id}/{filename}` pattern
6. The project is named after a single city: "Davangere Smart Urban Survey"
7. Ward is a plain string, not a foreign key to a wards table
8. No organization or tenant concept exists anywhere in the codebase
9. Seeded users are specific to Davangere (e.g., `commissioner@davangere.gov.in`)
10. The config file references Davangere-specific settings

---

## 12. Ward and Jurisdiction Model

**Current State:**
- `ward` is a plain `VARCHAR(128)` on `datasets`, `spatial_anomalies`, and `survey_requests`
- Features inherit ward from their parent dataset
- No `wards` database table exists
- No ward-to-user mapping exists
- Ward names appear to be strings like "Ward 12", "Ward 15", etc.
- The `WardCensus` model has `ward_no` (integer) and `ward_name` (string) — but this is a separate cache table

**Required Future State:**
- A `wards` entity with ID, name, geometry, organization_id
- User-to-ward membership (many-to-many)
- Ward-scoped API filtering

---

## 13. Organization and Project Gaps

**Current Entities:**
- ❌ No `organizations` table
- ❌ No `municipalities` table
- ❌ No `projects` table
- ❌ No `departments` table
- ❌ No `zones` table

The only existing concepts:
- `ward` (plain string) — could evolve into a `wards` entity
- `WardCensus` — cache table, not an organizational entity
- `CityCensusSummary` — singleton for the whole city

**Minimum Required Future Entities:**
- `Organization` (municipal corporation)
- `Ward` (admin ward with geometry)
- `Project` (survey/remediation project)
- `UserOrganizationMembership` (user-to-org with role)

---

## 14. Dataset Access Model

**Current Behavior:**
1. Any authenticated user can upload a dataset
2. Any authenticated user can list all datasets
3. Any authenticated user can view any dataset's details
4. Any authenticated user can delete any dataset
5. `uploaded_by` is tracked but never used for access control
6. `ward` is a string, used for display/filtering only — not security

**Required Changes for Shared Backend:**
- Dataset must have `organization_id` and `project_id`
- `GET /datasets` must filter by user's organization/project membership
- Delete must verify ownership or admin privilege
- Upload must assign current user's organization

---

## 15. GIS Feature Access Model

**Current Behavior:**
1. Features inherit visibility from their parent dataset (no direct access control)
2. The viewport query (`ST_Intersects`) returns all features regardless of user
3. Category/attribute filtering is applied globally
4. No access check on `feature_id` parameter in version/activity endpoints

**Required Changes for Shared Backend:**
- All feature queries must join through datasets and check organization/project scope
- Feature IDs must be scoped — a user should not be able to access features from another org's dataset
- Feature version history must inherit access from the feature

---

## 16. Task and Workflow Access Model

**Current State:**
- `PointVerification` — role-gated (AE submit, AEE review, Commissioner accept)
- `ReviewItem` — assigned to specific users
- `SurveyRequest` — requested by user, any authenticated user can view
- Workflow status transitions are role-restricted but not organization-restricted

**Gaps:**
- AEE from one organization could review another organization's work items
- No project/org scope on workflow queries
- Task assignment has no org boundary

---

## 17. Notification Model

**Current State:**
- `Notification` has `user_id` (recipient) and `actor_id` (triggering user)
- Notifications are recipient-specific ✅
- No organization/project scope ❌

**Gaps:**
- Cross-org notification leakage not possible since user_id is specific
- But comments/workflow events could trigger notifications for wrong org if roles overlap

---

## 18. Audit Model

**Current State:**
- `ActivityLog` has `actor_id`, `action`, `entity_type`, `entity_id`, payload (JSONB)
- No organization/project/ward fields on activity_log
- Admin can see all activity

**Gaps:**
- Cannot filter audit log by organization
- No tenant context in payload
- No request ID correlation

---

## 19. MinIO/Object Storage Model

**Current Structure:**
- Single bucket (configured via `MINIO_BUCKET_NAME` / `S3_BUCKET`)
- Key patterns:
  - `datasets/{dataset_id}/{filename}` — uploaded files
  - `datasets/{dataset_id}/model/{...}` — extracted OBJ assets
  - `versions/{feature_id}/{artefact_id}_{filename}` — design versions
  - `raster_previews/{dataset_id}/{variant}.png` — ingestion previews (inferred)
- Photo keys stored in point_verifications columns (`before_photo_key`, `after_photo_key`)

**Ownership & Access:**
- No access control on object keys — any authenticated user can request any key
- Backend proxies all file access (no presigned URLs exposed to browser)
- Object deletion happens on dataset delete via `delete_objects_with_prefix()`

**Required Changes:**
- Key structure should include organization ID:
  `organizations/{org_id}/projects/{proj_id}/datasets/{dataset_id}/{filename}`
- Or at minimum: `organizations/{org_id}/datasets/{dataset_id}/{filename}`
- Photo keys should include organization scope

---

## 20. AI Data-Access Model

**Current Behavior:**
1. AI endpoints build context from the **same global database** — no user/org filtering
2. `build_report_facts()` accepts optional dataset_ids/ward but **no org filter**
3. `build_feature_ids_context()` loads features by ID without ownership check
4. `build_dataset_or_ward_context()` loads any dataset features without access check
5. Ollama runs locally and accesses only the context sent in the prompt
6. AI outputs are stored back to the database without ownership tagging

**Risk for Shared Backend:**
User A's data could be included in User B's AI query if:
- User B knows a feature_id from another org
- User B uses the non-scoped AI report endpoint
- Admin queries span all organizations

**Required Changes:**
- All AI context builders must accept `organization_id` or scope
- Feature ID validation must check org membership
- AI output storage must include org/project scope

---

## 21. Background Processing Model

**Current Execution:**
- **Dataset ingestion:** via FastAPI `BackgroundTasks` (in-process, not durable)
- **Spatial audit:** synchronous within request (caller waits)
- **Manhole recommendation:** synchronous within request
- No dedicated worker process
- No job queue, no retry mechanism, no job persistence

**Limitations:**
1. Background tasks do not survive backend restart
2. Multiple backend replicas would each start duplicate ingestion tasks
3. No progress tracking for long-running operations
4. No cancellation mechanism for stuck ingestions
5. Dataset status (`QUEUED`, `PROCESSING`, `READY`, `FAILED`) exists but no heartbeat

**Recommended Future State:**
- Database-backed job queue with `job_id`, `owner_id`, `organization_id`, `status`
- Dedicated worker container for dataset processing
- Retry logic with exponential backoff
- Job status API for progress tracking

---

## 22. Transaction and Concurrency Risks

**Current Configuration:**
- `get_db()` dependency: auto-commits on success, rolls back on exception
- Session-per-request pattern
- `expire_on_commit=False`
- No explicit locking mechanisms

**Risks for Shared Backend:**
1. Concurrent dataset ingestion could create duplicate features
2. Point verification status could race between AE and AEE
3. No optimistic locking (version columns) on workflow entities
4. Long-running ingestions hold sessions in a shared pool
5. No idempotency keys on upload endpoint

---

## 23. Database Connection Scaling

**Current Configuration:**
```python
engine = create_async_engine(
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
)
```

**Connection Demand Estimation:**

| Scenario | Workers | Pool/Worker | Total Connections |
|----------|---------|-------------|-------------------|
| Current (1 replica) | 2 | 10+20 | 30 |
| 1 replica, 4 workers | 4 | 10+20 | 30 (shared pool) |
| 2 replicas, 2 workers each | 4 | 10+20 each | 60 |
| 5 replicas, 2 workers each | 10 | 10+20 each | 150 |

**Recommendation:** At 2+ replicas, add PgBouncer for connection pooling. The current single-replica setup is fine for development.

---

## 24. Database Index Review

| Table | Existing Indexes | Missing for Shared Backend |
|-------|-----------------|---------------------------|
| users | `ix_users_email` (UNIQUE) | `ix_users_organization_id` |
| datasets | `ix_datasets_ward`, `ix_datasets_status` | `ix_datasets_organization_id`, `ix_datasets_project_id`, `ix_datasets_uploaded_by` |
| features | `idx_features_geom` (GIST), `idx_features_attributes_gin` (GIN), `ix_features_dataset_id`, `ix_features_category`, `ix_features_severity` | None critical |
| spatial_anomalies | `idx_spatial_anomalies_geom` (GIST), `ix_spatial_anomalies_dataset_type_color` | `ix_spatial_anomalies_organization_id` |
| activity_log | `ix_activity_log_actor_id`, `ix_activity_log_action`, etc. | `ix_activity_log_organization_id` |
| notifications | `ix_notifications_user_id`, `ix_notifications_source_id`, `ix_notifications_feature_id` | `ix_notifications_organization_id` |

---

## 25. PostGIS Scalability

**Current Usage:**
- SRID 4326 (WGS84) for all geometry
- GIST spatial indexes on features, spatial_anomalies, placemarks
- Bounding-box queries via `ST_MakeEnvelope` + `ST_Intersects`
- `ST_AsGeoJSON` for GeoJSON responses
- `ST_Extent` for dataset bounds
- Feature counts: unknown (code loads up to 5000 per query with hard limit)

**Recommendations for Scaling:**
- Current approach is adequate for single-municipality deployment
- For multi-municipality: consider partitioned tables by organization_id
- For large datasets (>100K features per org): add vector tile support
- Consider materialized views for dashboard analytics
- `ST_Subdivide` could help with very large polygons

---

## 26. Raster/LiDAR/3D Data Strategy

**Current Storage:**
- **GeoTIFF** → uploaded to MinIO, raster previews generated, tile rendering via GDAL
- **LAS/LAZ** → uploaded to MinIO, metadata extracted, CRS assigned post-upload
- **OBJ/MTL/textures** → uploaded as ZIP, extracted to MinIO, served via API proxy
- **Photos** → uploaded as dataset or per point-verification evidence
- Only metadata is stored in PostgreSQL; large files stay in MinIO ✅

**Recommendations:**
- For production: COG (Cloud Optimized GeoTIFF) format for raster delivery
- For point clouds: COPC LAZ for progressive streaming
- For 3D: 3D Tiles / glTF conversion for web-native delivery
- Current proxy-through-backend approach is fine for development but consider CDN for production

---

## 27. Current Caches and Shared State

| Cache/State | Location | Type | Survives Restart? | Works with Replicas? |
|-------------|----------|------|-------------------|---------------------|
| Rate limiter buckets | In-process memory (`_SlidingWindowCounter`) | Per-instance dict | ❌ | ❌ — each replica has its own counter |
| Ollama health probe cache | `service_health.monitoring_cache` | TTL cache | ❌ | ❌ — per-instance |
| Frontend user cache | `localStorage` (`davangere.user`) | Browser storage | ✅ | ✅ |
| CategoryClassMap | Database table | Persisted | ✅ | ✅ |
| WardCensus | Database table | Persisted | ✅ | ✅ |

**Issues for Shared Multi-Replica:**
- Rate limiter must move to Redis or database-backed store
- Health probe cache duplication across replicas is acceptable (low impact)
- In-memory caches for capability detection are fine (immutable after boot)

---

## 28. Authentication Scaling

**Current Model:**
- Stateless JWT (HS256 algorithm)
- Access token TTL: 1440 minutes (24 hours)
- Refresh token TTL: 7 days
- httpOnly cookies for token delivery
- Automatic refresh on 401 (frontend)

**Readiness for Shared Backend:**
- ✅ Stateless JWT works with multiple replicas
- ✅ httpOnly cookies prevent XSS token theft
- ❌ No session table for revocation
- ❌ No `jti` (JWT ID) for token tracking
- ❌ No token version for forced logout
- ❌ No organization context in JWT payload
- ❌ HS256 requires shared secret across replicas (use RS256 for production)

**Required Additions:**
- Session table with `user_id`, `organization_id`, `issued_at`, `expires_at`, `revoked_at`
- `jti` claim in JWT for session management
- `organization_id` claim in JWT
- Token versioning for password change/account deactivation
- Optional: RS256 for asymmetric signing

---

## 29. Authorization Architecture

**Current Model: Role-Based Access Control (RBAC)**
- Hardcoded roles: Admin, Architect, Commissioner, AEE, AE, MLA
- Role checks at router level via `Depends(require_roles(...))`
- No attribute-based or resource-based filtering

**Recommended Production Model: RBAC + ABAC + PostgreSQL RLS**
1. **RBAC** — roles determine operation types (read/write/admin)
2. **ABAC** — organization/ward/project attributes filter data access
3. **PostgreSQL RLS** — defense-in-depth for shared-schema queries

---

## 30. Tenancy Option Comparison

| Criteria | Option A: Shared Schema | Option B: Schema per Org | Option C: DB per Org | Option D: Current (Per-Deployment) |
|----------|------------------------|-------------------------|---------------------|------------------------------------|
| **Security Isolation** | Medium (app-level + RLS) | High (schema boundary) | Very High (DB boundary) | Highest (separate instances) |
| **Operational Complexity** | Low | Medium | High | Very High |
| **Cross-Org Analytics** | Easy | Difficult | Very Difficult | Impossible |
| **Migration Effort** | Low-Medium | Medium-High | High | N/A |
| **Backup Complexity** | Single DB | Per-schema | Per-DB | Per-instance |
| **Connection Pooling** | Single pool | Per-schema (complex) | Per-DB (wasteful) | Per-instance |
| **Cost Efficiency** | Best | Good | Poor | Worst |
| **Scalability** | Good (partitioning) | Good | Limited | Limited |
| **PostGIS Support** | Full | Full (per schema) | Full | Full |
| **Query Performance** | Best (no cross-DB) | Good | Good | Good |
| **SaaS Readiness** | ✅ Ready | ⚠️ Possible | ❌ Complex | ❌ |

**Recommendation: OPTION A — Shared Database + Shared Schema**

For the expected scale (1-10 municipalities, each with <100 users, <500 datasets, <500K features), shared schema with RLS provides the best balance of security, simplicity, and cost.

---

## 31. Recommended Tenancy Model

**Primary Recommendation: Shared Database + Shared Schema with RLS**

Rationale:
1. Current codebase already assumes shared tables — minimal migration
2. Single PostgreSQL instance is cheaper and simpler to operate
3. Cross-organization analytics (e.g., commissioner oversight) is straightforward
4. Row-Level Security provides database-enforced isolation as defense-in-depth
5. The application is currently single-org — the migration is adding columns, not restructuring the database
6. Backup/restore is a single operation
7. Future SaaS can use the same architecture with a `platform` super-user role

**Contingency Recommendation (if strict legal isolation required):**
Schema-per-organization, but only if regulations require physical data separation.

---

## 32. Proposed Core Entities

### Organization
```
Purpose: Represents a municipal corporation (e.g., Davangere Municipal Corporation)
Fields: id (UUID PK), name, slug, domain, is_active, created_at, updated_at
Relationships: Has many Users, Wards, Projects, Datasets
```

### Ward
```
Purpose: Administrative ward within a municipality
Fields: id (UUID PK), organization_id (FK), name, ward_number, geometry (MULTIPOLYGON, 4326), is_active, created_at
Relationships: Belongs to Organization
```

### Project
```
Purpose: A named survey/remediation project within an organization
Fields: id (UUID PK), organization_id (FK), name, description, status, start_date, end_date, created_at, updated_at
Relationships: Belongs to Organization, has many Datasets
```

### UserOrganizationMembership
```
Purpose: Links users to organizations with org-specific roles
Fields: id (UUID PK), user_id (FK), organization_id (FK), role, is_active, joined_at
Unique: (user_id, organization_id)
Relationships: Belongs to User and Organization
```

---

## 33. Required Scope Columns

| Existing Table | Current Scope | Required New Columns | Backfill Source | Risk |
|---------------|---------------|---------------------|-----------------|------|
| `users` | None | `organization_id` (nullable, default org) | Seed data all belongs to Davangere | Low — all current users same org |
| `datasets` | None | `organization_id`, `project_id` (nullable) | All datasets belong to default org/project | Low — straightforward |
| `features` | Via dataset | None (inherit from dataset) | — | Low |
| `spatial_anomalies` | None | `organization_id` (nullable) | Via dataset | Low |
| `point_verifications` | None | `organization_id` (nullable) | Via feature | Low |
| `review_items` | None | `organization_id` (nullable) | Via feature | Low |
| `comments` | None | None (inherit from feature) | — | Low |
| `placemarks` | `owner_id` | `organization_id` (nullable) | Owner's org | Medium — need user→org mapping |
| `notifications` | `user_id` | None (user-scoped already) | — | Low |
| `activity_log` | `actor_id` | `organization_id` (nullable) | Actor's org | Low |
| `survey_requests` | None | `organization_id` (nullable), `ward_id` (FK) | Via requester's org | Low |
| `ward_census` | None | `organization_id` (nullable, default) | Default org | Low |

---

## 34. Proposed Storage-Key Structure

**Current:** `datasets/{dataset_id}/{filename}`

**Proposed:** `organizations/{org_id}/datasets/{dataset_id}/{filename}`

**Full Pattern:**
```
organizations/{org_id}/
  projects/{project_id}/
    datasets/{dataset_id}/source/{filename}
    datasets/{dataset_id}/processed/{artifact}
    datasets/{dataset_id}/preview/{variant}.png
  tasks/{task_id}/evidence/before_{photo}.jpg
  tasks/{task_id}/evidence/after_{photo}.jpg
  reports/{report_id}/{filename}
  versions/{feature_id}/{version}/{filename}
```

---

## 35. Proposed API Tenant Context

**Strategy: JWT-embedded organization ID + header propagation**

1. JWT contains `org_id` claim (default organization for the user)
2. Optionally, frontend sends `X-Organization-ID` header for multi-org users
3. Backend never trusts client-provided org_id without validating membership
4. All endpoints automatically scope queries to the user's organization

**URL Pattern Options (recommend: NOT in URL):**
- `GET /api/v1/organizations/{org_id}/datasets` — verbose, REST-purist
- `GET /api/v1/datasets` — with `X-Organization-ID` header — preferred (simpler)

---

## 36. Configuration Scope Model

| Setting | Current | Should Become |
|---------|---------|---------------|
| Upload limit (2 GB) | Global `MAX_UPLOAD_BYTES` | Platform-wide (acceptable) |
| AI model name | `ollama_model` in Settings | Organization-configurable |
| Map defaults | Frontend env vars | Organization-level config |
| Storage bucket | Single bucket name | Org-prefixed keys within bucket |
| Ward list | Derived from dataset data | Ward entity per organization |
| Language | Frontend `LanguageContext` | User preference |
| Report templates | Hardcoded in code | Organization-configurable |
| Workflow rules | Hardcoded in code | Organization-configurable (future) |

---

## 37. User-Specific Experience

| Role | Current View | Future View in Shared Backend |
|------|-------------|-------------------------------|
| `admin` | All data | All organizations (platform admin) OR own organization |
| `architect` | All data | Own organization's datasets and reviews |
| `commissioner` | All data | Own municipality's/org's workflows |
| `aee` | All data | Own org's pending approvals |
| `ae` | All data | Own org's assigned field tasks |
| `mla` | All data | Own org's read-only view |

**Key Principle:** No user sees data from outside their organization unless they hold a cross-org role (platform admin).

---

## 38. Platform Admin vs Organization Admin

**Current: Single `admin` role** — acts as both platform and organization admin.

**Recommended Separation:**

| Role | Scope | Responsibilities |
|------|-------|-----------------|
| `PLATFORM_ADMIN` | All organizations | System config, user management, billing, cross-org monitoring |
| `ORG_ADMIN` | One organization | Org-level user management, dataset management, org settings |
| `SECURITY_ADMIN` | All organizations | Audit log review, security monitoring, incident response |
| `DATA_ADMIN` | One organization | Data imports, exports, quality management |

---

## 39. Target Deployment Architecture

```
                       ┌─────────────┐
                       │   Browser    │
                       └──────┬──────┘
                              │ HTTPS
                       ┌──────▼──────┐
                       │  Reverse    │
                       │   Proxy /   │
                       │ Load Balancer│
                       └──────┬──────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
       ┌──────▼──────┐  ┌─────▼──────┐  ┌─────▼──────┐
       │  Frontend   │  │  Backend   │  │  Backend   │
       │  (CDN)      │  │  Replica 1 │  │  Replica N │
       └─────────────┘  └─────┬──────┘  └─────┬──────┘
                              │               │
                    ┌─────────┴─────────────────┴──┐
                    │            Redis             │
                    │   (Cache, Rate Limiter,      │
                    │    Session Store, Pub/Sub)    │
                    └─────────┬────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
  ┌─────▼──────┐       ┌──────▼──────┐       ┌──────▼──────┐
  │ PostGIS    │       │  MinIO/S3   │       │ Job Queue   │
  │ (Managed)  │       │ (Managed)   │       │ (Redis/DB)  │
  └────────────┘       └─────────────┘       └──────┬──────┘
                                                     │
                                              ┌──────▼──────┐
                                              │   Worker    │
                                              │   Replicas  │
                                              └─────────────┘
                              ┌─────────────┐
                              │  Ollama AI  │
                              │  (GPU Node) │
                              └─────────────┘
```

---

## 40. Database High Availability

**Required for Production:**
- ✅ Managed PostgreSQL (AWS RDS, Azure DB, or Cloud SQL for PostGIS)
- ✅ Point-in-Time Recovery (PITR) — 7-30 day window
- ✅ Automated daily backups
- ✅ Read replicas for analytics queries (optional, based on load)
- ✅ Connection pooling (PgBouncer or RDS Proxy)
- ❌ Primary-replica failover (not configured — single instance currently)

---

## 41. Object Storage Strategy

| Factor | Development | Production (Pilot) | Production (Multi-Org) |
|--------|-------------|-------------------|----------------------|
| **Storage** | Local MinIO | Managed MinIO / S3 | Amazon S3 / Azure Blob |
| **Bucket Structure** | Single bucket | Single bucket + prefixes | Bucket-per-env + prefixes |
| **Backup** | None | S3 versioning + lifecycle | Cross-region replication |
| **Access** | Backend proxy | Backend proxy + CDN | Presigned URLs + CDN |

---

## 42. Security and Compliance

| Control | Current Status | Required for Shared Backend |
|---------|---------------|----------------------------|
| Encryption in transit | ❌ (no HTTPS in dev) | ✅ TLS everywhere |
| Encryption at rest | ❌ (not configured) | ✅ S3 SSE + Postgres TDE |
| Tenant data isolation | ❌ (all data shared) | ✅ Organization-scoped + RLS |
| Least privilege | ⚠️ (role-based only) | ✅ ABAC + org scope |
| Audit logging | ✅ (ActivityLog) | ✅ Enhanced with org context |
| Data retention | ❌ (no policy) | ⚠️ Policy needed |
| Evidence photos | ⚠️ (stored, no EXIF stripping) | ✅ EXIF sanitization |
| Backup/restore | ❌ (no automated backup) | ✅ Automated daily + PITR |
| Secrets management | ❌ (.env file) | ✅ Secrets manager |

---

## 43. Backup and Recovery

**Current: No automated backup configured.**

**Proposed:**
| Resource | Backup Method | RPO | RTO | Retention |
|----------|---------------|-----|-----|-----------|
| PostgreSQL | pg_dump + WAL archiving | 5 min (WAL) | 1 hour | 30 days daily, 12 monthly |
| MinIO/S3 | S3 versioning | Instant (versioning) | 1 hour | 30 days + lifecycle |
| Environment | Terraform/Infra-as-Code | Git history | 30 min | Git history |
| AI models | Ollama export (model files) | Per-model | 2 hours | Per-release |

---

## 44. Monitoring and Observability

| Capability | Current | Required |
|------------|---------|----------|
| API health | ✅ /api/health, /api/ready | ✅ Keep + add /api/metrics (Prometheus) |
| Database | ✅ PostGIS probe | ✅ Keep |
| Object storage | ✅ Bucket head + list count | ✅ Keep |
| AI | ✅ ollama list probe | ✅ Keep |
| Request IDs | ❌ Not configured | ✅ Add middleware for request_id header |
| Structured logging | ⚠️ stdout text | ✅ JSON logging with org/user fields |
| Metrics endpoint | ❌ Not configured | ✅ Prometheus /metrics |
| Dashboards | ❌ Not configured | ✅ Grafana dashboards |
| Alerts | ❌ Not configured | ✅ Alertmanager for critical failures |
| Distributed tracing | ❌ Not configured | ✅ OpenTelemetry (future) |

---

## 45. Existing Data Migration

**Migration Strategy — Staged Approach:**

**Stage 1: Add entities and nullable columns**
- Create `organizations` table
- Create `wards` table (with geometry from census data or manual import)
- Create `projects` table
- Create `user_organization_memberships` table
- Add nullable `organization_id` to datasets, spatial_anomalies, point_verifications, etc.

**Stage 2: Backfill**
- Create default organization "Davangere Municipal Corporation"
- Assign all existing users to default organization
- Set `organization_id` on all existing records to default org
- Migrate ward strings to `wards` table where possible

**Stage 3: Validation**
- Verify every record has an `organization_id`
- Validate ward references are consistent

**Stage 4: Enforce**
- Make `organization_id` NOT NULL
- Add foreign key constraints
- Create composite indexes

---

## 46. Zero-Downtime Migration Plan

| Step | Action | Downtime | Rollback |
|------|--------|----------|----------|
| 1 | Add `organizations` table | None | DROP TABLE |
| 2 | Add nullable scope columns | None | ALTER DROP COLUMN |
| 3 | Deploy updated backend (writes scope, reads ignore if null) | Rolling | Revert backend |
| 4 | Backfill existing rows | None (background) | Re-run backfill |
| 5 | Add NOT NULL constraints | Brief lock | DROP constraint |
| 6 | Deploy updated frontend (org context) | Rolling | Revert frontend |
| 7 | Add RLS policies | None | DROP POLICY |
| 8 | Remove legacy code paths | None | Revert code |

---

## 47. Feature Compatibility Matrix

| Feature | Tables Used | Scope Required | Migration Risk | Testing Required |
|---------|-------------|---------------|----------------|------------------|
| Login | users | Org membership lookup | Low | Login with/without org |
| Map view (features) | features, datasets | Dataset org filter | Medium | Bbox query scoped |
| Dataset upload | datasets, MinIO | Org assignment | Low | Upload with org |
| Dataset list | datasets | WHERE org_id = | Low | List filtered by org |
| Analytics | features, datasets | All queries need org join | Medium | Cross-org vs own-org |
| AI query | features | Feature org check | Medium | AI context scoped |
| AI report | features | Dataset org filter | Medium | Report scoped |
| Spatial audit | features, spatial_anomalies | Dataset org filter | Medium | Audit within org |
| Point verification | point_verifications, features | Feature org check | Low | WF within org |
| Notifications | notifications | Already user-scoped | None | Already works |
| Placemarks | placemarks | Owner org filter | Low | Show own org's |
| Activity log | activity_log | Actor org filter | Low | Admin sees cross-org |
| Admin dashboard | Multiple | ORG_ADMIN vs PLATFORM_ADMIN | Medium | Role-dependent |

---

## 48. Capacity and Performance Gaps

| Dimension | Current Estimate | Production Requirement | Gap |
|-----------|-----------------|----------------------|-----|
| Users | 6 seeded | 50-500 per org | Need user management UI |
| Datasets | Unknown | 100-1000 per org | Need org-scoped listing |
| Features | Unknown | 10K-500K per org | Need partitioning strategy |
| Concurrent requests | 1-5 | 10-50 | Need connection pooling |
| Storage per dataset | 0-2 GB | 10GB-1TB (raster/LiDAR) | Adequate with MinIO |
| AI concurrency | 1 at a time | 1-5 | Need request queueing |
| Background jobs | 1-2 at a time | 5-20 | Need dedicated workers |

---

## 49. Current Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Docker Compose                                  │
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐    ┌───────────┐  │
│  │   Frontend   │◄──►│   Backend    │◄──►│   PostGIS    │    │   MinIO   │  │
│  │  (React,     │    │ (FastAPI,    │    │  (Spatial)   │    │(Object    │  │
│  │   port 3000) │    │  port 8001)  │    │  port 5432   │    │ Storage)  │  │
│  └──────────────┘    └──────┬───────┘    └──────────────┘    └─────┬─────┘  │
│                             │                                      │        │
│                             │          ┌──────────────┐            │        │
│                             └──────────►   Ollama AI  │            │        │
│                                        │  (port 11434)│            │        │
│                                        └──────────────┘            │        │
│                                                                             │
│  Networks: urban_net (bridge)                                               │
│  Volumes: postgis_data, minio_data, ollama_data                             │
└─────────────────────────────────────────────────────────────────────────────┘

User Data Flow:
  Browser → Frontend (React) → HTTP (cookie-based JWT) → Backend (FastAPI)
    → Read/Write: PostgreSQL/PostGIS (async SQLAlchemy)
    → File Upload: MinIO (boto3)
    → AI Queries: Ollama (HTTP)

Authentication:
  Client Cookie (access_token) → Backend decodes JWT → Extracts user_id + role
  → Database query for User → Role guard → Endpoint handler

Authorization:
  require_roles(ADMIN, COMMISSIONER, AEE, AE, MLA, ARCHITECT)
  → Check user.role in allowed list → 403 if not allowed
```

---

## 50. Target Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Production Deployment                                │
│                                                                             │
│  ┌──────────┐    ┌──────────────┐                                           │
│  │  CDN /   │    │ Load Balancer│                                           │
│  │  Static  │    │  (TLS Term)  │                                           │
│  └────┬─────┘    └──────┬───────┘                                           │
│       │                 │                                                    │
│       │          ┌──────▼───────┐                                            │
│       │          │  Frontend    │                                            │
│       │          │  (React SPA) │                                            │
│       │          └──────┬───────┘                                            │
│       │                 │                                                    │
│       │          ┌──────▼───────┐    ┌──────────────┐    ┌───────────────┐  │
│       │          │  Backend     │◄──►│    Redis     │    │   Worker(s)   │  │
│       │          │  Replica 1..N│    │ (Cache/Queue)│    │ (Ingestion/   │  │
│       │          └──────┬───────┘    └──────┬───────┘    │  AI Jobs)     │  │
│       │                 │                    │           └───────┬───────┘  │
│       │          ┌──────▼───────┐           │                   │          │
│       │          │  PgBouncer   │           │                   │          │
│       │          │  (Pooling)   │           │                   │          │
│       │          └──────┬───────┘           │                   │          │
│       │                 │                   │                   │          │
│  ┌────▼────┐    ┌──────▼───────┐    ┌──────▼───────┐    ┌──────▼───────┐  │
│  │ Frontend│    │   PostGIS    │    │  MinIO/S3    │    │   Ollama AI  │  │
│  │ CDN     │    │  (Managed)   │    │  (Managed)   │    │  (GPU Node)  │  │
│  └─────────┘    └──────────────┘    └──────────────┘    └──────────────┘  │
│                                                                             │
│  Organization/Tenant Context flows through:                                 │
│    JWT (org_id) → Backend middleware → All SQL queries filter by org_id     │
│    MinIO key prefix: organizations/{org_id}/datasets/{dataset_id}/...       │
│    PostgreSQL RLS: org_id = current_setting('app.org_id')                   │
│                                                                             │
│  Monitoring: Prometheus + Grafana + Sentry + Structured Logging             │
│  Backup: Daily pg_dump + WAL archiving + S3 Versioning                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 51. Architecture Decision Record

**Title:** Unified Shared Backend and Data Platform for Davangere Smart Urban Survey

**Context:**
The application currently serves a single municipality (Davangere) with a single-tenant architecture. Future requirements may include supporting multiple municipalities, organizations, or projects within a single deployment.

**Decision:**
Adopt **Option A — Single Shared Database with Shared Schema** for the unified backend architecture.

**Rationale:**
1. Current codebase is already structured as shared tables — minimal migration
2. Expected scale (1-10 orgs, <500 users, <500K features) does not require schema-per-org
3. Cross-org analytics and platform admin oversight are straightforward
4. Row-Level Security provides defense-in-depth isolation
5. Single PostgreSQL instance is simpler to backup, manage, and scale
6. Cost-effective for SaaS deployment

**Risks:**
1. SQL bugs could leak data across organizations (mitigated by RLS + tests)
2. Large shared indexes could impact performance (mitigated by partitioning)
3. Single database is a single point of failure (mitigated by managed DB with HA)

**Rejected Options:**
- **Schema-per-Org:** Over-engineered for current scale; complex migrations
- **DB-per-Org:** Operational nightmare; expensive; cross-org analytics impossible
- **Per-Deployment:** Cannot support multi-municipality or SaaS goals

---

## 52. Safe-to-Keep List

| Component | Reason |
|-----------|--------|
| JWT authentication pattern | Stateless, works with replicas, httpOnly cookies |
| Role-based access control | Core guard mechanism, extendable with org scope |
| SQLAlchemy async session pattern | Works well with connection pooling |
| PostGIS + GeoAlchemy2 spatial stack | Proven, scalable, standard |
| MinIO/S3 storage abstraction | Works, just needs key prefix update |
| Backend-proxied file serving | Works, no presigned URL complexity |
| AI grounding pattern (deterministic context + LLM narrative) | Prevents hallucination, works |
| ActivityLog audit table | Already comprehensive |
| Notification model (user-scoped) | Already works for single-user |
| Placemark model (owner-scoped) | User-specific by design |
| Frontend API client with cookie auth | Works with any backend URL |
| Frontend React + MapLibre stack | Standard, well-supported |
| Docker Compose deployment | Works for pilot and single-org |
| Health check probes on all services | Production best practice |
| Idempotent init_db + seed scripts | Safe to run on every boot |
| Dataset ingestion pipeline architecture (upload → queue → process) | Extensible pattern |
| Spatial audit engine (deterministic PostGIS rules) | No user data boundary needed |
| Manhole recommendation (graph-based, deterministic) | No user data boundary needed |

---

## 53. Must-Extend List

| Component | Extension Required |
|-----------|-------------------|
| User model | Add organization_id, multi-ward membership, token_version |
| Dataset model | Add organization_id, project_id |
| All scope-filtered endpoints | Add organization_id WHERE clauses to all queries |
| JWT payload | Add org_id, jti claims |
| API deps (get_current_user) | Load organization context, validate org membership |
| MinIO storage key structure | Add organization prefix: `organizations/{org_id}/...` |
| Frontend AuthContext | Add organization/project state, multi-org support |
| Frontend API client | Optionally add X-Organization-ID header |
| ActivityLog | Add organization_id column for filtered audit |
| PointVerification | Add organization_id for org-scoped workflows |
| SpatialAnomaly | Add organization_id for org-scoped audit findings |
| ReviewItem | Add organization_id for org-scoped reviews |
| SurveyRequest | Add organization_id, ward_id (FK) |
| Ward handling | Promote from string to FK entity (wards table) |
| Configuration settings | Make org-specific settings loadable from DB |
| Seed script | Create default organization, associate seeded users |

---

## 54. Must-Replace List

| Component | Reason | Replacement |
|-----------|--------|-------------|
| In-memory rate limiter | Per-instance state, fails with replicas | Redis-based rate limiter |
| BackgroundTasks for ingestion | Non-durable, duplicates with replicas | DB-backed job queue + worker container |
| HS256 JWT signing | Shared secret, no key rotation | RS256 asymmetric signing |
| localStorage user cache | No org context, survives logout | Add org to cache, clear on logout |
| Ward as plain string | No referential integrity, no geometry | FK to wards table |
| Global dataset listing | Returns all datasets regardless of user | Filter by user's org |
| Flat MinIO key pattern | No org scope | Prefix with org_id |
| Hardcoded role list | No custom roles, no org-specific roles | Store roles in DB with org context |
| No refresh token registry | Cannot revoke sessions | Session table + jti tracking |
| No request ID middleware | Cannot correlate logs | Add request_id middleware |
| Non-structured logging | Hard to parse/filter | JSON structured logging |

---

## 55. Open Business Questions

1. **Will only Davangere use this platform?**
   - If yes: simpler migration (single org, just add structure)
   - If no: need full multi-org support from the start

2. **Can users belong to multiple wards?**
   - Needed for AEE/Commissioner who oversee multiple wards
   - Requires many-to-many User↔Ward mapping

3. **Can users belong to multiple organizations?**
   - Rare but possible (e.g., consultant works for multiple municipalities)
   - Requires organization selection UI and context switching

4. **Are datasets private, shared, or city-wide by default?**
   - Current: city-wide (all users see all)
   - Future: org-scoped (only org members see org's datasets)
   - Option for cross-org sharing?

5. **Should Platform Admin see all data?**
   - Required for support, compliance, cross-org analytics
   - Must be audited and logged

6. **Is strict municipality isolation legally required (data residency)?**
   - If yes → Option B (schema-per-org) may be required
   - If no → Option A (shared schema) is fine

7. **Expected feature and storage volumes?**
   - Need real measurements before production sizing
   - Estimate: 10-100 datasets per org, 10K-500K features, 1GB-1TB storage

8. **What uptime is required?**
   - Government system: 99.5% (≈44 hours/year downtime) is typical
   - 99.9% (≈9 hours/year) is aspirational but requires HA setup

9. **What RPO and RTO are required?**
   - RPO: 5-15 minutes (near-real-time backup via WAL)
   - RTO: 1-4 hours (restore from backup + verification)

10. **Will there be a public-facing component?**
    - MLA read-only access suggests some public/constituent-facing features
    - Requires separate API surface and authentication model

---

## 56. Recommended Implementation Phases

### Phase 0: Foundation (2 weeks)
- Create `organizations`, `wards`, `projects`, `user_organization_memberships` tables
- Add nullable scope columns to all existing tables
- Create default organization and backfill all existing data
- Update seed script to create default org and assign seeded users

### Phase 1: Backend Authorization (2 weeks)
- Update JWT to include `org_id` claim
- Add organization context loading to `get_current_user` dependency
- Add `user_organization_memberships` validation
- Update all data-read endpoints to filter by organization
- Update all data-write endpoints to assign organization

### Phase 2: Storage & AI Isolation (1 week)
- Update MinIO key pattern to include organization prefix
- Update file delete/cleanup to use new key pattern
- Update AI context builders to accept organization scope
- Validate feature_id access checks in AI endpoints

### Phase 3: Frontend Context (1 week)
- Update AuthContext to carry organization info
- Add organization selector for multi-org users
- Update all page-level API calls to forward org context
- Ensure localStorage cache includes org context

### Phase 4: Hardening & RLS (2 weeks)
- Make scope columns NOT NULL
- Add composite indexes on (org_id, ...) for all query patterns
- Implement PostgreSQL Row-Level Security
- Create Org Admin and Platform Admin separation
- Add PgBouncer or connection pooling

### Phase 5: Job Queue & Observability (2 weeks)
- Implement database-backed job queue
- Create dedicated worker container
- Add Prometheus metrics endpoint
- Implement structured JSON logging with org context
- Add request-id middleware

### Phase 6: Migration & Cutover (1 week)
- Zero-downtime data migration for any remaining records
- Feature compatibility testing across all endpoints
- Performance testing with production-scale data
- Rollback plan validation

---

## 57. Files Inspected

| # | File | Purpose |
|---|------|---------|
| 1 | `docker-compose.yml` | Service definitions, networks, volumes, env vars |
| 2 | `backend/Dockerfile` | Backend image build |
| 3 | `frontend/Dockerfile` | Frontend multi-stage build |
| 4 | `backend/requirements.txt` | Python dependencies |
| 5 | `backend/entrypoint.sh` | Backend startup (wait DB, seed, exec) |
| 6 | `backend/init.sql` | PostGIS extension bootstrap |
| 7 | `backend/seed.py` | User seed script (6 seeded users) |
| 8 | `backend/app/main.py` | FastAPI app factory, lifespan, CORS, middleware |
| 9 | `backend/app/core/config.py` | Pydantic settings, MAX_UPLOAD_BYTES |
| 10 | `backend/app/core/security.py` | bcrypt + JWT helpers |
| 11 | `backend/app/core/middleware.py` | Rate limiting, CSRF, body size, security headers |
| 12 | `backend/app/db/init_db.py` | Schema bootstrap, spatial index creation |
| 13 | `backend/app/db/session.py` | Async engine + session factory (pool_size=10, max_overflow=20) |
| 14 | `backend/app/db/base.py` | DeclarativeBase |
| 15 | `backend/app/api/deps.py` | get_current_user, require_roles guards |
| 16 | `backend/app/api/v1/router.py` | All route registrations |
| 17 | `backend/app/api/v1/auth.py` | Login, logout, me, refresh |
| 18 | `backend/app/api/v1/datasets.py` | Upload, list, get, update, delete, features, bounds |
| 19 | `backend/app/api/v1/features.py` | Viewport query, table, categories, versions, activity |
| 20 | `backend/app/api/v1/analytics.py` | Overview, quality, features, export, water-demand |
| 21 | `backend/app/api/v1/ai.py` | Query, report, recommend, spacing, audit, manhole |
| 22 | `backend/app/api/v1/admin.py` | Services, datasets, workflows, activity, security |
| 23 | `backend/app/api/v1/health.py` | Health + readiness probes |
| 24 | `backend/app/models/user.py` | User model + UserRole enum |
| 25 | `backend/app/models/dataset.py` | Dataset model + status/file type enums |
| 26 | `backend/app/models/feature.py` | Feature model (GEOMETRY, 4326) |
| 27 | `backend/app/models/activity_log.py` | ActivityLog + ActivityAction enum |
| 28 | `backend/app/models/notification.py` | Notification + NotificationSource enum |
| 29 | `backend/app/models/point_verification.py` | PointVerification + workflow enums |
| 30 | `backend/app/models/spatial_anomaly.py` | SpatialAnomaly + anomaly enums |
| 31 | `backend/app/models/comment.py` | Comment (threaded) |
| 32 | `backend/app/models/placemark.py` | Placemark (user-owned map markers) |
| 33 | `backend/app/models/review_item.py` | ReviewItem + priority/status enums |
| 34 | `backend/app/models/survey_request.py` | SurveyRequest + status enum |
| 35 | `backend/app/models/feature_version.py` | FeatureVersion + version tracking |
| 36 | `backend/app/models/ward_census.py` | WardCensus + CityCensusSummary |
| 37 | `backend/app/models/category_class_map.py` | CategoryClassMap |
| 38 | `backend/app/services/storage.py` | MinIO/S3 abstraction |
| 39 | `frontend/package.json` | Frontend dependencies |
| 40 | `frontend/vite.config.ts` | Vite config with API proxy |
| 41 | `frontend/src/App.tsx` | React routing + providers |
| 42 | `frontend/src/main.tsx` | React entry point |
| 43 | `frontend/src/context/AuthContext.tsx` | Auth state management |
| 44 | `frontend/src/lib/api.ts` | API client with cookie auth |

---

## 58. Read-Only Confirmation

✅ **No application code, schema, Docker configuration, or data was modified during this investigation.**

✅ **No credentials, passwords, tokens, or secrets have been exposed in this report.**

✅ **All observations are based exclusively on file inspection and static code analysis.**

✅ **No database queries were executed against a running instance.**

✅ **No Docker containers were started, stopped, or modified.**

✅ **No Git operations were performed.**

---

*End of Architecture Investigation Report*

