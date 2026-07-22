# Road AI, Road Inspection, and Road Width Fix — V3.2

## Scope

This update repairs the colleague road-analysis features while preserving the existing Layer Review and AE → AEE → Commissioner workflow.

## Confirmed root causes

1. **Road-width geometry was never pushed to the map source.**
   The `spatial-anomalies-road-lines` source and layer existed, but the frontend never converted each `road_width_narrowing` anomaly's `affected_line_wkt` into GeoJSON. Valid backend results therefore produced no visible road highlight.

2. **Persistent databases could retain the old road taxonomy.**
   Existing features such as `Road Centerline`, `Concrete Road`, and `Concrete Edge` could still have `_canonical_class = Road_Segment`. The newer Road Inspection and Road Width services expected `Road_Centerline` and `Road_Surface`, so they returned no road or no stations.

3. **Road Width did not reliably start Spatial Audit itself.**
   The Road Width card depended on anomalies that might not yet exist. V3.2 requests the audit when Roads mode, Road Inspection, or the Road Width card is opened.

4. **A failed audit could not be retried in the same session.**
   The one-time execution guard remained locked after an error. It is now released on failure.

## Changes made

### Backend

- Added `app/services/road_compat.py`.
- Added deterministic startup migration from known legacy road categories to:
  - `Road_Centerline`
  - `Road_Surface`
- Updated the `category_class_map` cache during migration.
- Added compatibility SQL predicates to Road Width and Road Inspection so they can still operate before/while legacy records are being migrated.
- Runs the targeted backfill during `seed.py` startup and again inside Spatial Audit transaction safety.
- Spatial Audit now preserves every anomaly linked to any point-verification workflow, preventing an audit rerun from deleting an active AE/AEE/Commissioner record.

### Frontend

- Added legacy road-category compatibility helpers.
- Road filters and click selection now accept both canonical and older raw category names.
- Populates the road anomaly GeoJSON source from `affected_line_wkt`.
- Automatically requests Spatial Audit for:
  - AI Detection → Roads
  - Road Inspection
  - Quick Analysis → Road Width Check
- Keeps Road analysis separate from point-remediation workflow. `AiDetectionMode` remains only `poles | drains | manholes`, so Roads does not enter AE/AEE task forms accidentally.

## Protected features

The update does not replace or remove:

- Layer Review and Universal GDB dashboards
- AE-only Tasks
- AEE-only Activity
- AE → AEE → Commissioner workflow
- MLA read-only access
- Existing notification bell
- Blue point after AEE Good in AI mode
- Architect/Admin legacy workflow
- LAS/LIDAR compatibility
- Other map, dataset, raster, OBJ, 3D, analytics, and grievance features

## Static validation completed

- Backend Python compilation passed.
- TypeScript/TSX syntax transpilation passed for 120 source files.
- `package.json` parsed successfully.
- `docker-compose.yml` parsed successfully.
- Road route, startup backfill, source population, compatibility predicates, and workflow-boundary assertions passed.

## Runtime validation still required

Docker is unavailable in the packaging environment. A full Docker build and browser test must be run on the target Windows machine before the update is merged to a shared branch.
