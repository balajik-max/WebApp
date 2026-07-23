# Merged WebApp Integration Report

## Merge objective

This project uses the colleague-delivered `WebApp-Sub_Master` project as the base and integrates the user's current working feature set without replacing the colleague project wholesale.

The merge was performed as a three-way source merge from a reconstructed common ancestor. Files with concurrent changes were resolved feature-by-feature so the colleague functionality and the user's additions remain in the same codebase.

## Colleague functionality preserved

The merged source retains the colleague project's existing application structure and features, including:

- Authentication, roles and protected routes.
- Dataset upload, processing, visualization and multi-dataset selection.
- Layer Review and universal/approved dashboards.
- Quick Analysis tools and existing road, drainage, manhole, utilities and water-demand analytics.
- Poles, Drains, Manholes, Roads and Road Inspection AI modes.
- Powerlines AI detection, 2D building-proximity visualization, 3D powerline context and anomaly explanation.
- Existing GDB, raster, OBJ, DSM/DTM, photo, panorama, street-view, placemark and measurement workflows.
- Existing AE/AEE/Commissioner remediation APIs and dashboards for supported remediation modes.
- Existing Manhole recommendation and underground/network visualization.
- Existing mobile and desktop layouts.
- The Urban Planning Solution action on ordinary anomaly cards, including colleague anomaly types.

## User functionality integrated

### Layer Review / View on Map

- Dashboard and Layer Review feature links can request isolated map focus.
- Only operational layers that were visible before isolation are temporarily hidden.
- Manually hidden layers remain hidden after restoration.
- The selected feature remains highlighted and selectable.
- Clicking the selected feature keeps isolation active and opens its details.
- Clicking elsewhere with the ordinary left mouse button exits isolation.
- Previous datasets, hidden categories, 3D-building state and camera are restored.
- Search is positioned beside Grievance in the desktop header.

### Potholes and Standing Water in 2D

- Dedicated `Potholes` and `Standing Water` detection modes.
- Canonical-class and common raw-layer-name compatibility, including `Pathhole` spellings.
- Original GDB Point/MultiPoint/Polygon/MultiPolygon geometry is retained.
- Severity presentation uses green, yellow and red; final resolved findings use blue.
- Polygon fill, boundary and outer glow use the persisted anomaly linked to the exact feature.
- ON enables AI severity presentation.
- OFF for Potholes/Standing Water exits the focused mode and restores the complete normal GDB view.
- Pothole and Standing Water hover summaries and click handling use their persisted audit metadata.

### Surface issue audit backend

- Deterministic Pothole and Standing Water detectors were added to the existing spatial-audit transaction.
- Existing pole, drain, manhole, road-width and powerline detector calls remain present.
- Legacy datasets are backfilled idempotently with `Pothole`, `Pothole_Reference` and `Standing_Water` canonical classes.
- Missing measurement values are preserved as unavailable rather than invented.
- Pothole severity can use mapped area, supplied/calculated depth, repair volume and road proximity.
- Standing Water severity can use mapped area, road intersection/proximity and drain intersection/proximity.
- Audit response, persisted anomaly types, AI fact sheets and explanation paths include both new families.

### Remediation workflow

- Pothole and Standing Water red/yellow findings can enter the existing AE → AEE → Commissioner workflow.
- Their workflow records retain anomaly id, mode, measurements, coordinates, evidence and history.
- Commissioner-approved resolution is displayed in blue.
- Powerlines remain an AI detection mode, but are deliberately not sent into remediation because the current backend remediation contract does not support that mode.

### Recommendation cards

- Clicking a Pothole finding opens `AI Pothole Recommendation` on the right.
- Clicking a Standing Water finding opens `AI Standing Water Recommendation` on the right.
- Cards include persisted condition/severity, measurements, practical implications, recommended action, priority, workflow status and coordinates.
- Both cards can open the affected feature in the existing 3D viewer.
- Existing Manhole recommendation and ordinary anomaly-card behavior remain separate and preserved.

### 3D integration

- Pothole and Standing Water modes are available alongside Poles, Drains, Manholes and Powerlines.
- Standing Water no longer uses the generic rotated water extrusion that mirrored its latitude.
- Surface polygons and polygon holes are triangulated from original GDB rings and draped vertex-by-vertex on DTM elevation.
- MultiPolygon parts are retained.
- Point and MultiPoint potholes render at exact surveyed coordinates, with marker size derived from surveyed dimensions when available.
- Surface findings are lifted above the existing road ribbon to remain visible.
- Highlighted findings include boundary/glow, click details and surface-specific recommendations.
- `Selected + Roads` and `All Classes` context presets are included.
- Resolved surface findings use blue in 3D.
- Existing terrain, buildings, roads, drains, manholes, poles, powerlines, vegetation, signage, contours, heatmap and underground behavior remain in the source.

### Approved dashboards

- Pothole and Standing Water dashboards and calculations are integrated.
- The adapter preserves internal feature ids and coordinates so dashboard rows link to the actual survey feature using isolated View on Map.
- Existing approved dashboards remain registered and available.

## Important merge decisions

- The colleague project is the base. Entire colleague files were not replaced with the user's versions.
- Powerlines changes were unioned with Potholes/Standing Water changes in shared anomaly, 2D and 3D files.
- The existing Urban Planning Solution action was retained for colleague anomaly cards.
- Surface resolved color was normalized to blue in 2D and 3D.
- A stale reference to removed Manhole feature-card state was removed during merge validation.
- Old patch ZIPs and backup folders are not required to run this merged project.

## Runtime validation status

Static and deterministic checks completed in the merge environment are listed in `MERGE_VALIDATION_CHECKLIST.md`.

A complete dependency installation, production frontend build, Docker startup and visual browser regression must still be run on the target Windows/Docker environment. The merge must not be declared production-ready until those runtime checks pass.
