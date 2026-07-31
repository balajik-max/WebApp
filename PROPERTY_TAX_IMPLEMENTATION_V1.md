# Property Tax Classification — Implementation V1

## Scope implemented

This version adds a focused property-tax classification mode to the existing `/map` workspace. It does not create demand, payment, arrears, penalty, or accounting workflows.

### Map behaviour

- Adds a **Property Tax** button to the existing map toolbar.
- Colours principal building polygons by tax-use class.
- Displays a summary panel with class-wise counts.
- Allows a class to be selected and visually isolated.
- Preserves existing building attributes and feature-click behaviour.
- Excludes rooflines, ground-level steps, car porches, transformer areas, balconies, canopies, staircases, and compound walls from taxable-building counts.

### Classes

- Residential
- Commercial
- Mixed Use
- Industrial
- Public & Semi Public
- Dilapidated
- Under Construction
- Other / Miscellaneous
- Unclassified

## Files added

- `frontend/src/lib/propertyTax.ts`
- `frontend/src/components/PropertyTaxPanel.tsx`
- `frontend/property-tax-preview.html`
- `frontend/START_PROPERTY_TAX_PREVIEW.bat`
- `START_PROPERTY_TAX_APP.bat`

## Files modified

- `frontend/src/components/MapCanvas.tsx`
- `frontend/src/index.css`

## Classification logic

The classifier first checks whether a polygon is a principal building. It uses semantic source-layer attributes such as `Layer`, then confirms building characteristics such as `Type_of_Building`. Known auxiliary geometry is excluded. For principal buildings, floor/building-use fields such as `G_Floor_Information` are preferred, with the source layer used as fallback.

The original GIS attributes are not overwritten. Internal display-only properties are attached to the rendered GeoJSON.

## Ward-09 validation

- All building-related polygons: 886
- Principal buildings: 608
- Auxiliary polygons excluded: 278
- Commercial: 281
- Residential: 209
- Mixed Use: 90
- Public & Semi Public: 15
- Dilapidated: 11
- Industrial: 2

## Validation completed

- Frontend TypeScript project check: passed using `tsc -b`.
- Backend Python compilation: unchanged and previously passed.
- Classification logic validated against five uploaded ward GeoPackages.
- Static visual preview generated from the real Ward-09 geometries.

A full Linux production bundle was not generated in the review sandbox because the uploaded `node_modules` directory contains Windows-specific native packages. The included Docker launcher rebuilds the frontend inside the correct container environment on the project machine.

## Run the complete application

From the project root, double-click:

`START_PROPERTY_TAX_APP.bat`

Then open:

`http://localhost:3000/map`

Click **Property Tax** in the map toolbar.

## Run only the visual preview

From the `frontend` folder, double-click:

`START_PROPERTY_TAX_PREVIEW.bat`

Then open:

`http://localhost:3000/property-tax-preview.html`
