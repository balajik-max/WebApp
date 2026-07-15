import asyncio
from collections import Counter
from uuid import UUID

from app.db.session import SessionLocal
from app.services.manhole_recommend import scan_all_manhole_recommendations

DATASET_ID = UUID("a63e0286-20bc-4b76-acbe-f1df8b04fff4")


async def main():
    async with SessionLocal() as db:
        recs = await scan_all_manhole_recommendations(DATASET_ID, db)
    counts = Counter(r.problem_type for r in recs)
    print("TOTAL manholes scanned:", len(recs))
    print("problem_type counts:", dict(counts))
    routed = [r for r in recs if r.route]
    print("manholes WITH a route:", len(routed))
    print("\nFirst 8 routed examples:")
    for r in routed[:8]:
        spec = r.route.pipe_spec
        print(f"  {r.manhole_id[:8]} [{r.problem_type}] pts={len(r.route.coordinates)} "
              f"dia={spec.diameter_mm} from_rl={spec.from_rl} to_rl={spec.to_rl} slope={spec.slope}")
    # negative-slope (uphill) check
    uphill = [r for r in routed if r.route.pipe_spec.slope is not None and r.route.pipe_spec.slope < 0]
    print("\nuphill (negative-slope) routes:", len(uphill))

asyncio.run(main())
