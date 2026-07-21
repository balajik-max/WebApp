# Universal GDB-to-Dashboard Engine

This integration adds a new **Layer Review** workspace beside Analytics without replacing or changing the existing Map, Datasets, Analytics, authentication, or survey tools.

## User flow

1. Open **Datasets** and upload a zipped Esri File Geodatabase (`.gdb.zip`) or drop an unzipped `.gdb` folder.
2. Wait until the dataset status becomes **Ready**.
3. Click **Layer Review** in the top navigation, or click **Layer Review** on the dataset row.
4. The engine inspects each persisted layer, geometry type and populated field.
5. Known layers are classified automatically with a confidence score.
6. Uncertain or unfamiliar layers use a safe generic point/line/polygon dashboard until the user confirms or corrects the interpretation.
7. Click **Generate dashboard** to open the dynamic KPI, chart, field-completeness and layer dashboards.
8. Use **View on map** to open the existing map with the selected dataset.
9. Use **Export Excel** to download the layer report and original attributes.

## Backend additions

- Deterministic layer classification using layer names, geometry and field names.
- Per-dataset layer review settings stored inside existing `Dataset.metadata`; no database migration is required.
- Source-layer inventory retained during new GDB ingestion, including empty or unreadable layers.
- Universal dashboard aggregation API.
- Excel export API.

### API endpoints

- `GET /api/v1/visualization/dashboard-types`
- `GET /api/v1/visualization/datasets/{dataset_id}/manifest`
- `PATCH /api/v1/visualization/datasets/{dataset_id}/layers/{layer_key}`
- `GET /api/v1/visualization/datasets/{dataset_id}/dashboard`
- `GET /api/v1/visualization/datasets/{dataset_id}/export/excel`

## Accuracy behavior

The system never treats an absent field as a zero. Charts are generated only from populated fields. Unknown layers remain available through generic dashboards, and low-confidence classifications are visibly flagged for confirmation.

## Existing datasets

Datasets ingested before this integration still receive manifests and dashboards from their persisted features. Re-uploading an older GDB is only needed when you want the new source inventory to retain empty or unreadable source-layer information.

## Validation completed

- Frontend TypeScript + Vite production build passes.
- New frontend files pass ESLint.
- Backend Python source compiles successfully.
- Deterministic classifier smoke tests pass for road, drainage, manhole, vegetation and unknown polygon layers.
