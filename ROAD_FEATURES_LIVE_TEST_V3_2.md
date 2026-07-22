# Live Test — Road Features V3.2

## 1. Containers

Confirm backend, database, storage, and AI are healthy and frontend is running.

## 2. Startup taxonomy migration

Backend logs should contain one of:

- `Road taxonomy compatibility backfill: ...`
- `Road compatibility verified: ...`

## 3. Road class counts

Confirm the selected dataset contains `Road_Centerline` and `Road_Surface` features.

## 4. AI Detection → Roads

- Select the correct road survey dataset.
- Open AI Detection and choose Roads.
- Spatial Audit should run automatically if it has not run in this session.
- Turn on the AI overlay when needed.
- Road centerlines/surfaces should remain visible.
- Narrowing findings should appear as red/yellow line segments, not point dots.

## 5. Road Inspection

- Enable Road Inspection.
- Click an actual Road Centerline.
- The Road Inspection card should open for that road ID.
- It should show road length, nearby poles/drains/manholes, and active findings.
- Clicking a generic road edge/surface should not open a wrong-road report.

## 6. Quick Analysis → Road Width Check

- Open Quick Analysis.
- Select Road Width Check.
- Spatial Audit should start automatically if needed.
- Road centerline/surface geometry should be visible.
- Any narrowing findings should be drawn as red/yellow affected line segments.
- Clicking a road centerline/surface should select the exact feature.

## 7. Regression checks

- Layer Review opens and loads GDB layers.
- AE Tasks and AEE Activity remain role restricted.
- Roads do not open AE/AEE remediation forms.
- Pole, drain, and manhole AE/AEE workflows still work.
- Blue approval color remains limited to AEE Good in AI mode.
- Existing notification bell opens the exact workflow record.
