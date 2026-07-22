# Live Acceptance Checklist

Use a separate test branch and database. Do not overwrite the current working deployment until every required item passes.

## Startup

- [ ] Copy the working environment configuration into `.env`.
- [ ] Build backend and frontend without errors.
- [ ] PostgreSQL/PostGIS is healthy.
- [ ] MinIO is healthy and the bucket is available.
- [ ] Backend health endpoint responds.
- [ ] Frontend opens without console-breaking errors.

## Colleague regression checks

- [ ] Welcome, Login and Profile work.
- [ ] English/Kannada and light/dark theme work.
- [ ] Map and basemaps work.
- [ ] Dataset upload and deletion work.
- [ ] Existing GDB, Shapefile, GeoJSON, GeoPackage, KML, CSV/Excel, GeoTIFF, OBJ and image behavior remains correct for known test files.
- [ ] Layers, attributes, styling, search, measurements and placemarks work.
- [ ] Analytics and exports work.
- [ ] 3D, raster/elevation, panorama and Street View features work where configured.
- [ ] AI assistant and spatial audit work where Ollama is configured.
- [ ] Grievance and Architect workspace work.
- [ ] Legacy Architect → Admin remediation still works.

## Layer Review

- [ ] Upload a valid zipped `.gdb`.
- [ ] All readable point, line and polygon layers appear on the map.
- [ ] Original layer names and attributes are preserved.
- [ ] Layer Review opens from navigation.
- [ ] Classification, counts, fields and warnings are accurate.
- [ ] Confirming a layer saves correctly.
- [ ] Generated dashboard loads correctly.
- [ ] Excel export downloads correctly.
- [ ] MLA can view but cannot edit classifications.

## AE → AEE → Commissioner

- [ ] AE right-clicks an eligible Red/Yellow AI point.
- [ ] Left-click still opens normal feature details.
- [ ] AE starts work and manually enters AE name.
- [ ] Before/After evidence uploads.
- [ ] Missing/non-geotagged After image is rejected.
- [ ] Out-of-buffer evidence is rejected.
- [ ] Valid evidence displays correct GPS distance.
- [ ] AE submits to AEE.
- [ ] AEE receives one notification in the existing top bell.
- [ ] Bell click opens the exact verification record and images.
- [ ] No `0.000000, 0.000000` coordinate fallback appears.
- [ ] AEE Moderate/Bad returns work to the same AE and remains Red/Yellow.
- [ ] AEE Good changes point to Blue only in AI mode.
- [ ] Commissioner receives the correct bell notification.
- [ ] Commissioner bell click opens AE/AEE names, evidence, remarks and history.
- [ ] Commissioner accepts.
- [ ] AE and AEE receive final acceptance notifications.
- [ ] MLA sees the final record but has no action controls.

## AE Tasks and AEE Activity

- [ ] AE login shows the **Tasks** navigation item; other roles do not.
- [ ] Tasks lists only workflows owned by the signed-in AE.
- [ ] Work in progress and returned work open the exact map workflow for correction.
- [ ] Submitted, AEE-approved and Commissioner-accepted records remain visible as history.
- [ ] AEE login shows the **Activity** navigation item; other roles do not.
- [ ] Activity shows live AE work and highlights submissions requiring AEE review.
- [ ] Clicking Review now opens the exact `verification_id`.
- [ ] Tasks/Activity still work after logout, login, refresh and browser restart because data is backend-persistent.
- [ ] No `davangere.assignedWork` localStorage record is created.

## Removal checks

- [ ] No floating AEE Approvals button.
- [ ] No floating Commissioner button.
- [ ] No separate Remediation Updates panel.
- [ ] Only one top notification bell exists.

