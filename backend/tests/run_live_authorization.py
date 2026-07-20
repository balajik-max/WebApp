"""Read-only HTTP authorization proof using short-lived signed test tokens."""
from __future__ import annotations

import asyncio
import uuid
from urllib.parse import quote

import httpx
from sqlalchemy import select

from app.core.security import create_access_token
from app.db.session import SessionLocal, engine
from app.models import User, UserRole


async def main() -> None:
    async with SessionLocal() as session:
        users = {
            role: (
                await session.execute(select(User).where(User.role == role, User.is_active.is_(True)).limit(1))
            ).scalar_one()
            for role in (UserRole.AE, UserRole.AEE, UserRole.COMMISSIONER, UserRole.MLA)
        }

    headers = {
        role: {
            "Authorization": "Bearer " + create_access_token(
                user_id=current.id,
                email=current.email,
                role=current.role.value,
            )
        }
        for role, current in users.items()
    }
    missing_feature = uuid.uuid4()
    missing_anomaly = uuid.uuid4()
    start_payload = {"anomaly_id": str(missing_anomaly), "detection_mode": "poles"}
    decision_payload = {"anomaly_id": str(missing_anomaly), "decision": "APPROVE"}

    async with httpx.AsyncClient(base_url="http://127.0.0.1:8001", timeout=20) as client:
        datasets_response = await client.get("/api/v1/datasets?limit=200", headers=headers[UserRole.MLA])
        assert datasets_response.status_code == 200
        datasets = datasets_response.json()
        assert isinstance(datasets, list) and datasets
        for path in (
            "/api/v1/features?bbox=-180,-90,180,90&limit=1",
            "/api/v1/analytics/overview",
            "/api/v1/analytics/quality",
            "/api/v1/analytics/manhole-readiness",
            "/api/v1/classification/classes",
            "/api/v1/system/storage",
            "/api/v1/visualization/dashboard-types",
        ):
            response = await client.get(path, headers=headers[UserRole.MLA])
            assert response.status_code == 200, (path, response.status_code, response.text[:200])

        ready = [row for row in datasets if row.get("status") == "ready"]
        vector = next((row for row in ready if row.get("file_type") not in {"las", "geotiff", "image"} and not row.get("dataset_metadata", {}).get("model_assets")), None)
        raster = next((row for row in ready if row.get("file_type") == "geotiff"), None)
        las = next((row for row in ready if row.get("file_type") == "las"), None)
        model = next((row for row in ready if row.get("dataset_metadata", {}).get("model_assets")), None)
        if vector:
            for path in (
                f"/api/v1/datasets/{vector['id']}/bounds",
                f"/api/v1/visualization/datasets/{vector['id']}/manifest",
            ):
                response = await client.get(path, headers=headers[UserRole.MLA])
                assert response.status_code == 200, (path, response.status_code, response.text[:200])
            anomalies = await client.get(
                f"/api/v1/ai/audit/anomalies?dataset_id={vector['id']}",
                headers=headers[UserRole.MLA],
            )
            assert anomalies.status_code == 200
        if raster:
            preview = await client.get(
                f"/api/v1/datasets/{raster['id']}/raster-preview.png?mode=rgb",
                headers=headers[UserRole.MLA],
            )
            assert preview.status_code == 200 and preview.headers.get("content-type", "").startswith("image/")
        if las:
            preview = await client.get(
                f"/api/v1/datasets/{las['id']}/point-cloud-preview?max_points=10000",
                headers=headers[UserRole.MLA],
            )
            assert preview.status_code == 200, (preview.status_code, preview.text[:200])
        if model:
            assets = model["dataset_metadata"]["model_assets"]
            asset_path = assets.get("obj_filename") or assets.get("obj_key", "").split("/")[-1]
            if asset_path:
                response = await client.get(
                    f"/api/v1/datasets/{model['id']}/model-asset/{quote(asset_path, safe='')}",
                    headers=headers[UserRole.MLA],
                )
                assert response.status_code == 200

        assert (await client.get("/api/v1/point-verifications/inbox", headers=headers[UserRole.COMMISSIONER])).status_code == 200
        assert (await client.get(
            f"/api/v1/point-verifications/export-resolved-gdb?dataset_id={uuid.uuid4()}",
            headers=headers[UserRole.MLA],
        )).status_code == 403

        for role in (UserRole.AE, UserRole.AEE):
            assert (await client.post(
                f"/api/v1/point-verifications/{missing_feature}/start-work",
                json=start_payload,
                headers=headers[role],
            )).status_code == 404
            assert (await client.post(
                f"/api/v1/point-verifications/{missing_feature}/commissioner-decision",
                json=decision_payload,
                headers=headers[role],
            )).status_code == 403

        assert (await client.post(
            f"/api/v1/point-verifications/{missing_feature}/start-work",
            json=start_payload,
            headers=headers[UserRole.COMMISSIONER],
        )).status_code == 403

        mla_writes = [
            await client.post(
                f"/api/v1/point-verifications/{missing_feature}/start-work",
                json=start_payload,
                headers=headers[UserRole.MLA],
            ),
            await client.post(
                f"/api/v1/point-verifications/{missing_feature}/submit",
                json={
                    **start_payload,
                    "issue_solved": True,
                    "short_description": "must be forbidden",
                },
                headers=headers[UserRole.MLA],
            ),
            await client.post(
                f"/api/v1/point-verifications/{missing_feature}/commissioner-decision",
                json=decision_payload,
                headers=headers[UserRole.MLA],
            ),
            await client.put(
                f"/api/v1/point-verifications/{missing_feature}/evidence",
                data={"anomaly_id": str(missing_anomaly), "detection_mode": "poles"},
                headers=headers[UserRole.MLA],
            ),
            await client.patch(
                f"/api/v1/ai/audit/anomalies/{missing_anomaly}",
                json={"status": "reviewing"},
                headers=headers[UserRole.MLA],
            ),
        ]
        assert [response.status_code for response in mla_writes] == [403, 403, 403, 403, 403]

    await engine.dispose()
    probed = [name for name, row in (("vector/GDB", vector), ("raster", raster), ("LAS/LAZ", las), ("3D OBJ", model)) if row]
    print("PASS: live HTTP RBAC and read-only regressions — " + ", ".join(probed) + ", analytics, classification, storage, AI, visualization")


if __name__ == "__main__":
    asyncio.run(main())
