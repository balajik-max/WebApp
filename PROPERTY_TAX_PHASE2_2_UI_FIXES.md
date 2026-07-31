# Property Tax Phase 2.2 UI Stability Fix

## Fixed

- Assessment card is wider, taller, scroll-safe, and uses larger high-contrast text and form controls.
- Closing a building assessment now restores the Building Classification panel while keeping Property Tax mode and the active class filter intact.
- The assessment card can be dragged by its header and constrained inside the map workspace. Double-click the header to restore its default position.
- Footer buttons remain visible because the form body scrolls independently.
- Desktop, smaller-screen, dark-theme, and light-theme styles were tightened.

## Validation

- Frontend TypeScript check passed.
- Targeted ESLint completed with no errors (existing MapCanvas warnings remain unchanged).
- Backend Python compilation passed.
- Final Vite bundle was not generated in the sandbox because the uploaded dependency tree contains Windows-native Rollup packages. Docker rebuilds dependencies for the correct platform.
