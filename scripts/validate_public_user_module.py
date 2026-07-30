#!/usr/bin/env python3
"""Dependency-light structural validation for the public user module.

This script does not replace the normal TypeScript build, pytest, or Docker
acceptance run. It catches accidental route/cookie/notification collisions
before those heavier checks are started.
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def require(path: str, *needles: str) -> None:
    target = ROOT / path
    if not target.is_file():
        raise AssertionError(f"Missing required file: {path}")
    text = target.read_text(encoding="utf-8")
    for needle in needles:
        if needle not in text:
            raise AssertionError(f"{path} is missing required content: {needle}")


def forbid(path: str, *needles: str) -> None:
    text = (ROOT / path).read_text(encoding="utf-8")
    for needle in needles:
        if needle in text:
            raise AssertionError(f"{path} contains forbidden collision: {needle}")


def main() -> int:
    for python_file in (ROOT / "backend" / "app").rglob("*.py"):
        try:
            ast.parse(python_file.read_text(encoding="utf-8-sig"), filename=str(python_file))
        except SyntaxError as exc:
            raise AssertionError(f"Backend Python syntax failed: {python_file}: {exc}") from exc

    require(
        "frontend/src/App.tsx",
        'path="/login"',
        'path="/public/login"',
        'path="/public/register"',
        'path="/public/dashboard"',
        'path="/public-complaints/:complaintId"',
    )
    require(
        "frontend/src/components/public/PublicPortalHeader.tsx",
        '<span>Officer Login</span>',
        'to="/login"',
    )
    require(
        "frontend/src/pages/WelcomeView.tsx",
        'to="/public/login"',
        'to="/public/register"',
    )
    require(
        "backend/app/api/v1/public_auth.py",
        'public_access_token',
        'public_refresh_token',
        'public_session_id',
    )
    forbid(
        "backend/app/api/v1/public_auth.py",
        'response.set_cookie("access_token"',
        'response.set_cookie("refresh_token"',
    )
    require(
        "backend/app/api/v1/public_complaints.py",
        'UserRole.AE',
        'UserRole.AEE',
        'UserRole.COMMISSIONER',
        'message="Authority viewed your problem."',
        'with_for_update(of=PublicComplaint)',
    )
    require(
        "frontend/src/components/WorkspaceLayout.tsx",
        'Promise.allSettled',
        'Unable to load workflow notifications',
        'Unable to load public complaint notifications',
    )
    require(
        "frontend/src/context/PublicAuthContext.tsx",
        'davangere.public-user',
    )
    require(
        "backend/app/models/public_portal.py",
        '__tablename__ = "public_users"',
        '__tablename__ = "public_complaints"',
        '__tablename__ = "public_notifications"',
    )

    print("Public user module structural validation: PASS")
    print("Officer and public routes/cookies remain separately named.")
    print("Run frontend build, pytest, and Docker acceptance checks next.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f"VALIDATION FAILED: {exc}", file=sys.stderr)
        raise SystemExit(1)
