# AE Tasks + AEE Activity Update

This update restores the two role pages requested after the main Layer Review and approval-workflow integration.

## AE-only Tasks

- Visible only to the signed-in AE.
- Reads the AE's own remediation records from PostgreSQL through the backend API.
- Shows Work in Progress, Returned by AEE, Waiting for AEE, AEE Approved and Commissioner Accepted states.
- Opens the exact map workflow using the permanent `verification_id`.
- Refreshes automatically every 30 seconds and after workflow notification changes.

## AEE-only Activity

- Visible only to AEE.
- Shows live AE remediation activity and the full approval trail.
- Highlights records requiring AEE action.
- Opens the exact AEE review form using `verification_id`.
- Keeps completed and returned records available as history.

## Important architecture rules

- The colleague's existing notification bell is preserved.
- Tasks and Activity do not create a second approval or notification system.
- `assignedWork.ts` and `davangere.assignedWork` localStorage are not used.
- The map, bell, Tasks and Activity all read the same backend workflow record.
- No floating AEE Approval, Commissioner, or Remediation Updates panel is introduced.
- Layer Review, GDB, Analytics, Grievance, 3D, raster, AI, Architect/Admin, MLA and other colleague features remain present.

## Compatibility included

`DatasetFileType.LAS` is retained so an existing PostGIS volume containing LAS rows does not make `/api/v1/datasets` fail.

## Run

1. Copy `.env.example` to `.env`, or copy the working `.env` from the current deployment.
2. Confirm ADMIN, ARCHITECT, COMMISSIONER, AEE, AE and MLA seed variables exist.
3. Run:

```powershell
docker compose up -d --build --force-recreate
```

4. Verify:

```powershell
docker compose ps
Invoke-WebRequest "http://localhost:8001/api/health" -UseBasicParsing
```

5. Open `http://localhost:3000` and hard refresh with `Ctrl + Shift + R`.
