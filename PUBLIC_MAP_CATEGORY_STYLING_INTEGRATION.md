# Public Map Category Styling Integration

## Purpose

The public map previously assigned one colour to every feature in a selected dataset. A multi-layer File Geodatabase therefore appeared as one solid purple drawing even though the officer map displayed the same feature categories with separate colours.

## Implemented behaviour

- Public map colours are now calculated from each feature's `category` value.
- When a feature is uncategorized, its source layer is used as the safe fallback.
- The public map imports and uses the existing shared `colorForCategory` function from `frontend/src/lib/categoryColors.ts`.
- The same category string therefore receives the same deterministic colour in the public and officer maps.
- Points, lines and polygons use the shared category colour while retaining geometry-specific rendering.
- The sidebar now includes a category legend with feature counts.
- Dataset cards use a multi-colour swatch rather than incorrectly implying that the entire dataset has one colour.

## Isolation and compatibility

This enhancement changes only:

- `frontend/src/pages/PublicMap.tsx`
- `frontend/src/public-portal.css`
- this documentation file

No backend ingestion, database table, public ownership rule, officer route, officer map, officer dataset page, analytics, layer review, notification, complaint, authentication, AE/AEE/Commissioner workflow, MinIO, PostGIS or Ollama logic was changed.

## Rendering rule

Category is intentionally used instead of each feature's label. Labels are often unique names or IDs; colouring by label would create hundreds of arbitrary colours and would not match the officer map.
