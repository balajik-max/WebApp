"""Scoped upload/ingestion/list/delete smoke test for the existing GIS path."""
from __future__ import annotations

import asyncio
import json
import uuid

import httpx
from sqlalchemy import select

from app.core.security import create_access_token
from app.db.session import SessionLocal, engine
from app.models import User, UserRole


async def main() -> None:
    async with SessionLocal() as session:
        ae = (
            await session.execute(select(User).where(User.role == UserRole.AE, User.is_active.is_(True)).limit(1))
        ).scalar_one()
    token = create_access_token(user_id=ae.id, email=ae.email, role=ae.role.value)
    headers = {"Authorization": f"Bearer {token}"}
    marker = uuid.uuid4().hex[:10]
    dataset_id: str | None = None
    feature_collection = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [75.9218, 14.4644]},
                "properties": {"FID": f"SMOKE-{marker}", "Condition": "Good", "Asset_Type": "Smoke Test"},
            }
        ],
    }

    async with httpx.AsyncClient(base_url="http://127.0.0.1:8001", timeout=30) as client:
        try:
            upload = await client.post(
                "/api/v1/datasets/upload",
                headers=headers,
                data={"name": f"workflow-upload-smoke-{marker}", "ward": "Automated Smoke Test"},
                files={
                    "file": (
                        f"workflow-upload-smoke-{marker}.geojson",
                        json.dumps(feature_collection).encode("utf-8"),
                        "application/geo+json",
                    )
                },
            )
            assert upload.status_code == 202, (upload.status_code, upload.text[:500])
            dataset_id = upload.json()["dataset"]["id"]

            state: dict = {}
            for _ in range(40):
                poll = await client.get(f"/api/v1/datasets/{dataset_id}", headers=headers)
                assert poll.status_code == 200
                state = poll.json()
                if state.get("status") in {"ready", "failed"}:
                    break
                await asyncio.sleep(0.25)
            assert state.get("status") == "ready", state.get("processing_error")

            listed = await client.get("/api/v1/datasets?limit=200", headers=headers)
            assert listed.status_code == 200
            assert any(row["id"] == dataset_id for row in listed.json())
            features = await client.get(f"/api/v1/datasets/{dataset_id}/features", headers=headers)
            assert features.status_code == 200
            assert features.json().get("total") == 1
        finally:
            if dataset_id:
                deleted = await client.delete(f"/api/v1/datasets/{dataset_id}", headers=headers)
                assert deleted.status_code == 204, (deleted.status_code, deleted.text[:500])

    await engine.dispose()
    print("PASS: scoped GeoJSON upload, ingestion, dataset listing, feature read, and cleanup")


if __name__ == "__main__":
    asyncio.run(main())
