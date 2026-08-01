# Property Tax Phase 2 - Property Record and Assessment Foundation

## Scope completed

Phase 2 extends the Phase 1 GIS building classification without changing raw uploaded survey attributes.

The implemented workflow is:

1. Open `http://localhost:3000/map`.
2. Click **Property Tax** in the map toolbar.
3. Activate classification colours.
4. Click a principal building polygon.
5. Review and edit its Property Tax Record.
6. Compare GIS-derived values with municipal-record values.
7. Enter a configurable draft tax estimate.
8. Save a versioned assessment to PostgreSQL.

Auxiliary roofline, step, porch, transformer and other non-principal polygons remain excluded by the Phase 1 classifier.

## Frontend features

- Building-click Property Tax Record panel.
- Property identity fields: Property ID, assessment number and owner.
- Assessment workflow statuses:
  - Not assessed
  - Draft assessment
  - Verification pending
  - Verified
  - Approved
- Municipal property use, occupancy, construction and tax zone.
- Municipal plot area, built-up area and floor count.
- GIS versus municipal comparison table.
- Difference indicators for use, built-up area and floor count.
- Recognised GIS source-field display.
- Configurable draft annual-tax formula:
  - Built-up area x annual rate x usage factor x zone factor x construction factor x age factor
- Local browser-draft fallback when the backend is unavailable.
- Responsive desktop and mobile layout.

## Backend features

New table: `property_tax_assessments`

Each record is linked to one existing GIS `features.id` and stores municipal assessment data separately from `features.attributes`.

API endpoints:

- `GET /api/v1/property-tax/assessments/{feature_id}`
- `PUT /api/v1/property-tax/assessments/{feature_id}`
- `DELETE /api/v1/property-tax/assessments/{feature_id}`

The database bootstrap creates the new table and indexes automatically on backend start.

## Data-safety rules

- No raw GIS attribute is edited.
- No GDB or GeoPackage source file is modified.
- GIS values are stored as a snapshot in the assessment record.
- Municipal values remain explicitly separate.
- The draft estimate is not an issued demand or receipt.
- MLA access remains read-only under the existing global authorization guard.

## Main files added

- `backend/app/models/property_tax_assessment.py`
- `backend/app/schemas/property_tax.py`
- `backend/app/api/v1/property_tax.py`
- `frontend/src/lib/propertyTaxAssessment.ts`
- `frontend/src/components/PropertyTaxAssessmentPanel.tsx`
- `property-tax-phase2-preview.html`
- `START_PROPERTY_TAX_PHASE2_APP.bat`
- `START_PROPERTY_TAX_PHASE2_PREVIEW.bat`

## Main files updated

- `backend/app/models/__init__.py`
- `backend/app/api/v1/router.py`
- `backend/app/db/init_db.py`
- `frontend/src/components/MapCanvas.tsx`
- `frontend/src/pages/MapView.tsx`
- `frontend/src/index.css`

## Validation completed

- Frontend TypeScript check: passed.
- Backend Python compile check: passed.
- New router/model/schema registration inspected.
- Standalone Phase 2 visual preview created.

A complete Vite production bundle could not be generated in this Linux sandbox because the uploaded project carried Windows-specific Node dependencies and the internal npm mirror did not contain one transitive package. This does not affect Docker/Windows startup from the provided source package; the source-level TypeScript validation passed.

## Run

Complete app:

```text
http://localhost:3000/map
```

Double-click:

```text
START_PROPERTY_TAX_PHASE2_APP.bat
```

Standalone visual preview:

```text
property-tax-phase2-preview.html
```

or double-click:

```text
START_PROPERTY_TAX_PHASE2_PREVIEW.bat
```
