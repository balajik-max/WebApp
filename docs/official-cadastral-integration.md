# Official Cadastral Integration

This project now supports two complementary approaches for `CADASTRAL` mode:

1. the existing surveyed ward overlay already loaded into the platform
2. an optional official external parcel/cadastral tile service layered on top

As of July 17, 2026, this is the recommended order of preference for real deployment.

## 1. Best-case: department gives a map service URL

Preferred deliverables:

- `XYZ` tile URL
- `WMTS` tile URL
- `ArcGIS MapServer tile` URL
- tiled `WMS GetMap` URL

Configure the frontend with these environment variables:

```env
VITE_CADASTRAL_TILE_URL=https://example.gov.in/arcgis/rest/services/Parcels/MapServer/tile/{z}/{y}/{x}
VITE_CADASTRAL_ATTRIBUTION=Department of Survey and Land Records, Government source
VITE_CADASTRAL_OPACITY=0.96
VITE_CADASTRAL_MAX_ZOOM=22
```

Notes:

- `VITE_CADASTRAL_TILE_URL` is optional. If blank, `CADASTRAL` mode falls back to the surveyed ward overlay only.
- For WMS, provide a tiled URL using `256x256` tiles and `bbox={bbox-epsg-3857}`.
- If the service needs authentication, do not hardcode tokens in the frontend. Proxy it through the backend or publish a department-approved public service.

Example WMS template:

```text
https://example.gov.in/geoserver/wms?service=WMS&request=GetMap&layers=parcel:plots&styles=&format=image/png&transparent=true&version=1.1.1&srs=EPSG:3857&width=256&height=256&bbox={bbox-epsg-3857}
```

## 2. If the department gives a Shapefile / GeoJSON / GDB export

This platform already supports upload and ingestion of:

- zipped Shapefiles
- GeoJSON
- GeoPackage
- zipped Esri File Geodatabases

Workflow:

1. Upload the official parcel dataset through the normal dataset upload UI.
2. Keep the parcel-related layer/category names intact if possible.
3. Open `CADASTRAL` mode. The preset now includes common parcel categories such as:
   `parcel`, `parcels`, `cadastral`, `property boundary`, `plot`, `plot boundary`, `site boundary`, `survey parcel`, `revenue parcel`, and `revenue map`.
4. If the source uses a different category name, map or rename it during ingestion or extend the allowlist in `frontend/src/components/MapCanvas.tsx`.

Recommended attributes to preserve from the source:

- parcel id
- survey number
- sub-division / hissa number
- ward
- village
- owner / khata / pid reference
- land-use / property-type
- source department
- update date

## 3. If the department only gives portal login / viewer access

This is common and usually means there is no ready public API.

Recommended path:

1. Ask for one of these export-friendly deliverables:
   `WMS/WMTS`, `ArcGIS service`, `GeoJSON`, `Shapefile`, or `GDB`.
2. If they only allow portal viewing, ask for a sanctioned periodic export for your ward or city extent.
3. If the data is legally sensitive, keep it as an internal deployment-only layer and do not redistribute the raw files.

Avoid:

- scraping hidden private APIs without departmental approval
- embedding cookies or personal logins in frontend code
- treating a screenshot-only portal as a reliable GIS source

## 4. Karnataka-specific practical sources

For Karnataka workflows, the most relevant official systems are typically:

- Revenue / SSLR survey systems for sketches and survey references
- Bhoomi / RTC-style land-record linkage
- municipal property / PID / khata systems for urban property matching
- Bhuvan or other official imagery for basemap context, not legal parcel ownership

## 5. Production recommendation

For the Davangere urban deployment, the strongest setup is:

1. official parcel or survey boundary layer from department or municipality
2. city property linkage data such as PID / khata / owner references
3. your surveyed ward infrastructure data already in this platform

That combination gives the best real-world result:

- legal/administrative parcel geometry
- property/business linkage
- on-ground utility and audit intelligence
