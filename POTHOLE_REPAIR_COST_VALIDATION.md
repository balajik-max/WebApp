# Pothole Repair-Cost Validation

## Base

- Base commit: `b220cfc` (`Sub_Master` / merged colleague features)
- Local integration branch: `feature/pothole-repair-cost`
- No remote branch was changed or pushed.

## Scope isolation

The integration changes only the pothole-cost path:

- `.env.example`
- `backend/app/core/config.py`
- `backend/app/services/surface_issue_audit.py`
- `backend/app/api/v1/ai.py`
- `backend/tests/test_surface_issue_audit_rules.py`
- `frontend/src/components/AnomalyAlertCard.tsx`
- `frontend/src/index.css`
- pothole integration/validation documentation

No map renderer, OBJ renderer, GeoTIFF renderer, Quick Analysis component, Layer Review component, workflow component, Standing Water dashboard, authentication component, or database model was replaced.

## Behaviour

- Runs only for `pothole_status` anomalies.
- Uses mapped `area_sqm` and a configured rate per square metre.
- Stores the rate, source, year, item code, calculation basis, recommended repair method and estimated cost with the generated pothole anomaly.
- Displays the result in the right-side **Pothole Condition** card before **Urban Planning Solution**.
- Adds the same facts to the pothole AI explanation / solution context.
- Refuses to calculate when area or rate is unavailable.
- Labels the amount as a preliminary estimate.

## Checks completed in the integration environment

- Python `compileall`: PASS
- Repair-cost helper execution for the supplied sample values: PASS
- Expected sample result `3.4491 m² x 426 = INR 1,469.32`: PASS
- Missing-area refusal: PASS
- TypeScript/TSX syntax parse for `AnomalyAlertCard.tsx`: PASS
- `git diff --check`: PASS
- Key colleague feature files present (Quick Analysis, 3D, OBJ, Street View, Urban Planning, Pothole/Standing Water dashboards, raster tiles): PASS

## Checks still required on the Windows target machine

The integration environment has no Docker daemon and no network access to install frontend dependencies. Complete these before accepting the deployment:

```powershell
docker compose config --quiet
docker compose build --no-cache frontend backend
docker compose up -d --force-recreate frontend backend
docker compose ps
```

Then rerun the spatial audit for the existing GDB and verify:

- Pothole card shows the cost block.
- Standing Water and all other anomaly cards do not show it.
- Quick Analysis, 3D, OBJ, GeoTIFF, Layer Review, Street View, login and AE/AEE/Commissioner workflow remain functional.
- Browser console and backend logs contain no new errors.
