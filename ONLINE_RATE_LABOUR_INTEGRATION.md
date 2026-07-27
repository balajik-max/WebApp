# Pothole Online SR Rate + User Labour Integration

## Scope

This is an additive second-stage patch for the existing pothole repair-cost integration.
It does not replace map, 3D/OBJ, GeoTIFF, Quick Analysis, workflow, authentication,
Layer Review, Street View, Standing Water, or Urban Planning code.

## Behaviour

For `pothole_status` findings only, the card:

1. Reads the mapped pothole area from the existing anomaly metadata.
2. Uses a cached SR rate immediately.
3. Refreshes the configured online PDF/HTML/JSON source when the cache is stale or
   the user presses **Refresh online rate**.
4. Accepts a fetched rate only when the exact KPWD item `10.5 / MoRTH 3004.2`,
   the 40 mm bituminous-concrete description, and a per-square-metre unit are validated.
5. Shows repair cost without labour.
6. Lets the signed-in user enable and set a labour charge per pothole.
7. Recalculates and shows the total including labour.
8. Displays source, year, item, status, last verification time, and online-sync errors.
9. Appends the current calculation to the single-pothole AI explanation.

If the online source fails, the last verified rate is preserved. If no rate has yet been
verified, the configured fallback rate is used and labelled as a fallback.

## Added API endpoints

- `GET /api/v1/pothole-cost/settings`
- `PUT /api/v1/pothole-cost/settings`
- `POST /api/v1/pothole-cost/rate/sync`
- `GET /api/v1/pothole-cost/estimate/{anomaly_id}`

## Additive database objects

- `pothole_sr_rate_cache` - one cached verified rate record.
- `pothole_labour_settings` - one labour setting per signed-in user.

No existing table or column is removed by this patch.

## Accuracy boundary

The default validated item is the KPWD 2023-24 Roads & Bridges bituminous pothole
item at INR 426/m2. Later KPWD years may be implemented through GOs and quarterly
issue-rate amendments. Do not label a newer amount as exact unless the configured
online source contains the approved composite pothole item and the parser validates it.

A bituminous repair item must not be treated as a final sanctioned concrete-pavement
repair rate. The UI therefore exposes the item, year, source, and status for engineering
review.
