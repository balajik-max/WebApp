# Analytics Attribute Search - Debugging Instructions

## Status: Ready for Testing

Docker containers have been rebuilt with `--no-cache` and are now running.

## What Was Changed

Added console logging to debug why the analytics results are not showing when an attribute is selected.

### Files Modified:
1. `frontend/src/pages/AnalyticsView.tsx` - Added debug logs in:
   - `effectiveCategories` useMemo (to see attribute-to-category mapping)
   - `analyze()` function (to see when Analyze is clicked)
   - `useEffect` that calls `fetchOverview()` (to see what parameters are being passed)
2. `frontend/src/lib/workflow.ts` - Added debug log in `fetchOverview()` function (to see the API call details)

## How to Test

1. **Open the application** in your browser at `http://localhost:3000`

2. **Navigate to the Analytics page**

3. **Open Browser Developer Tools** (F12 or right-click → Inspect)
   - Go to the **Console** tab

4. **Test the attribute selection:**
   - Click on the "Search Attributes..." input box
   - Select an attribute (e.g., "Manholes")
   - Click the "Analyze" button

5. **Check the Console Logs** - You should see messages like:
   ```
   [Analytics] Analyze clicked - draftAttributeKey: manholes
   [Analytics] Set appliedAttributeKey to: manholes
   [Analytics] Applied attribute: manholes Mapped categories: ['Access_Point']
   [API] fetchOverview called with: { datasetIds: [...], categories: ['Access_Point'], filters: {...}, query: "..." }
   ```

## What to Look For

### Expected Behavior:
- When you select "Manholes" and click Analyze, the console should show:
  - `appliedAttributeKey: manholes`
  - `Mapped categories: ['Access_Point']`
  - The API call should include `category=Access_Point` in the query string

### If Categories Array is Empty:
- If you see `Mapped categories: []`, this means the attribute key is not matching properly
- Check if the attribute key in the console matches the keys in `ANALYTICS_ATTRIBUTE_MAP`

### If No Data Shows:
- If the API is being called with correct categories but no data shows, the issue might be:
  1. No data exists in the database for that category
  2. Dataset selection is incorrect
  3. Backend API issue

## Attribute to Category Mapping

The system maps attributes to categories as follows:

```
poles           → ["Illumination_Asset", "Utility_Pole"]
drains          → ["Drainage_Asset"]
manholes        → ["Access_Point"]
roads           → ["Road_Centerline", "Road_Surface"]
powerlines      → ["Power_Line"]
potholes        → ["Pothole"]
standing_water  → ["Standing_Water"]
road_inspection → ["Road_Centerline", "Road_Surface"]
```

## Next Steps After Testing

Please share:
1. **Screenshot of the browser console** showing the log messages
2. **What attribute you selected** (e.g., "Manholes")
3. **What you see on the page** (empty charts, "No data", or actual data)
4. **The complete API URL** from the console log (the query string part)

This will help me identify where the issue is occurring.
