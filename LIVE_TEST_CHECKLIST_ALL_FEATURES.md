# Live Test Checklist — All Features

Mark each item PASS/FAIL and record any error, browser console message or backend log line.

## A. Startup and compatibility

- [ ] All five services start.
- [ ] Backend, database, storage and AI report healthy.
- [ ] `GET /api/health` returns 200.
- [ ] Dataset list loads without `LookupError: LAS` or another 500.
- [ ] Existing uploaded datasets and object-storage files remain available.

## B. Existing base features

- [ ] Map opens and normal category colours work.
- [ ] Dataset selection and feature rendering work.
- [ ] Layer Review loads ready GDB datasets.
- [ ] Point, line and polygon GDB layers render and expose attributes.
- [ ] Layer decisions, zoom and exports work.
- [ ] Analytics, grievance, measurements and placemarks work.
- [ ] Raster/GeoTIFF, OBJ and 3D features work.
- [ ] Kannada/English, profile and logout work.

## C. Quick Analysis additions

- [ ] Quick Analysis opens only when requested.
- [ ] Closing it removes temporary overlays and restores the previous map state.
- [ ] Drain Encroachment loads and selects the correct features.
- [ ] Road Width / Road Inspection loads the selected road and findings.
- [ ] Manhole Detail loads recommendations and route/connection overlays.
- [ ] Utility Tracker loads utility assets without altering workflow data.
- [ ] Quick Analysis does not create localStorage tasks or another notification panel.
- [ ] Map remains responsive with Quick Analysis closed.

## D. LiDAR compatibility

- [ ] Existing database records with file type `LAS` load.
- [ ] New `.las` upload is accepted and processed.
- [ ] New `.laz` upload is accepted and processed.
- [ ] Metadata, bounds, classifications and CRS status display.
- [ ] Unknown CRS can be handled by the source-CRS assignment flow.

## E. AE workflow and Tasks

- [ ] Only AE sees Tasks.
- [ ] AE starts work on an eligible AI issue.
- [ ] One backend verification/task is created, not a duplicate browser task.
- [ ] Task opens the exact feature and verification ID.
- [ ] AE submits required text, images and GPS evidence to AEE.
- [ ] Point does not become Blue before AEE Good.

## F. AEE Activity and bell

- [ ] Only AEE sees Activity.
- [ ] AEE sees the AE submission in Activity.
- [ ] Existing top bell shows the same submission.
- [ ] Activity and bell open the exact same verification record.
- [ ] Moderate/Bad returns the record to AE and does not make it Blue.
- [ ] Good notifies Commissioner and makes the point Blue only in AI mode.

## G. Commissioner and MLA

- [ ] Commissioner bell opens the exact AEE-approved record.
- [ ] Commissioner accepts completed work.
- [ ] AE and AEE receive final notifications.
- [ ] MLA can view workflow history and evidence.
- [ ] MLA cannot start, submit, approve, return or accept work.

## H. Regression logs

Run after the test:

```powershell
docker compose logs --since=30m backend | Select-String "ERROR|Traceback|500|LookupError"
docker compose logs --since=30m frontend
```

- [ ] No new unhandled backend exception.
- [ ] No new frontend crash or unresolved API call.
- [ ] No duplicate bell, floating remediation panel or duplicate workflow record.
