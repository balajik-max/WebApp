# Apply and Test on Windows PowerShell

This patch must be applied after the first `Pothole_Repair_Cost_Integration_Changes`
patch, on the local feature branch.

## Apply

```powershell
cd "E:\7_23_26_Sub_Master_Updated_code"

git branch --show-current
git status --short

git apply --check "E:\Pothole_Online_Rate_Labour_Integration_v2\pothole_online_rate_labour.patch"
git apply "E:\Pothole_Online_Rate_Labour_Integration_v2\pothole_online_rate_labour.patch"

git diff --check
git status --short
git diff --name-only
```

Do not continue if `git apply --check` reports an error.

## Configure `.env`

```env
POTHOLE_SR_RATE_PER_SQM=426
POTHOLE_SR_RATE_SOURCE="Karnataka PWD Roads & Bridges SR"
POTHOLE_SR_RATE_YEAR="2023-24"
POTHOLE_SR_ITEM_CODE="10.5 / MoRTH 3004.2"
POTHOLE_SR_SOURCE_URL="https://pub-0eaebe23788c45d09640d811ac674d7a.r2.dev/karnataka-csr-vol3-roads-2023.pdf"
POTHOLE_SR_CACHE_TTL_HOURS=24
POTHOLE_SR_HTTP_TIMEOUT_SECONDS=25
POTHOLE_SR_MAX_SOURCE_BYTES=26214400
```

The source URL is configurable. If an approved current KPWD Roads & Bridges source
is available, replace the URL, year and source label together. The backend will reject
a document that does not contain the exact pothole item and unit.

## Build and run

```powershell
docker compose config --quiet
docker compose build --no-cache frontend backend
docker compose up -d --force-recreate backend frontend
docker compose ps
```

## Backend smoke calculation

```powershell
docker compose exec backend python -c "from app.services.pothole_costing import calculate_cost; r=calculate_cost(area_sqm=3.4491, rate_per_sqm=426, labour_enabled=True, labour_charge=500); assert r['base_repair_cost_inr']==1469.32 and r['total_repair_cost_inr']==1969.32; print(r)"
```

## Browser acceptance

1. Open `http://localhost:3000` and press `Ctrl + F5`.
2. Run/select the pothole analysis.
3. Click one pothole.
4. Confirm **Calculating...** appears, followed by:
   - repair cost without labour,
   - labour charge,
   - total including labour,
   - SR source/year/item/status/verification.
5. Enable labour, enter `500`, press **Apply & Recalculate**.
6. For area `3.4491 m2` at rate `426`, confirm base `1469.32` and total `1969.32`.
7. Press **Refresh online rate** and verify the status/source. A failed source must retain
   the cached/fallback rate and show the failure rather than breaking the card.
8. Click Standing Water and confirm no pothole-cost controls appear.
9. Complete regression checks before committing.
