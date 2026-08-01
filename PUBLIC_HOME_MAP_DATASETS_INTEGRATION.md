# Public Home, Map and Datasets Integration

## Purpose

This update adds a citizen-safe geospatial workspace to the existing public portal while preserving the officer application and all colleague features.

## Public routes

- `/public/dashboard` — Home, complaints and citizen notifications
- `/public/map` — read-only map for the signed-in citizen's own uploaded datasets
- `/public/datasets` — upload, process, list, view and delete the signed-in citizen's own datasets

The citizen navigation contains only **Home**, **Map** and **Datasets**. It does not expose Layer Review, Analytics, AI remediation, Grievance administration or officer actions.

## Citizen-facing wording

- New complaint notification: `Complaint submitted successfully.`
- Public status label: `Viewed by Authority`
- Commissioner remains the internal workflow role; only the citizen-facing wording changes.
- Previously stored public notifications are normalized in the UI so old officer names are not shown.

## Supported public map uploads

- Esri File Geodatabase: complete `.gdb` folder selected through **browse a .gdb folder**, or a ZIP containing one `.gdb` folder
- Complete zipped Shapefile, or selected `.shp + .dbf + .shx + .prj` components which are zipped in the browser
- GeoJSON / JSON
- KML
- GeoPackage

This release intentionally limits citizen uploads to vector data that can be rendered safely in the public 2D map. Existing officer support for GeoTIFF, LiDAR, photographs and OBJ/3D remains unchanged and officer-only.

## Isolation and ownership

Citizen uploads use separate database tables:

- `public_datasets`
- `public_dataset_features`

They do not enter the officer `datasets`, `features`, analytics, layer-review, AI-audit or remediation tables.

Every public dataset endpoint verifies `public_user_id`. A citizen can list, open, map or delete only datasets owned by that account. Manually changing a URL to another dataset ID returns `404 Dataset not found`.

Original files are stored under an isolated MinIO prefix:

`public-datasets/<public_user_id>/<dataset_id>/<filename>`

## Processing flow

1. Citizen uploads a supported vector dataset.
2. The API validates the extension, content signature and ZIP structure.
3. The original file is stored in MinIO.
4. A public-only background ingestion task reads and reprojects features to EPSG:4326.
5. Map-ready features are stored in `public_dataset_features`.
6. The status changes from Queued → Processing → Ready, or Failed with an error message.
7. **View on Map** opens `/public/map?dataset=<id>`, selects the dataset and zooms to its bounds.

For a File Geodatabase, every readable feature class is preserved through the `gdb_layer` attribute and shown on the public map.

## Map behavior

- OpenStreetMap base map
- Point, line and polygon rendering
- Multiple owned datasets may be selected at once
- Automatic zoom to selected dataset bounds
- Feature popup with permitted source attributes
- Basic navigation and fullscreen controls
- A maximum of 100,000 features per dataset is rendered in one request; the UI displays a warning when the response is truncated

## Database safety

The schema change is additive. Existing officer tables, public accounts, complaints, notifications, datasets and uploads are not deleted or recreated. Do not run `docker compose down -v`.

## Build and run

```powershell
cd "E:\29_7_26_UPDATED\WebApp-Sub_Master"

docker compose config --quiet
docker compose build backend frontend
docker compose up -d --force-recreate backend frontend
docker compose ps
docker compose logs --tail=200 backend frontend
```

No new `.env` value is required for this enhancement.

## Acceptance test

1. Confirm Admin, Architect, AE, AEE, Commissioner and MLA can still log in.
2. Confirm the officer Map, Datasets, Layer Review and Analytics pages behave as before.
3. Log in as a public user and confirm the navigation shows only Home, Map and Datasets.
4. Submit a complaint and confirm the public notification says `Complaint submitted successfully.`
5. Confirm the public status/timeline says `Viewed by Authority` while the internal Commissioner workflow still works.
6. Upload a complete `.gdb` folder or supported vector file.
7. Wait until the dataset status is Ready.
8. Click **View on Map** and confirm the map zooms to and renders the uploaded features.
9. Log in as another public user and confirm the first user's dataset is not listed or accessible.
10. Delete the public dataset and confirm only that public dataset is removed.
