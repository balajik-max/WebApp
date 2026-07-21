from __future__ import annotations

import asyncio
import inspect
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

from app.api import deps
from app.api.v1 import ai, point_verifications
from app.main import app
from app.models.point_verification import RemediationWorkflowStatus
from app.models.spatial_anomaly import AnomalyColor, AnomalyStatus, AnomalyType, SpatialAnomaly
from app.models.user import User, UserRole
from app.schemas.ai import AnomalyStatusUpdate
from app.schemas.point_verification import AeeDecisionIn, FieldSubmissionIn

BACKEND_ROOT = Path(__file__).resolve().parents[1]


def user(role: UserRole, *, active: bool = True) -> User:
    return User(
        id=uuid.uuid4(),
        name=role.value.upper(),
        email=f"{role.value}@example.test",
        password_hash="unused",
        role=role,
        is_active=active,
    )


class _ScalarResult:
    def __init__(self, value: object) -> None:
        self.value = value

    def scalar_one_or_none(self) -> object:
        return self.value


class _Db:
    def __init__(self, value: object) -> None:
        self.value = value

    async def execute(self, _statement: object) -> _ScalarResult:
        return _ScalarResult(self.value)


class DirectWorkflowContractTests(unittest.TestCase):
    def test_only_canonical_statuses_exist(self) -> None:
        self.assertEqual(
            [status.value for status in RemediationWorkflowStatus],
            [
                "AI_DETECTED",
                "WORK_IN_PROGRESS",
                "PENDING_AEE_APPROVAL",
                "RETURNED_BY_AEE",
                "AEE_APPROVED",
                "COMMISSIONER_ACCEPTED",
            ],
        )

    def test_ae_is_the_only_field_worker(self) -> None:
        self.assertEqual(asyncio.run(deps.require_ae(user(UserRole.AE))).role, UserRole.AE)
        for role in (UserRole.AEE, UserRole.COMMISSIONER, UserRole.MLA):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(deps.require_ae(user(role)))
            self.assertEqual(raised.exception.status_code, 403)

    def test_aee_is_the_only_reviewer(self) -> None:
        self.assertEqual(asyncio.run(deps.require_aee(user(UserRole.AEE))).role, UserRole.AEE)
        for role in (UserRole.AE, UserRole.COMMISSIONER, UserRole.MLA):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(deps.require_aee(user(role)))
            self.assertEqual(raised.exception.status_code, 403)

    def test_only_commissioner_can_accept(self) -> None:
        self.assertEqual(asyncio.run(deps.require_commissioner(user(UserRole.COMMISSIONER))).role, UserRole.COMMISSIONER)
        for role in (UserRole.AE, UserRole.AEE, UserRole.MLA):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(deps.require_commissioner(user(role)))
            self.assertEqual(raised.exception.status_code, 403)

    def test_mla_write_is_blocked_before_route_logic(self) -> None:
        mla = user(UserRole.MLA)
        request = Request({
            "type": "http",
            "method": "POST",
            "path": "/api/v1/point-verifications/example/start-work",
            "headers": [(b"authorization", b"Bearer test-token")],
            "query_string": b"",
            "server": ("test", 80),
        })
        with patch.object(deps, "decode_token", return_value={"type": "access", "sub": str(mla.id)}):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(deps.get_current_user(request, _Db(mla)))  # type: ignore[arg-type]
        self.assertEqual(raised.exception.status_code, 403)

    def test_ae_form_contract_is_small_and_manual_name_is_required(self) -> None:
        self.assertEqual(
            set(FieldSubmissionIn.model_fields),
            {"anomaly_id", "detection_mode", "ae_name", "issue_description", "work_completed", "remarks"},
        )
        forbidden = {"assigned_to", "priority", "target_date", "contractor", "material", "quantity", "latitude", "longitude"}
        self.assertTrue(forbidden.isdisjoint(FieldSubmissionIn.model_fields))

    def test_aee_return_requires_remarks(self) -> None:
        with self.assertRaises(ValueError):
            AeeDecisionIn(anomaly_id=uuid.uuid4(), aee_name="AEE One", category="MODERATE", remarks="  ")
        self.assertEqual(
            AeeDecisionIn(anomaly_id=uuid.uuid4(), aee_name="AEE One", category="GOOD").category,
            "GOOD",
        )

    def test_required_endpoints_and_buffers(self) -> None:
        paths = app.openapi()["paths"]
        required = {
            "/api/v1/point-verifications/{feature_id}/start-work": "post",
            "/api/v1/point-verifications/{feature_id}/evidence": "put",
            "/api/v1/point-verifications/{feature_id}/submit": "post",
            "/api/v1/point-verifications/{feature_id}/aee-decision": "post",
            "/api/v1/point-verifications/{feature_id}/commissioner-accept": "post",
        }
        for path, method in required.items():
            self.assertIn(method, paths[path])
        self.assertEqual(point_verifications._BUFFER_BY_MODE, {"poles": 15.0, "drains": 30.0, "manholes": 15.0})

    def test_blue_projection_requires_aee_good_approval(self) -> None:
        anomaly = SpatialAnomaly(
            id=uuid.uuid4(),
            dataset_id=uuid.uuid4(),
            ward="test",
            anomaly_type=AnomalyType.MANHOLE_STATUS,
            color=AnomalyColor.RED,
            severity_score=90,
            status=AnomalyStatus.RESOLVED,
            feature_ids=[],
            anomaly_metadata={},
            created_at=datetime.now(timezone.utc),
        )
        self.assertEqual(ai._anomaly_out(anomaly, 75.9, 14.4).status, "reviewing")
        self.assertEqual(ai._anomaly_out(anomaly, 75.9, 14.4, aee_approved=True).status, "resolved")

    def test_legacy_manual_anomaly_status_route_always_conflicts(self) -> None:
        with self.assertRaises(HTTPException) as raised:
            asyncio.run(ai.update_anomaly_status(
                uuid.uuid4(),
                AnomalyStatusUpdate(status="reviewing"),
                user(UserRole.AE),
                _Db(None),  # type: ignore[arg-type]
            ))
        self.assertTrue(inspect.iscoroutinefunction(ai.update_anomaly_status))
        self.assertEqual(raised.exception.status_code, 409)

    def test_ai_rerun_protects_every_non_initial_workflow_state(self) -> None:
        source = (BACKEND_ROOT / "app" / "services" / "spatial_audit.py").read_text(encoding="utf-8")
        for status in ("WORK_IN_PROGRESS", "PENDING_AEE_APPROVAL", "RETURNED_BY_AEE", "AEE_APPROVED", "COMMISSIONER_ACCEPTED"):
            self.assertIn(f"RemediationWorkflowStatus.{status}", source)


if __name__ == "__main__":
    unittest.main()
