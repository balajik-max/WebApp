# Pothole Repair-Cost Integration

## Scope

This change is isolated to pothole findings. Existing map, GDB, raster, OBJ, 3D, Quick Analysis, Layer Review, workflows, Standing Water and other anomaly types are not reworked.

## Calculation

`estimated_repair_cost_inr = mapped area_sqm × configured POTHOLE_SR_RATE_PER_SQM`

The result is labelled preliminary. Every generated pothole finding stores the rate, source, year, item code, calculation basis and recommended repair method. Missing area or an invalid rate produces no amount.

## UI

The right-side **Pothole Condition** card displays the estimate after the surveyed facts and before **Urban Planning Solution**. Other anomaly cards do not render this block.

## AI context

Pothole AI explanation and solution assessment receive the same stored estimate metadata. They are instructed not to invent a cost when the metadata is absent.

## Configuration

Set these in the root `.env` before rebuilding/rerunning the audit:

```env
POTHOLE_SR_RATE_PER_SQM=426
POTHOLE_SR_RATE_SOURCE="Configured preliminary SR rate"
POTHOLE_SR_RATE_YEAR="Not configured"
POTHOLE_SR_ITEM_CODE="Not configured"
```

Use a verified project/tender rate. No unverified live webpage is scraped during map interaction.

## Existing datasets

After deployment, rerun the spatial audit for an already-uploaded GDB so the existing pothole anomalies are regenerated with the new cost metadata.
