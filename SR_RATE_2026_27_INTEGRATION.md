# Karnataka PWD 2026-27 Selected-Pothole SR Integration

## Current official source

The active values are transcribed from Karnataka PWD Bengaluru Circle **Document 152**, effective **04-07-2026**, with finished-item rates excluding GST:

| SR item | Use | Rate |
|---|---|---:|
| 10.15(i) | Shallow pothole patching, 25 mm SDBC | Rs. 388/m2 |
| 10.15(ii) | Deep pothole patching with restored base plus SDBC | Rs. 635/m2 |
| 10.5 | 40 mm bituminous-concrete patch repair | Rs. 631/m2 |

The earlier **Issue Rates 04** PDF is bundled for rate-history reference. It is not used as the current calculation source because Document 152 has the later effective date.

## Selected-pothole workflow

1. User clicks one pothole.
2. The existing right-side `Pothole Condition` panel remains unchanged above the new section.
3. The backend reads the selected pothole's mapped area, depth, and nearest-road category.
4. Depth suggests shallow or deep repair:
   - depth up to 25 mm -> 10.15(i)
   - depth above 25 mm -> 10.15(ii)
5. The user can choose:
   - official 2026-27 item rate, or
   - a manual approved rate for this pothole.
6. The user can optionally add an **additional labour / mobilisation charge**.
7. `Apply & Recalculate` saves the settings only for the selected pothole and authenticated user.
8. The panel displays base cost, additional charge, total, item, year, effective date, GST status, and source PDF.

## Concrete-road protection

Document 152's listed pothole items are bitumen-related. If the nearest road is classified as concrete, the software does not silently apply a bituminous rate. It selects manual-rate mode and asks the engineer to enter the approved concrete-repair rate.

## MissingGreenlet fix

The previous `500 Internal Server Error` occurred because SQLAlchemy ORM attributes were read after the shared async session had committed and expired the object. The integration fixes this by:

- reading anomaly values through scalar queries in the costing service;
- never making a live website/PDF request during a pothole click;
- storing scalar anomaly values before cost calculation in the AI explanation endpoint;
- ensuring a costing failure cannot break the normal AI explanation.

## Files intentionally changed

- `.env.example`
- `backend/app/api/v1/ai.py`
- `backend/app/api/v1/pothole_cost.py`
- `backend/app/core/config.py`
- `backend/app/db/init_db.py`
- `backend/app/schemas/pothole_cost.py`
- `backend/app/services/pothole_costing.py`
- `backend/app/services/pothole_sr_2026_27.py`
- `backend/app/services/surface_issue_audit.py`
- `backend/app/static/kpwd/Document_152_2026-27.pdf`
- `backend/app/static/kpwd/Issue_Rates_04_2026-27.pdf`
- `backend/tests/test_pothole_costing.py`
- `backend/tests/test_surface_issue_audit_rules.py`
- `frontend/src/components/AnomalyAlertCard.tsx`
- `frontend/src/index.css`
- `frontend/src/lib/potholeCost.ts`

No MapCanvas, OBJ, 3D, GeoTIFF, Quick Analysis, Layer Review, Street View, authentication, or remediation-workflow component is replaced.
