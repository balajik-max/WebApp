# V3.1 Frontend Build Fix

## Issue fixed

The V3 package added the `roads` detection mode for Quick Analysis and Road Inspection, while the existing AE -> AEE -> Commissioner remediation workflow intentionally supports only:

- poles
- drains
- manholes

The shared map verification context was accidentally widened to include `roads`, which caused TypeScript build errors in the legacy and operational point-verification panels.

## Safe resolution

- Road findings remain available in Quick Analysis and Road Inspection.
- Road mode is not passed into the remediation workflow API.
- Existing AE Tasks, AEE Activity, Commissioner approval, Blue-state logic, Layer Review, and legacy Architect/Admin workflows remain unchanged.
- No database or Docker volume changes are required.

## Changed file

- `frontend/src/components/MapCanvas.tsx`

## Runtime expectation

Rebuild the frontend and backend with Docker Compose. The frontend TypeScript errors mentioning `"roads" is not assignable to type AiDetectionMode` should no longer occur.
