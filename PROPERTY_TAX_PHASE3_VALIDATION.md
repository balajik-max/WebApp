# Property Tax Phase 3 Validation

Validated on the packaged source:

- Frontend TypeScript project check: passed (`tsc -b`).
- Property-tax frontend lint check: passed.
- Backend Python source compilation: passed.
- Municipal register CSV template: created and readable.
- Municipal register XLSX template: created, reopened, and verified with its table and dropdown validations.
- Docker live-stack launch was not executed in this build environment because Docker is unavailable; the included launcher rebuilds and starts the stack locally.

## Main test path

1. Open `/map` and activate Property Tax.
2. Select a principal building.
3. Download the municipal-register template or import CSV/XLSX.
4. Verify exact/spatial/manual linking and populated official fields.
5. Review GIS comparison.
6. Enter whole-building or floor-wise rates and factors.
7. Save through Draft / Verification Pending / Verified / Approved.
8. Generate the annual demand.
9. Open History and confirm immutable versions.
