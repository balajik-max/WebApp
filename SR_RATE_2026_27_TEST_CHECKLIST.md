# SR Rate 2026-27 Test Checklist

## Build

```powershell
cd "E:\7_23_26_Sub_Master_Updated_code"
docker compose build frontend backend
docker compose up -d --force-recreate backend frontend
docker compose ps
curl.exe -i http://localhost:8001/api/health
```

## Selected pothole tests

1. Open Map and enable Pothole Detection.
2. Click a bituminous pothole with depth <= 25 mm.
   - Suggested item: 10.15(i)
   - Rate: Rs. 388/m2
3. Click a bituminous pothole with depth > 25 mm.
   - Suggested item: 10.15(ii)
   - Rate: Rs. 635/m2
4. Select item 10.5 manually.
   - Rate: Rs. 631/m2
5. Switch to Manual Rate, enter a value, and apply.
   - Rate source must say user-entered manual rate.
6. Enable additional labour/mobilisation, enter a value, and apply.
   - Total = area x selected rate + additional charge.
7. Click a different pothole.
   - The first pothole's settings must not appear on the second.
8. Return to the first pothole.
   - Its saved settings should reappear.
9. Click a concrete-road pothole.
   - Official bituminous mode is blocked.
   - Manual approved rate is requested.
10. Open the official source PDF link.

## Error regression

```powershell
docker compose logs --since=10m backend |
  Select-String -Pattern "MissingGreenlet|500 Internal|pothole-cost|explain"
```

Expected:
- pothole cost estimate -> 200 OK
- pothole AI explanation -> 200 OK
- no `MissingGreenlet`

## Existing-feature smoke test

- GDB upload and map placement
- OBJ / 3D placement
- GeoTIFF rendering
- Quick Analysis persistence
- Layer Review / View on Map
- Standing Water detection
- Street View
- AE -> AEE -> Commissioner workflow
