# Property Tax Phase 2.1 Stabilization

Open the application at `http://localhost:3000/map` and select **Property Tax**.

This build fixes the reported map interaction defects:

- Tax mode reuses the existing GIS polygon source instead of stacking a second visualization.
- Non-building survey polygons, lines, points and attribute-visualization overlays are hidden while Tax mode is active.
- Only principal buildings remain selectable; ward boundaries can no longer capture building clicks.
- Generic GIS hover cards are suppressed in Tax mode.
- Selecting a building closes the classification panel and opens the Phase 2 property assessment panel.
- Reopening the classification panel closes the assessment panel, preventing panel overlap.
- Category selection is now a real map filter; non-selected classes are removed rather than faintly left underneath.
- The same tax style is applied in street, satellite, off and cadastral basemaps.
- The selected building receives a clear focus outline.
- Building-use and building-type field recognition has been expanded for different ward/vendor schemas.

Validation completed:

- Frontend TypeScript compilation: passed.
- Changed-file ESLint: no errors (existing project warnings remain).
- Backend Python compilation: passed.
- Property classification smoke tests: passed.
