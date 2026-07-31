# Property Tax Phase 3.0

Phase 3 extends the stabilized Phase 2.2 map and assessment card without altering raw GIS attributes.

## Included

- Municipal property-register import from CSV, XLSX, or XLS.
- Column-alias detection for common property-tax register headers.
- Exact GIS matching by GIS Feature ID, Property ID, Assessment Number, SAS Number, or Door Number.
- Spatial fallback by Latitude/Longitude to the nearest principal building within 35 metres.
- Manual search, link, and unlink workflow inside the selected-building card.
- Automatic population of official Property ID, assessment, owner, use, occupancy, construction, zone, areas, floors, rate, and financial year.
- GIS-versus-municipal comparison with discrepancy workflow.
- Whole-building and floor-wise annual property-tax calculations.
- Usage, zone, construction, and age factors; cess, service charge, rebate, and exemption.
- Assessment workflow: Not Assessed, Draft, Verification Pending, Verified, Approved, Demand Generated.
- Approval validation and server-side locking after demand generation.
- Annual demand creation with calculation breakdown and unique demand number.
- Immutable assessment revision history.
- CSV and formatted XLSX municipal-register templates under `sample_data/property_tax`.
- Browser local-draft fallback when backend storage is unavailable.

## Run

1. Copy the existing working root `.env` into this project.
2. Start Docker Desktop.
3. Run `START_PROPERTY_TAX_PHASE3_APP.bat`.
4. Open `http://localhost:3000/map`.

The database bootstrap is additive and creates/migrates Phase 3 tables on backend startup.
