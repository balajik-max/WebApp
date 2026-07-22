# Integrated All-Features V3 — Start Here

This package uses the user's current integrated software as the protected base and selectively adds the compatible features from `sanket-test-1`.

## Preserved from the protected base

- Existing map, datasets, analytics, grievance, 3D, OBJ, raster and measurement functions
- Layer Review and universal GDB dashboards
- AE-only Tasks and AEE-only Activity
- AE -> AEE -> Commissioner workflow
- MLA read-only access
- Existing unified notification bell and exact verification navigation
- Blue workflow point only after AEE approves Good in AI mode
- Legacy Architect/Admin workflow compatibility
- Existing LAS database-record compatibility

## Added from the colleague version

- Quick Analysis panel and map dashboards
- Drain encroachment analytics
- Road inspection and road-width findings
- Manhole recommendation, route display and 3D information
- Manhole and utility Quick Analysis overlays
- LAS/LAZ LiDAR inspection and metadata handling
- Optional official cadastral tile configuration

## Deliberately excluded

- Browser-only `assignedWork.ts` / `davangere.assignedWork` workflow
- Duplicate floating `RemediationUpdates.tsx` notification panel

The backend/PostGIS workflow remains the single source of truth for Tasks, Activity, approvals and notifications.

## Safe Windows setup

Do not overwrite the currently working folder. Extract this package into a new folder.

```powershell
# Stop the currently running project while preserving volumes
docker compose down
# Never use: docker compose down -v
```

Copy the `.env` from the currently working project into this new package root. The ZIP intentionally does not contain `.env`.

```powershell
docker compose config
docker compose up -d --build --force-recreate
Start-Sleep -Seconds 20
docker compose ps
Invoke-WebRequest "http://localhost:8001/api/health" -UseBasicParsing
```

Open `http://localhost:3000` and press `Ctrl + Shift + R`.

## Minimum live acceptance test

1. Existing datasets load without a new backend 500 error.
2. Layer Review opens and visualizes a ready GDB dataset.
3. Quick Analysis opens and closes without changing the normal map workflow.
4. Drain, road, manhole and utility Quick Analysis cards load their own data.
5. AE starts work and sees the backend task in Tasks.
6. AE submits evidence and AEE sees the same verification in Activity and the existing bell.
7. AEE Moderate/Bad returns the same record to AE.
8. AEE Good makes the point Blue only in AI mode and notifies Commissioner.
9. Commissioner accepts; AE and AEE receive final notifications.
10. MLA can view but cannot perform workflow actions.
11. LAS and LAZ uploads are accepted, while existing legacy LAS rows still load.
12. Existing map, datasets, analytics, grievance, 3D, OBJ and raster features still work.

See `LIVE_TEST_CHECKLIST_ALL_FEATURES.md` for the detailed checklist.
