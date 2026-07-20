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
from app.schemas.point_verification import CommissionerDecisionIn, FieldSubmissionIn
from app.schemas.ai import AnomalyStatusUpdate


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
                "PENDING_COMMISSIONER_APPROVAL",
                "REJECTED_BY_COMMISSIONER",
                "APPROVED_RESOLVED",
            ],
        )

    def test_ae_and_aee_share_the_same_guard(self) -> None:
        for role in (UserRole.AE, UserRole.AEE):
            allowed = asyncio.run(deps.require_field_officer(user(role)))
            self.assertEqual(allowed.role, role)
        for role in (UserRole.COMMISSIONER, UserRole.MLA):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(deps.require_field_officer(user(role)))
            self.assertEqual(raised.exception.status_code, 403)

    def test_only_commissioner_can_decide(self) -> None:
        allowed = asyncio.run(deps.require_commissioner(user(UserRole.COMMISSIONER)))
        self.assertEqual(allowed.role, UserRole.COMMISSIONER)
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
        with patch.object(
            deps,
            "decode_token",
            return_value={"type": "access", "sub": str(mla.id)},
        ):
            with self.assertRaises(HTTPException) as raised:
                asyncio.run(deps.get_current_user(request, _Db(mla)))  # type: ignore[arg-type]
        self.assertEqual(raised.exception.status_code, 403)

    def test_field_form_contract_has_no_assignment_or_long_form_fields(self) -> None:
        self.assertEqual(
            set(FieldSubmissionIn.model_fields),
            {"anomaly_id", "detection_mode", "issue_solved", "short_description", "remarks"},
        )
        forbidden = {
            "assigned_to", "assigned_by", "priority", "target_date", "contractor",
            "team", "material", "quantity", "latitude", "longitude", "aee_recommendation",
        }
        self.assertTrue(forbidden.isdisjoint(FieldSubmissionIn.model_fields))
        with self.assertRaises(ValueError):
            FieldSubmissionIn(
                anomaly_id=uuid.uuid4(),
                detection_mode="poles",
                issue_solved=False,
                short_description="completed",
            )

    def test_commissioner_rejection_requires_reason(self) -> None:
        with self.assertRaises(ValueError):
            CommissionerDecisionIn(anomaly_id=uuid.uuid4(), decision="REJECT", reason="  ")
        approved = CommissionerDecisionIn(anomaly_id=uuid.uuid4(), decision="APPROVE")
        self.assertEqual(approved.decision, "APPROVE")

    def test_required_endpoints_and_buffers(self) -> None:
        paths = app.openapi()["paths"]
        required = {
            "/api/v1/point-verifications/{feature_id}/start-work": "post",
            "/api/v1/point-verifications/{feature_id}/evidence": "put",
            "/api/v1/point-verifications/{feature_id}/submit": "post",
            "/api/v1/point-verifications/{feature_id}/commissioner-decision": "post",
        }
        for path, method in required.items():
            self.assertIn(method, paths[path])
        serialized = "\n".join(paths).lower()
        self.assertNotIn("architect-submit", serialized)
        self.assertNotIn("admin-decision", serialized)
        self.assertNotIn("aee-review", serialized)
        self.assertNotIn("recommendation", serialized)
        self.assertEqual(point_verifications._BUFFER_BY_MODE, {"poles": 15.0, "drains": 30.0, "manholes": 15.0})

    def test_blue_projection_requires_commissioner_approval(self) -> None:
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
        self.assertEqual(
            ai._anomaly_out(anomaly, 75.9, 14.4, commissioner_approved=True).status,
            "resolved",
        )

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
        for status in (
            "WORK_IN_PROGRESS",
            "PENDING_COMMISSIONER_APPROVAL",
            "REJECTED_BY_COMMISSIONER",
            "APPROVED_RESOLVED",
        ):
            self.assertIn(f"RemediationWorkflowStatus.{status}", source)


if __name__ == "__main__":
    unittest.main()
