# Merged WebApp Validation Checklist

## Checks completed during merge

- [x] Colleague project used as the merge base.
- [x] User project applied through a three-way source merge.
- [x] All merge conflicts resolved.
- [x] No Git conflict markers remain.
- [x] `git diff --check` passes.
- [x] 126 frontend TypeScript/TSX files parse with zero syntax errors.
- [x] Offline TypeScript diagnostics were compared with the colleague base using identical dependency stubs; no new missing-identifier or missing-object-key class of error was introduced by the merge.
- [x] Backend Python `compileall` passes. A pre-existing `SyntaxWarning` remains in `backend/app/services/dag_cycle_breaker.py` and is unrelated to this merge.
- [x] `docker-compose.yml` parses as YAML and contains the expected `db`, `storage`, `ai_engine`, `backend` and `frontend` services.
- [x] Surface layer-classifier tests pass: 3 tests.
- [x] Surface severity-rule tests pass: 4 tests.
- [x] Surface approved-dashboard calculation smoke tests pass for pothole depth/volume/span/map link and standing-water area band/volume.
- [x] Detection-mode maps are exhaustive for Poles, Drains, Manholes, Roads, Powerlines, Potholes and Standing Water.
- [x] Anomaly labels are exhaustive for all seven anomaly types.
- [x] Backend audit enum/summary/API response include Powerline, Pothole and Standing Water findings.
- [x] Layer Review isolation, surface recommendation, surface 3D and Powerlines source signatures are present.
- [x] Existing Urban Planning Solution action remains available on ordinary anomaly cards.

## Checks not possible in the merge environment

The merge environment has no Docker daemon, no installed frontend `node_modules`, and no internet access to download packages. Therefore these checks must be completed on the target machine:

- [ ] `yarn install --frozen-lockfile`.
- [ ] Full `tsc -b && vite build`.
- [ ] `docker compose config`.
- [ ] `docker compose up -d --build`.
- [ ] Backend database startup and migrations against the target persistent volume.
- [ ] Browser-based functional and visual regression.
- [ ] Role-based workflow with real AE, AEE and Commissioner accounts.
- [ ] Performance/RAM behavior using the target datasets.

## Windows PowerShell build commands

Run from the extracted merged project root:

```powershell
Copy-Item ".\.env.example" ".\.env" -Force

docker compose config
if ($LASTEXITCODE -ne 0) { throw "docker compose config failed" }

docker compose down --remove-orphans

docker compose up -d --build
if ($LASTEXITCODE -ne 0) { throw "docker compose build/start failed" }

docker compose ps
```

Check recent logs:

```powershell
docker compose logs --tail 150 frontend
docker compose logs --tail 150 backend
docker compose logs --tail 100 ai_engine
```

For a direct frontend check outside Docker:

```powershell
cd .\frontend
corepack enable
yarn install --frozen-lockfile
yarn build
```

## Required browser regression

### Existing colleague functionality

- [ ] Login and logout work for all configured roles.
- [ ] Existing datasets load and multi-selection works.
- [ ] GDB, raster, DSM/DTM, image and OBJ datasets retain their existing renderers.
- [ ] Layer Review loads, saves classifications and opens dashboards.
- [ ] Existing approved dashboards render without missing cards or runtime errors.
- [ ] Quick Analysis cards and their map overlays work.
- [ ] Placemark, measurement, coordinate search, reference layers and Street View work.
- [ ] Poles AI mode retains its original markers, anomaly details and ON/OFF behavior.
- [ ] Drains AI mode retains building encroachment colors and click details.
- [ ] Manholes AI mode retains heatmap, anomaly details and recommendation/network behavior.
- [ ] Roads and Road Inspection retain line findings and reports.
- [ ] Powerlines AI mode retains building-proximity colors, click details and 3D context.
- [ ] Urban Planning Solution remains available for ordinary anomaly cards.
- [ ] Mobile and desktop layouts remain usable.

### Layer Review / View on Map

- [ ] Select a dashboard/Layer Review row and click View on Map.
- [ ] Only the target remains highlighted while the basemap stays visible.
- [ ] A layer manually hidden before isolation remains hidden after exit.
- [ ] Clicking the target keeps the isolated view and opens details.
- [ ] Clicking elsewhere once with the left mouse button restores the full prior map.
- [ ] Previous camera, datasets, category visibility and 3D-building state are restored.
- [ ] No right-click action is required.

### Potholes 2D

- [ ] Select Potholes mode: only the intended surface class is focused.
- [ ] With AI OFF, the original category visualization is shown without severity glow.
- [ ] With AI ON, green/yellow/red findings use the exact original geometry.
- [ ] Resolved findings display blue after refresh.
- [ ] Clicking a finding opens AI Pothole Recommendation.
- [ ] Card values match persisted audit/GDB values; missing values show unavailable.
- [ ] View affected feature in 3D opens the same location.
- [ ] Switching OFF exits Potholes focus and restores all normal GDB classes.

### Standing Water 2D

- [ ] Select Standing Water mode and test OFF/ON behavior.
- [ ] Fill, boundary and glow follow the exact original GDB geometry.
- [ ] Resolved findings display blue after refresh.
- [ ] Clicking a finding opens AI Standing Water Recommendation.
- [ ] Area, road/drain proximity and recommendation match persisted metadata.
- [ ] Switching OFF restores all normal GDB classes.

### 3D

- [ ] Existing terrain, buildings, roads, poles, drains, manholes and powerlines still render.
- [ ] Existing underground and heatmap controls still work.
- [ ] Pothole Point/MultiPoint/Polygon/MultiPolygon geometry is visible at the corresponding 2D location.
- [ ] Potholes are not hidden below the road ribbon.
- [ ] Standing Water appears at the same north/south/east/west location as 2D.
- [ ] Polygon holes and MultiPolygon parts are retained.
- [ ] Selected + Roads shows terrain, roads and selected surface class.
- [ ] All Classes restores all 3D classes while keeping the selected issue emphasized.
- [ ] Click details show the correct Pothole/Standing Water recommendation values.
- [ ] Green/yellow/red/blue colors match the 2D status.

### AE → AEE → Commissioner

- [ ] Start remediation from a red/yellow Pothole finding.
- [ ] Start remediation from a red/yellow Standing Water finding.
- [ ] AE evidence/GPS validation and submission work.
- [ ] AEE approval/return works with remarks rules.
- [ ] Commissioner acceptance completes the workflow.
- [ ] Final accepted finding becomes blue in 2D and 3D after refresh and OFF→ON.
- [ ] Existing Pole, Drain and Manhole workflows remain unchanged.
- [ ] Powerline AI details do not incorrectly open an unsupported remediation request.

## Acceptance rule

Do not replace the working deployment until every mandatory build and browser item above passes. Keep the previous project folder and database-volume backup until acceptance is complete.
