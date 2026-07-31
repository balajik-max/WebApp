# Property Tax Phase 3.1 — GIS Survey Auto-fill

This stabilization update keeps the optional municipal-register connection and makes the uploaded GIS survey the default working source whenever no official record is linked.

## Implemented

- Property use auto-filled from surveyed building/floor fields.
- Plot area obtained from the containing plot when available.
- Footprint and total built-up area loaded from survey attributes, with geometry/floor fallback.
- `G`, `G+1`, `G+2`, basement and upper-floor notations converted into numeric floor counts.
- `P`, `SP` and `K` converted to Pucca, Semi-pucca and Kutcha.
- Occupancy loaded when surveyed; otherwise clearly marked `Usage not verified`.
- Existing empty/zero Phase 3 drafts are refreshed from GIS instead of staying blank.
- Municipal values still take priority after an official record is linked; missing official values continue to use GIS.
- Tax assessment receives taxable area, use, construction factor, floor lines and an editable indicative annual rate automatically.
- Mixed-use buildings use each floor's surveyed use rather than one rate for the entire building.
- Upper floors use separate provisional factors: ground 1.00, first 0.90, second 0.80, third 0.75, higher 0.70.

## Indicative rate schedule

These are editable demonstration rates, not an official municipal notification:

| Survey classification | ₹ / sqm / year |
|---|---:|
| Residential | 12 |
| Commercial | 30 |
| Mixed Use fallback | 22 |
| Industrial | 24 |
| Public & Semi Public | 8 |
| Dilapidated | 5 |
| Under Construction | 6 |
| Other / Unclassified | 10 |

If the uploaded dataset or a linked municipal register contains a rate field, that supplied rate is used instead.

## Ward-21 validation

A 100-building sample from the supplied Hoige Bazar GeoPackage was processed. All 100 received building use, built-up area, numeric floor count, construction class, indicative rate and a calculable floor-wise estimate. Mixed-use sample `G+2` records correctly produced a commercial ground floor and residential upper floors.

## Validation

- Frontend TypeScript: passed
- Targeted ESLint: passed
- Backend Python compilation: passed
- Ward-21 GIS auto-fill smoke test: passed
- Vite production bundle: not executed in this Linux sandbox because the uploaded dependency set contains Windows Rollup native packages; use the included Docker launcher on the target Windows machine.
