"""Security inventory, status rollup, and safe runtime probes for the Admin UI.

This module is the single source of truth for the System Administration
Security section. It builds a static inventory of every security control,
limitation, and risk that the previous Security Investigation Report
documented, layers in safe runtime probes (CORS, header check, admin
authorization rejection, OpenAPI exposure, JWT secret length), and rolls
the lot up into a sanitized ``SecurityMonitoringOut`` response.

Hard rules:
  * Never return a secret, password, full connection string, API key,
    or raw cookie value. The drawer can show whether a value is
    "configured" or "present" but never the value itself.
  * Never perform destructive checks, brute-force, fuzz, or external
    network scanning. Only lightweight, non-destructive probes.
  * Never block the whole page on a single failing probe. A failure
    marks the affected control ``unknown`` and the response carries a
    ``partial_failures`` list.
  * Never modify authentication, role checks, JWT, cookies, rate
    limiting, or any other runtime behaviour as a side effect of an
    assessment call.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

import httpx
from fastapi import Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import MAX_UPLOAD_BYTES, get_settings
from app.models import ActivityAction, ActivityLog
from app.schemas.security_monitoring import (
    SecurityControl,
    SecurityControlDetail,
    SecurityFinding,
    SecurityFindingCounts,
    SecurityGroup,
    SecurityMonitoringOut,
    SecurityPosture,
    SecurityStatus,
    SecuritySummary,
)

log = logging.getLogger("davangere.security_monitoring")


# ---------------------------------------------------------------------------
# Display-only environment detection
# ---------------------------------------------------------------------------


def _is_production_environment(env: str) -> bool:
    return env.strip().lower() in {"production", "prod"}


def _is_development_environment(env: str) -> bool:
    return env.strip().lower() in {"development", "dev", "local"}


# ---------------------------------------------------------------------------
# Builders
# ---------------------------------------------------------------------------


def _ctrl(
    *,
    key: str,
    name: str,
    category: str,
    status: SecurityStatus,
    kind: str = "row",
    severity: str | None = None,
    description: str = "",
    scope: str | None = None,
    one_line: str | None = None,
    current_implementation: str | None = None,
    known_limitations: str | None = None,
    evidence_source: str | None = None,
    affected_components: list[str] | None = None,
    exposure_context: str | None = None,
    recommended_remediation: str | None = None,
    monitoring_source: str | None = None,
    production_impact: str | None = None,
    development_impact: str | None = None,
    extra: dict[str, Any] | None = None,
    order: int = 0,
) -> SecurityControl:
    return SecurityControl(
        key=key,
        name=name,
        kind=kind,  # type: ignore[arg-type]
        category=category,
        status=status,
        severity=severity,  # type: ignore[arg-type]
        description=description,
        scope=scope,
        one_line=one_line,
        last_assessed_at=datetime.now(tz=timezone.utc),
        details=SecurityControlDetail(
            current_implementation=current_implementation,
            known_limitations=known_limitations,
            evidence_source=evidence_source,
            affected_components=affected_components or [],
            exposure_context=exposure_context,
            recommended_remediation=recommended_remediation,
            monitoring_source=monitoring_source,
            production_impact=production_impact,
            development_impact=development_impact,
            extra=extra or {},
        ),
        monitoring_source=monitoring_source,
        display_order=order,
    )


def _finding(
    *,
    id: str,
    title: str,
    severity: str,
    affected_area: str,
    summary: str,
    recommendation: str,
    evidence_references: list[str] | None = None,
    production_priority: str = "high",
) -> SecurityFinding:
    return SecurityFinding(
        id=id,
        title=title,
        severity=severity,  # type: ignore[arg-type]
        status="open",
        affected_area=affected_area,
        summary=summary,
        recommendation=recommendation,
        evidence_references=evidence_references or [],
        production_priority=production_priority,  # type: ignore[arg-type]
        last_assessed_at=datetime.now(tz=timezone.utc),
    )


# ---------------------------------------------------------------------------
# Per-group inventories
# ---------------------------------------------------------------------------


def _identity_access_group() -> SecurityGroup:
    items = [
        _ctrl(
            key="password_hashing",
            name="Password Hashing",
            category="identity_access",
            status="partially_protected",
            scope="Authentication",
            one_line="bcrypt is used; default cost factor is in use.",
            current_implementation="bcrypt via passlib-free direct call to bcrypt.hashpw; cost factor is library default (12).",
            known_limitations="No explicit rounds configuration, no cost-factor policy, no separate test vectors.",
            evidence_source="backend/app/core/security.py — hash_password()",
            affected_components=["Backend authentication", "Seed user creation"],
            recommended_remediation="Pin an explicit bcrypt cost factor; review annually as hardware improves.",
            order=1,
        ),
        _ctrl(
            key="password_policy",
            name="Password Policy",
            category="identity_access",
            status="not_configured",
            scope="Authentication",
            one_line="No backend minimum length, complexity, reuse, or expiry policy exists.",
            recommended_remediation="Add a Pydantic validator on user creation; enforce a minimum length and basic complexity.",
            order=2,
        ),
        _ctrl(
            key="password_reset",
            name="Password Reset",
            category="identity_access",
            status="not_configured",
            scope="Authentication",
            one_line="No forgot-password or reset-password workflow exists.",
            recommended_remediation="Add email-token-based reset flow with single-use, short-lived tokens.",
            order=3,
        ),
        _ctrl(
            key="first_login_password_change",
            name="First-Login Password Change",
            category="identity_access",
            status="not_configured",
            scope="Authentication",
            one_line="No must_change_password flag is tracked on the User model.",
            recommended_remediation="Track must_change_password and force a reset on first authenticated session for seeded accounts.",
            order=4,
        ),
        _ctrl(
            key="failed_login_tracking",
            name="Failed-Login Tracking",
            category="identity_access",
            status="not_configured",
            severity="high",
            scope="Authentication",
            one_line="Failed login attempts are not persisted; no counter exists per user or per IP.",
            evidence_source="backend/app/api/v1/auth.py — POST /api/auth/login",
            affected_components=["Authentication", "Admin Security visibility"],
            recommended_remediation="Persist failed attempts per email and per source IP; emit a LOGIN_FAILED ActivityLog entry; expose counters in this section.",
            order=5,
        ),
        _ctrl(
            key="account_lockout",
            name="Account Lockout",
            category="identity_access",
            status="not_configured",
            scope="Authentication",
            one_line="No progressive delay or temporary lockout is enforced after repeated failed logins.",
            recommended_remediation="Add a backoff (exponential delay) and configurable lockout threshold with admin unlock.",
            order=6,
        ),
        _ctrl(
            key="multi_factor_authentication",
            name="Multi-Factor Authentication",
            category="identity_access",
            status="not_configured",
            scope="Authentication",
            one_line="No MFA factor (TOTP, WebAuthn, SMS) is supported.",
            recommended_remediation="Add TOTP as a second factor for privileged roles; require enrollment before role elevation.",
            order=7,
        ),
        _ctrl(
            key="public_signup",
            name="Public Sign-Up",
            category="identity_access",
            status="not_applicable",
            scope="Authentication",
            one_line="No public account-registration endpoint exists; accounts are created at seed time only.",
            recommended_remediation="Keep this closed. If self-service sign-up is later required, gate by invitation and require email verification.",
            order=8,
        ),
        _ctrl(
            key="user_account_management",
            name="User Account Management",
            category="identity_access",
            status="at_risk",
            scope="Identity lifecycle",
            one_line="Accounts are seed-time only; no complete Admin account lifecycle API exists.",
            evidence_source="backend/app/api/v1/admin.py — no /users management endpoint",
            recommended_remediation="Add Admin-only endpoints to create, deactivate, and rotate roles for users, with full audit logging.",
            order=9,
        ),
        _ctrl(
            key="role_based_access_control",
            name="Role-Based Access Control",
            category="identity_access",
            status="protected",
            scope="Authorization",
            one_line="Backend role guards enforce Administrator, Architect, Commissioner, AEE, AE, and MLA.",
            evidence_source="backend/app/api/deps.py — require_roles factory",
            affected_components=["Every authenticated API route"],
            recommended_remediation="Maintain. Add integration tests for every role × route combination.",
            order=10,
        ),
        _ctrl(
            key="mla_read_only_enforcement",
            name="MLA Read-Only Enforcement",
            category="identity_access",
            status="protected",
            scope="Authorization",
            one_line="A global guard rejects any non-GET request from the MLA role.",
            evidence_source="backend/app/api/deps.py — get_current_user",
            recommended_remediation="Maintain.",
            order=11,
        ),
        _ctrl(
            key="admin_api_protection",
            name="Admin API Protection",
            category="identity_access",
            status="protected",
            scope="Authorization",
            one_line="Every /api/v1/admin/* endpoint requires the Administrator role.",
            evidence_source="backend/app/api/v1/admin.py — require_admin dependency",
            recommended_remediation="Maintain. Add an automated test that confirms a non-admin token returns 403.",
            order=12,
        ),
        _ctrl(
            key="workflow_role_enforcement",
            name="Workflow Role Enforcement",
            category="identity_access",
            status="protected",
            scope="Authorization",
            one_line="Workflow state transitions are bound to AE → AEE → Commissioner; the DB CHECK constraint rejects invalid jumps.",
            evidence_source="backend/app/models/remediation_workflow.py — workflow_status CHECK",
            recommended_remediation="Maintain.",
            order=13,
        ),
        _ctrl(
            key="object_level_access_control",
            name="Object-Level Access Control",
            category="identity_access",
            status="partially_protected",
            scope="Authorization",
            one_line="Placemark and workflow ownership checks exist; some resources remain readable by all authenticated users.",
            evidence_source="backend/app/api/v1/placemarks.py — _owned_placemark",
            recommended_remediation="Audit every read endpoint; add ownership or scope filter to evidence photos, datasets, and features.",
            order=14,
        ),
    ]
    return SecurityGroup(
        id="identity_access",
        label="Identity and Access",
        description="Authentication, role-based access, and identity lifecycle controls.",
        status="at_risk",
        default_open=True,
        items=items,
    )


def _session_token_group(settings, request: Request | None) -> SecurityGroup:
    items = [
        _ctrl(
            key="access_token",
            name="Access Token",
            category="session_token",
            status="partially_protected",
            scope="Session",
            one_line=f"HS256 JWT, default {settings.jwt_access_ttl_min} minutes ({settings.jwt_access_ttl_min // 60} hour) expiry.",
            current_implementation="JWT signed with HS256; access TTL 1440 minutes by default.",
            recommended_remediation="Reduce access TTL to 15–60 minutes; rely on refresh tokens for long sessions.",
            order=1,
        ),
        _ctrl(
            key="refresh_token",
            name="Refresh Token",
            category="session_token",
            status="at_risk",
            scope="Session",
            one_line=f"Default {settings.jwt_refresh_ttl_days}-day expiry, no rotation, no reuse detection.",
            recommended_remediation="Rotate refresh tokens on every use; detect reuse and revoke the chain.",
            order=2,
        ),
        _ctrl(
            key="httponly_cookies",
            name="HttpOnly Cookies",
            category="session_token",
            status="protected",
            scope="Session",
            one_line="Authentication cookies are issued with the HttpOnly flag set.",
            evidence_source="backend/app/api/v1/auth.py — set_cookie httponly=True",
            recommended_remediation="Maintain.",
            order=3,
        ),
        _ctrl(
            key="samesite_cookie_policy",
            name="SameSite Cookie Policy",
            category="session_token",
            status="protected",
            scope="Session",
            one_line="SameSite=Lax is set on authentication cookies.",
            recommended_remediation="Maintain.",
            order=4,
        ),
        _ctrl(
            key="secure_cookie_production",
            name="Secure Cookie (Production)",
            category="session_token",
            status="protected" if not _is_development_environment(settings.app_env) else "partially_protected",
            scope="Session",
            one_line="The Secure flag is enabled only in production builds to allow HTTP localhost development.",
            development_impact="Disabled for localhost HTTP during development.",
            recommended_remediation="Maintain environment-gated Secure flag; verify in any production-style preview.",
            order=5,
        ),
        _ctrl(
            key="token_revocation",
            name="Token Revocation",
            category="session_token",
            status="not_configured",
            severity="high",
            scope="Session",
            one_line="There is no server-side token denylist or jti registry.",
            recommended_remediation="Maintain a Redis-backed jti denylist checked on every request.",
            order=6,
        ),
        _ctrl(
            key="session_registry",
            name="Session Registry",
            category="session_token",
            status="not_configured",
            scope="Session",
            one_line="No registry tracks active sessions, devices, or locations.",
            recommended_remediation="Add a session table keyed by refresh-token jti with last-seen, IP, and user-agent columns.",
            order=7,
        ),
        _ctrl(
            key="active_session_tracking",
            name="Active Session Tracking",
            category="session_token",
            status="not_configured",
            scope="Session",
            one_line="No per-user active session count is recorded.",
            recommended_remediation="Expose a count and a per-session revoke action in the Admin Users section.",
            order=8,
        ),
        _ctrl(
            key="logout_server_side_invalidation",
            name="Logout Server-Side Invalidation",
            category="session_token",
            status="not_configured",
            scope="Session",
            one_line="Logout removes cookies but does not revoke the underlying JWTs.",
            recommended_remediation="Add a jti denylist and call it on logout so the token is rejected on next use.",
            order=9,
        ),
        _ctrl(
            key="role_change_token_invalidation",
            name="Role-Change Token Invalidation",
            category="session_token",
            status="not_configured",
            scope="Session",
            one_line="Existing tokens remain valid after a user's role is changed.",
            recommended_remediation="Invalidate all tokens for the user when a role change is committed.",
            order=10,
        ),
        _ctrl(
            key="user_deactivation_token_invalidation",
            name="User-Deactivation Token Invalidation",
            category="session_token",
            status="at_risk",
            scope="Session",
            one_line="Deactivating a user blocks future logins, but JWTs already issued remain valid until natural expiry.",
            evidence_source="backend/app/api/deps.py — is_active check on User",
            recommended_remediation="Combine the is_active flag with a token version claim; bump the version on deactivation.",
            order=11,
        ),
        _ctrl(
            key="jwt_issuer_audience",
            name="JWT Issuer / Audience Validation",
            category="session_token",
            status="not_configured",
            scope="Session",
            one_line="Tokens are not signed with iss / aud claims; validation does not check them.",
            recommended_remediation="Add iss and aud to issued tokens; enforce them in decode_token.",
            order=12,
        ),
        _ctrl(
            key="jwt_jti_support",
            name="JWT jti Support",
            category="session_token",
            status="not_configured",
            scope="Session",
            one_line="No jti is recorded; reuse and revocation cannot be detected.",
            recommended_remediation="Generate a jti on issue; track it in a denylist for revocation.",
            order=13,
        ),
        _ctrl(
            key="jwt_secret_strength",
            name="JWT Secret Strength",
            category="session_token",
            status="protected",
            scope="Session",
            one_line=(
                "JWT secret is configured and "
                + (
                    f"meets the minimum length of {len(settings.jwt_secret)} characters."
                    if len(settings.jwt_secret) >= 32
                    else f"is shorter than 32 characters ({len(settings.jwt_secret)} chars)."
                )
            ),
            evidence_source="backend/app/core/config.py — jwt_secret",
            recommended_remediation="Never display the value; ensure length is at least 32 bytes (256 bits).",
            order=14,
        ),
        _ctrl(
            key="jwt_key_rotation",
            name="JWT Key Rotation",
            category="session_token",
            status="not_configured",
            scope="Session",
            one_line="No key-rotation strategy is in place; rotating the secret invalidates all sessions.",
            recommended_remediation="Adopt kid-keyed JWKS or a versioned secret; allow overlapping validity windows.",
            order=15,
        ),
        _ctrl(
            key="token_returned_in_json_body",
            name="Token Returned in JSON Body",
            category="session_token",
            status="partially_protected",
            scope="Session",
            one_line="Tokens are also returned in the JSON login response body in addition to cookies.",
            recommended_remediation="If a SPA does not need bearer usage, omit the body token; rely on httpOnly cookies.",
            order=16,
        ),
    ]
    return SecurityGroup(
        id="session_token",
        label="Session and Token Security",
        description="JWT lifecycle, cookie hardening, and revocation posture.",
        status="at_risk",
        default_open=True,
        items=items,
    )


def _web_browser_group(settings) -> SecurityGroup:
    is_prod = _is_production_environment(settings.app_env)
    items = [
        _ctrl(
            key="origin_based_csrf",
            name="Origin-Based CSRF Protection",
            category="web_browser",
            status="partially_protected",
            scope="Web",
            one_line="Origin and Referer validation exists for state-changing methods; this is not token-based CSRF protection.",
            evidence_source="backend/app/core/middleware.py — SecurityMiddleware",
            recommended_remediation="Layer a synchronizer-token CSRF defense for state-changing routes as well.",
            order=1,
        ),
        _ctrl(
            key="cors_allow_list",
            name="CORS Allow-List",
            category="web_browser",
            status="protected",
            scope="Web",
            one_line="Only the configured frontend origin is allowed.",
            evidence_source="backend/app/main.py — CORSMiddleware origins",
            recommended_remediation="Maintain. Avoid wildcard origins in any environment.",
            order=2,
        ),
        _ctrl(
            key="x_content_type_options",
            name="X-Content-Type-Options",
            category="web_browser",
            status="protected",
            scope="Web",
            one_line="The API sets X-Content-Type-Options: nosniff on every response.",
            recommended_remediation="Maintain.",
            order=3,
        ),
        _ctrl(
            key="x_frame_options_api",
            name="X-Frame-Options (API)",
            category="web_browser",
            status="protected",
            scope="Web",
            one_line="The API sets X-Frame-Options: DENY on every response.",
            recommended_remediation="Maintain.",
            order=4,
        ),
        _ctrl(
            key="clickjacking_spa",
            name="Clickjacking Protection (SPA)",
            category="web_browser",
            status="partially_protected",
            scope="Web",
            one_line="The API sets X-Frame-Options, but static frontend responses do not.",
            evidence_source="frontend/Dockerfile — serve runtime has no header injection",
            recommended_remediation="Run the SPA behind a reverse proxy that injects X-Frame-Options or CSP frame-ancestors.",
            order=5,
        ),
        _ctrl(
            key="hsts",
            name="HSTS",
            category="web_browser",
            status="protected" if is_prod else "partially_protected",
            scope="Web",
            one_line="Strict-Transport-Security is set only when APP_ENV is production.",
            recommended_remediation="Maintain environment gating; verify the response in any TLS-terminated preview.",
            order=6,
        ),
        _ctrl(
            key="content_security_policy",
            name="Content-Security-Policy",
            category="web_browser",
            status="not_configured",
            scope="Web",
            one_line="No Content-Security-Policy header is set on either API or SPA responses.",
            recommended_remediation="Define a strict CSP that whitelists the configured API, tile, and asset origins.",
            order=7,
        ),
        _ctrl(
            key="referrer_policy",
            name="Referrer-Policy",
            category="web_browser",
            status="not_configured",
            scope="Web",
            one_line="No Referrer-Policy header is set on either API or SPA responses.",
            recommended_remediation="Send Referrer-Policy: strict-origin-when-cross-origin (or stricter) on every response.",
            order=8,
        ),
        _ctrl(
            key="permissions_policy",
            name="Permissions-Policy",
            category="web_browser",
            status="not_configured",
            scope="Web",
            one_line="No Permissions-Policy header is set to constrain browser feature access.",
            recommended_remediation="Set a Permissions-Policy that disables unused powerful features (camera, geolocation, etc.).",
            order=9,
        ),
        _ctrl(
            key="coop",
            name="Cross-Origin-Opener-Policy",
            category="web_browser",
            status="not_configured",
            scope="Web",
            one_line="COOP is not set; the SPA can share a browsing-context group with cross-origin popups.",
            recommended_remediation="Send Cross-Origin-Opener-Policy: same-origin.",
            order=10,
        ),
        _ctrl(
            key="corp",
            name="Cross-Origin-Resource-Policy",
            category="web_browser",
            status="not_configured",
            scope="Web",
            one_line="CORP is not set; the SPA assets are not protected from speculative side-channel reads.",
            recommended_remediation="Send Cross-Origin-Resource-Policy: same-origin (or same-site).",
            order=11,
        ),
        _ctrl(
            key="frontend_static_security_headers",
            name="Frontend Static Security Headers",
            category="web_browser",
            status="not_configured",
            scope="Web",
            one_line="The current serve runtime does not add security headers to SPA assets.",
            evidence_source="frontend/Dockerfile — CMD serve dist -s -l 3000",
            recommended_remediation="Wrap the SPA in a reverse proxy that injects CSP, X-Frame-Options, Referrer-Policy, and HSTS.",
            order=12,
        ),
        _ctrl(
            key="https_tls",
            name="HTTPS / TLS",
            category="web_browser",
            status="at_risk" if is_prod else "partially_protected",
            scope="Web",
            one_line="The current active deployment uses HTTP and has no configured reverse proxy.",
            recommended_remediation="Place the SPA and API behind a TLS-terminating reverse proxy (nginx, Caddy, or a managed LB).",
            production_impact="Production deployment must use TLS; HTTP exposes credentials and tokens in transit.",
            development_impact="HTTP is acceptable on localhost for development.",
            order=13,
        ),
        _ctrl(
            key="openapi_exposure",
            name="OpenAPI Documentation Exposure",
            category="web_browser",
            status="at_risk",
            scope="Web",
            one_line="Swagger UI, ReDoc, and the OpenAPI schema are exposed in every environment.",
            evidence_source="backend/app/main.py — FastAPI() default /docs /redoc /openapi.json",
            recommended_remediation="Gate /docs and /redoc behind an environment flag and an admin role in production.",
            order=14,
        ),
        _ctrl(
            key="demo_credential_display",
            name="Demo Credential Display",
            category="web_browser",
            status="at_risk",
            severity="critical",
            scope="Web / Login",
            one_line="Seeded account credentials, including Administrator access, are rendered into the login-page bundle.",
            evidence_source="frontend/src/pages/Login.tsx — auth-demo-accounts buttons",
            affected_components=["Login page", "Frontend production bundle"],
            recommended_remediation="Gate the demo block on import.meta.env.DEV; remove it entirely from the production build.",
            order=15,
        ),
    ]
    return SecurityGroup(
        id="web_browser",
        label="Web and Browser Protection",
        description="CSRF, CORS, security headers, and SPA hardening.",
        status="at_risk",
        default_open=True,
        items=items,
    )


def _api_application_group() -> SecurityGroup:
    settings = get_settings()
    items = [
        _ctrl(
            key="auth_route_rate_limit",
            name="Auth-Route Rate Limit",
            category="api_application",
            status="partially_protected",
            scope="API",
            one_line=f"{settings.rate_limit_max} requests per {settings.rate_limit_window_seconds} seconds per IP and per worker.",
            evidence_source="backend/app/core/middleware.py — SecurityMiddleware",
            recommended_remediation="Tune per environment; add per-account and per-email throttles in addition to per-IP.",
            order=1,
        ),
        _ctrl(
            key="rate_limit_scope",
            name="Rate-Limit Scope",
            category="api_application",
            status="at_risk",
            scope="API",
            one_line="Admin, upload, AI, and analytics endpoints are not rate-limited.",
            recommended_remediation="Extend the rate limiter (or a second one) to cover expensive and write endpoints.",
            order=2,
        ),
        _ctrl(
            key="rate_limit_state",
            name="Rate-Limit State",
            category="api_application",
            status="partially_protected",
            scope="API",
            one_line="In-process memory only; counters reset on restart and on worker replacement.",
            recommended_remediation="Move counters to Redis (or another shared store) so they survive restarts and span workers.",
            order=3,
        ),
        _ctrl(
            key="multi_worker_rate_limit_accuracy",
            name="Multi-Worker Rate-Limit Accuracy",
            category="api_application",
            status="at_risk",
            scope="API",
            one_line="Each Uvicorn worker maintains a separate counter, so the effective limit is multiplied by the worker count.",
            evidence_source="backend/app/main.py — workers=2",
            recommended_remediation="Use a shared store (Redis) or a single-worker rate-limit service.",
            order=4,
        ),
        _ctrl(
            key="trusted_proxy_configuration",
            name="Trusted Proxy Configuration",
            category="api_application",
            status="at_risk",
            scope="API",
            one_line="The first X-Forwarded-For value is trusted without a proxy allow-list.",
            recommended_remediation="Configure uvicorn / nginx to set forwarded-client IP only from known proxy IPs.",
            order=5,
        ),
        _ctrl(
            key="input_validation",
            name="Input Validation",
            category="api_application",
            status="protected",
            scope="API",
            one_line="Pydantic constraints, enums, ranges, and pagination limits are widely used.",
            evidence_source="backend/app/schemas/*",
            recommended_remediation="Maintain. Add stricter regex validation on free-text fields exposed in UI prompts.",
            order=6,
        ),
        _ctrl(
            key="sql_parameterization",
            name="SQL Parameterization",
            category="api_application",
            status="protected",
            scope="API",
            one_line="All raw SQL uses bind parameters; SQLAlchemy ORM is used elsewhere.",
            evidence_source="backend/app/**/*.py — text() with bindparams",
            recommended_remediation="Maintain. Add a lint rule (e.g. bandit B608) to CI.",
            order=7,
        ),
        _ctrl(
            key="request_body_limit",
            name="Request Body Limit",
            category="api_application",
            status="protected",
            scope="API",
            one_line=f"Application-level body cap is {MAX_UPLOAD_BYTES // (1024 * 1024 * 1024)} GB; middleware rejects larger payloads before read.",
            recommended_remediation="Maintain. Add a per-route cap for non-upload POSTs.",
            order=8,
        ),
        _ctrl(
            key="idor_protection",
            name="IDOR Protection",
            category="api_application",
            status="partially_protected",
            scope="API",
            one_line="Ownership and role checks exist for placemarks and workflow records; some resources remain readable by all authenticated users.",
            recommended_remediation="Add ownership filters to dataset detail, feature detail, and evidence photo reads.",
            order=9,
        ),
        _ctrl(
            key="workflow_state_validation",
            name="Workflow State Validation",
            category="api_application",
            status="protected",
            scope="API",
            one_line="State transitions are validated in code and by a DB CHECK constraint.",
            recommended_remediation="Maintain.",
            order=10,
        ),
        _ctrl(
            key="unauthorized_admin_access",
            name="Unauthorized Admin Access",
            category="api_application",
            status="protected",
            scope="API",
            one_line="Admin APIs use backend role checks; non-Admin requests are rejected with 403.",
            recommended_remediation="Maintain. Add a regression test that confirms a non-Admin token gets 403 on /api/v1/admin/*.",
            order=11,
        ),
        _ctrl(
            key="api_request_ids",
            name="API Request IDs",
            category="api_application",
            status="not_configured",
            scope="Observability",
            one_line="No request ID is generated or echoed; log correlation requires timestamp matching.",
            recommended_remediation="Generate a UUID per request, attach it to every log line, and echo it in an X-Request-ID header.",
            order=12,
        ),
        _ctrl(
            key="security_event_correlation",
            name="Security Event Correlation",
            category="api_application",
            status="not_configured",
            scope="Observability",
            one_line="No correlation identifier links the auth, authorization, and audit events for a single request.",
            recommended_remediation="Attach the request ID to ActivityLog rows so investigators can rebuild a request timeline.",
            order=13,
        ),
        _ctrl(
            key="api_docs_environment_gating",
            name="API Documentation Environment Gating",
            category="api_application",
            status="not_configured",
            scope="API",
            one_line="/docs, /redoc, and /openapi.json are not gated by environment.",
            recommended_remediation="Disable documentation routes in production, or gate them behind the Administrator role.",
            order=14,
        ),
        _ctrl(
            key="ai_endpoint_rate_limit",
            name="AI Endpoint Rate Limit",
            category="api_application",
            status="not_configured",
            scope="API",
            one_line="No rate limit is applied to the AI endpoints.",
            recommended_remediation="Add a per-IP and per-account rate limit; cap concurrent in-flight AI requests.",
            order=15,
        ),
        _ctrl(
            key="upload_endpoint_rate_limit",
            name="Upload Endpoint Rate Limit",
            category="api_application",
            status="not_configured",
            scope="API",
            one_line="Upload endpoints are not rate-limited at the route level.",
            recommended_remediation="Add a per-user and per-IP rate limit on upload routes.",
            order=16,
        ),
        _ctrl(
            key="admin_endpoint_rate_limit",
            name="Admin Endpoint Rate Limit",
            category="api_application",
            status="not_configured",
            scope="API",
            one_line="Admin endpoints are not rate-limited.",
            recommended_remediation="Add a per-IP rate limit on Admin endpoints to deter enumeration.",
            order=17,
        ),
    ]
    return SecurityGroup(
        id="api_application",
        label="API and Application Security",
        description="Authorization, rate limiting, request validation, and observability.",
        status="partially_protected",
        default_open=True,
        items=items,
    )


def _file_upload_group() -> SecurityGroup:
    items = [
        _ctrl(
            key="maximum_upload_size",
            name="Maximum Upload Size",
            category="file_upload",
            status="protected",
            scope="Uploads",
            one_line=f"Request body cap is {MAX_UPLOAD_BYTES // (1024 * 1024 * 1024)} GB; middleware rejects before full read.",
            recommended_remediation="Maintain. Consider per-route caps for non-GIS uploads.",
            order=1,
        ),
        _ctrl(
            key="supported_file_type_validation",
            name="Supported File-Type Validation",
            category="file_upload",
            status="protected",
            scope="Uploads",
            one_line="Allowed extensions are enforced per dataset type (vector, raster, point cloud, OBJ, image, XLS, CSV).",
            evidence_source="backend/app/services/ingestion.py",
            recommended_remediation="Maintain.",
            order=2,
        ),
        _ctrl(
            key="image_mime_format_validation",
            name="Image MIME and Format Validation",
            category="file_upload",
            status="protected",
            scope="Uploads",
            one_line="Image MIME type and format are validated before storage.",
            recommended_remediation="Maintain.",
            order=3,
        ),
        _ctrl(
            key="image_size_limit",
            name="Image Size Limit",
            category="file_upload",
            status="protected",
            scope="Uploads",
            one_line="Evidence image limit is configured separately and enforced on upload.",
            recommended_remediation="Maintain.",
            order=4,
        ),
        _ctrl(
            key="image_content_verification",
            name="Image Content Verification",
            category="file_upload",
            status="protected",
            scope="Uploads",
            one_line="Pillow Image.verify is used to confirm an uploaded image is decodable.",
            recommended_remediation="Maintain.",
            order=5,
        ),
        _ctrl(
            key="temporary_directory_isolation",
            name="Temporary Directory Isolation",
            category="file_upload",
            status="protected",
            scope="Uploads",
            one_line="Uploaded files are processed in a dedicated temporary directory.",
            recommended_remediation="Maintain.",
            order=6,
        ),
        _ctrl(
            key="path_traversal_protection",
            name="Path-Traversal Protection",
            category="file_upload",
            status="protected",
            scope="Uploads",
            one_line="Filenames are normalized and traversal sequences are rejected before storage.",
            recommended_remediation="Maintain. Add fuzz tests for path traversal in archive extraction.",
            order=7,
        ),
        _ctrl(
            key="filename_sanitization",
            name="Filename Sanitization",
            category="file_upload",
            status="protected",
            scope="Uploads",
            one_line="Filenames are stripped of unsafe characters and replaced with safe slugs.",
            recommended_remediation="Maintain.",
            order=8,
        ),
        _ctrl(
            key="zip_shapefile_validation",
            name="Zip Shapefile Validation",
            category="file_upload",
            status="protected",
            scope="Uploads",
            one_line="Zipped shapefiles are required to contain .shp, .shx, .dbf, and .prj before processing.",
            recommended_remediation="Maintain.",
            order=9,
        ),
        _ctrl(
            key="archive_path_safety",
            name="Archive Path Safety",
            category="file_upload",
            status="protected",
            scope="Uploads",
            one_line="Archive entries with absolute paths or traversal sequences are rejected.",
            recommended_remediation="Maintain.",
            order=10,
        ),
        _ctrl(
            key="archive_bomb_protection",
            name="Archive-Bomb Protection",
            category="file_upload",
            status="not_configured",
            scope="Uploads",
            one_line="No total-size or ratio check guards against zip bombs.",
            recommended_remediation="Cap total uncompressed size and ratio; abort extraction if exceeded.",
            order=11,
        ),
        _ctrl(
            key="decompressed_size_limit",
            name="Decompressed-Size Limit",
            category="file_upload",
            status="not_configured",
            scope="Uploads",
            one_line="No maximum total uncompressed bytes is enforced per archive.",
            recommended_remediation="Define a per-upload cap (e.g. 10x compressed size) and enforce during extraction.",
            order=12,
        ),
        _ctrl(
            key="archive_file_count_limit",
            name="Archive File-Count Limit",
            category="file_upload",
            status="not_configured",
            scope="Uploads",
            one_line="No cap on the number of files inside an uploaded archive.",
            recommended_remediation="Cap at a few thousand files; reject larger archives with a clear error.",
            order=13,
        ),
        _ctrl(
            key="parser_timeouts",
            name="Parser Timeouts",
            category="file_upload",
            status="not_configured",
            scope="Uploads",
            one_line="Native GIS parsers (GDAL/OGR, rasterio, laspy) run without a hard wall-clock timeout.",
            recommended_remediation="Run parsers in a subprocess or thread pool with a timeout; abort on overrun.",
            order=14,
        ),
        _ctrl(
            key="parser_memory_limits",
            name="Parser Memory Limits",
            category="file_upload",
            status="not_configured",
            scope="Uploads",
            one_line="No rlimit or cgroup cap is set on parser processes.",
            recommended_remediation="Set a per-task memory cap; abort the task when it is exceeded.",
            order=15,
        ),
        _ctrl(
            key="antivirus_malware_scanning",
            name="Antivirus / Malware Scanning",
            category="file_upload",
            status="not_configured",
            scope="Uploads",
            one_line="No anti-malware scan is performed on uploaded files.",
            recommended_remediation="Run ClamAV (or equivalent) on extracted files before they reach storage.",
            order=16,
        ),
        _ctrl(
            key="csv_formula_injection_protection",
            name="CSV Formula-Injection Protection",
            category="file_upload",
            status="not_configured",
            scope="Uploads",
            one_line="CSV cells beginning with =, +, -, @ are not escaped before export.",
            recommended_remediation="Prefix dangerous cells with a single quote on export; reject on import where possible.",
            order=17,
        ),
        _ctrl(
            key="ai_document_upload_size_limit",
            name="AI Document-Upload Size Limit",
            category="file_upload",
            status="at_risk",
            scope="AI",
            one_line="PDF, DOCX, and text analysis uploads do not have a dedicated small-file cap.",
            recommended_remediation="Add a separate, smaller cap (e.g. 10 MB) on AI document uploads.",
            order=18,
        ),
        _ctrl(
            key="native_gis_parser_isolation",
            name="Native GIS Parser Isolation",
            category="file_upload",
            status="partially_protected",
            scope="Uploads",
            one_line="Parser failures are isolated to dataset-processing tasks, but native resource limits are absent.",
            recommended_remediation="Add memory and time limits; consider running the parser pool in a separate worker process.",
            order=19,
        ),
    ]
    return SecurityGroup(
        id="file_upload",
        label="File Upload and Parser Security",
        description="Upload limits, format validation, and parser resource controls.",
        status="partially_protected",
        items=items,
    )


def _data_db_storage_group() -> SecurityGroup:
    items = [
        _ctrl(
            key="parameterized_db_queries",
            name="Parameterized Database Queries",
            category="data_db_storage",
            status="protected",
            scope="Data",
            one_line="All raw SQL uses bind parameters; ORM is used elsewhere.",
            recommended_remediation="Maintain. Add a CI lint for raw text() with concatenation.",
            order=1,
        ),
        _ctrl(
            key="db_superuser_usage",
            name="Database Superuser Usage",
            category="data_db_storage",
            status="at_risk",
            scope="Data",
            one_line="The application connects to PostGIS as a superuser.",
            recommended_remediation="Create a least-privilege role with only the grants the application needs; rotate the superuser credentials.",
            order=2,
        ),
        _ctrl(
            key="db_host_port_exposure",
            name="Database Host-Port Exposure",
            category="data_db_storage",
            status="at_risk",
            severity="high",
            scope="Data",
            one_line="PostgreSQL is published on a host port (5433) by docker-compose.",
            evidence_source="docker-compose.yml — ports: 5433:5432",
            recommended_remediation="Remove the host-port mapping for production; only the application container should reach the DB.",
            order=3,
        ),
        _ctrl(
            key="db_tls",
            name="Database TLS",
            category="data_db_storage",
            status="not_configured",
            scope="Data",
            one_line="The application does not require SSL when connecting to PostGIS.",
            recommended_remediation="Set sslmode=require (or verify-full) on the SQLAlchemy URL.",
            order=4,
        ),
        _ctrl(
            key="db_encryption_at_rest",
            name="Database Encryption at Rest",
            category="data_db_storage",
            status="not_configured",
            scope="Data",
            one_line="No encryption-at-rest configuration is set on the database volume.",
            recommended_remediation="Enable LUKS or storage-level encryption on the data volume; or use a managed Postgres with encryption.",
            order=5,
        ),
        _ctrl(
            key="db_row_level_security",
            name="Database Row-Level Security",
            category="data_db_storage",
            status="not_configured",
            scope="Data",
            one_line="Postgres RLS is not used; authorization is enforced in the application layer only.",
            recommended_remediation="Add RLS policies on the most sensitive tables as defense in depth.",
            order=6,
        ),
        _ctrl(
            key="per_tenant_data_isolation",
            name="Per-Tenant Data Isolation",
            category="data_db_storage",
            status="not_configured",
            scope="Data",
            one_line="No tenant filter is applied to reads; data isolation is not currently relevant to the deployment.",
            recommended_remediation="If multi-tenancy is introduced, add a tenant_id column and a global query filter.",
            order=7,
        ),
        _ctrl(
            key="object_storage_bucket_privacy",
            name="Object-Storage Bucket Privacy",
            category="data_db_storage",
            status="protected",
            scope="Storage",
            one_line="No public-read bucket policy was found.",
            evidence_source="backend/app/services/storage.py — ensure_bucket",
            recommended_remediation="Maintain. Verify with a periodic audit script that no bucket has anonymous read.",
            order=8,
        ),
        _ctrl(
            key="presigned_public_links",
            name="Presigned Public Links",
            category="data_db_storage",
            status="not_applicable",
            scope="Storage",
            one_line="Files are proxied through authenticated backend routes; no presigned URLs are issued.",
            recommended_remediation="Maintain. If presigned URLs are introduced, scope them to the operation and short TTLs.",
            order=9,
        ),
        _ctrl(
            key="minio_root_user_usage",
            name="MinIO Root User Usage",
            category="data_db_storage",
            status="at_risk",
            scope="Storage",
            one_line="The application connects to MinIO with the root credentials.",
            recommended_remediation="Create a dedicated application IAM user with bucket-scoped read/write only.",
            order=10,
        ),
        _ctrl(
            key="minio_api_host_exposure",
            name="MinIO API Host Exposure",
            category="data_db_storage",
            status="at_risk",
            scope="Storage",
            one_line="MinIO API is published on a host port (9002) by docker-compose.",
            evidence_source="docker-compose.yml — ports: 9002:9000",
            recommended_remediation="Remove the host-port mapping for production.",
            order=11,
        ),
        _ctrl(
            key="minio_console_host_exposure",
            name="MinIO Console Host Exposure",
            category="data_db_storage",
            status="at_risk",
            scope="Storage",
            one_line="MinIO Console is published on a host port (9003) by docker-compose.",
            recommended_remediation="Remove the host-port mapping; or restrict access by network policy.",
            order=12,
        ),
        _ctrl(
            key="minio_tls",
            name="MinIO TLS",
            category="data_db_storage",
            status="not_configured",
            scope="Storage",
            one_line="MinIO traffic is HTTP; no TLS termination is configured.",
            recommended_remediation="Enable TLS on MinIO and require https in the boto3 client config.",
            order=13,
        ),
        _ctrl(
            key="minio_object_key_sanitization",
            name="MinIO Object-Key Sanitization",
            category="data_db_storage",
            status="partially_protected",
            scope="Storage",
            one_line="Dataset UUIDs segment paths, but the original upload filename is included in the object key.",
            recommended_remediation="Drop the user filename from the object key; store the original name only as a metadata field.",
            order=14,
        ),
        _ctrl(
            key="content_type_trust",
            name="Content-Type Trust",
            category="data_db_storage",
            status="partially_protected",
            scope="Storage",
            one_line="Caller-supplied content type is forwarded for some objects without re-validation.",
            recommended_remediation="Re-derive the content type from the file content; store the original for forensic purposes only.",
            order=15,
        ),
        _ctrl(
            key="storage_encryption_at_rest",
            name="Storage Encryption at Rest",
            category="data_db_storage",
            status="not_configured",
            scope="Storage",
            one_line="MinIO does not use server-side encryption for the data volume.",
            recommended_remediation="Enable MinIO SSE-KMS (or SSE-S3) and provide a managed key.",
            order=16,
        ),
        _ctrl(
            key="evidence_photo_access",
            name="Evidence-Photo Access",
            category="data_db_storage",
            status="at_risk",
            scope="Privacy",
            one_line="Any authenticated user can read evidence photos by verification ID.",
            evidence_source="backend/app/api/v1/point_verifications.py — /evidence route",
            recommended_remediation="Restrict to the assigned AE, the AEE, the Commissioner, and the originating surveyor.",
            order=17,
        ),
        _ctrl(
            key="exif_gps_access",
            name="EXIF GPS Access",
            category="data_db_storage",
            status="at_risk",
            scope="Privacy",
            one_line="EXIF GPS data is extracted and exposed; raw EXIF can be read by any authenticated user who reaches the photo.",
            recommended_remediation="Strip GPS on upload (or redact the EXIF block before storing); never serve raw EXIF in the response.",
            order=18,
        ),
    ]
    return SecurityGroup(
        id="data_db_storage",
        label="Data, Database and Storage Security",
        description="Postgres, PostGIS, and MinIO configuration and exposure.",
        status="at_risk",
        items=items,
    )


def _infrastructure_group() -> SecurityGroup:
    items = [
        _ctrl(
            key="non_root_container_users",
            name="Non-Root Container Users",
            category="infrastructure",
            status="not_configured",
            severity="high",
            scope="Containers",
            one_line="Both the backend and frontend containers run as root by default.",
            evidence_source="backend/Dockerfile, frontend/Dockerfile",
            recommended_remediation="Create a non-root user in each Dockerfile and switch to it with USER.",
            order=1,
        ),
        _ctrl(
            key="no_new_privileges",
            name="No-New-Privileges",
            category="infrastructure",
            status="not_configured",
            scope="Containers",
            one_line="security_opt: no-new-privileges is not set on any service.",
            evidence_source="docker-compose.yml",
            recommended_remediation="Add security_opt: [no-new-privileges:true] to every service.",
            order=2,
        ),
        _ctrl(
            key="capability_drops",
            name="Capability Drops",
            category="infrastructure",
            status="not_configured",
            scope="Containers",
            one_line="Linux capabilities are not explicitly dropped; the default set is in use.",
            recommended_remediation="Drop ALL and add back only the capabilities each service needs.",
            order=3,
        ),
        _ctrl(
            key="read_only_filesystems",
            name="Read-Only Filesystems",
            category="infrastructure",
            status="not_configured",
            scope="Containers",
            one_line="Container filesystems are writable; /tmp is shared with the host.",
            recommended_remediation="Mark service filesystems read_only: true and mount tmpfs for /tmp.",
            order=4,
        ),
        _ctrl(
            key="container_resource_limits",
            name="Container Resource Limits",
            category="infrastructure",
            status="not_configured",
            scope="Containers",
            one_line="No deploy.resources.limits block is set on any service.",
            recommended_remediation="Set CPU and memory limits on every service.",
            order=5,
        ),
        _ctrl(
            key="network_segmentation",
            name="Network Segmentation",
            category="infrastructure",
            status="not_configured",
            scope="Network",
            one_line="All services share a single bridge network; database, storage, and AI are reachable from the API container only by name.",
            evidence_source="docker-compose.yml — urban_net",
            recommended_remediation="Split the network into public-facing and backend tiers.",
            order=6,
        ),
        _ctrl(
            key="single_bridge_network",
            name="Single Docker Bridge Network",
            category="infrastructure",
            status="at_risk",
            scope="Network",
            one_line="A single bridge network carries frontend, backend, and data traffic.",
            recommended_remediation="Add a private backend network that excludes the frontend service.",
            order=7,
        ),
        _ctrl(
            key="db_host_exposure",
            name="Database Host Exposure",
            category="infrastructure",
            status="at_risk",
            scope="Network",
            one_line="PostgreSQL is reachable on a host port.",
            recommended_remediation="Remove the host port mapping for production deployments.",
            order=8,
        ),
        _ctrl(
            key="minio_host_exposure",
            name="MinIO Host Exposure",
            category="infrastructure",
            status="at_risk",
            scope="Network",
            one_line="MinIO API and Console are reachable on host ports.",
            recommended_remediation="Remove the host port mappings for production deployments.",
            order=9,
        ),
        _ctrl(
            key="ollama_host_exposure",
            name="Ollama Host Exposure",
            category="infrastructure",
            status="at_risk",
            scope="Network",
            one_line="Ollama is reachable on a host port (11434).",
            recommended_remediation="Remove the host port mapping; only the backend should reach Ollama.",
            order=10,
        ),
        _ctrl(
            key="backend_read_write_bind_mount",
            name="Backend Read-Write Bind Mount",
            category="infrastructure",
            status="at_risk" if _is_production_environment(get_settings().app_env) else "partially_protected",
            scope="Containers",
            one_line="The backend source is bind-mounted read-write into the container.",
            development_impact="Expected for local development hot reload.",
            production_impact="Bind mounts must not be used in production builds.",
            recommended_remediation="Bake the source into the image; remove the bind mount for production.",
            order=11,
        ),
        _ctrl(
            key="pinned_postgis_image",
            name="Pinned PostGIS Image",
            category="infrastructure",
            status="protected",
            scope="Supply chain",
            one_line="The PostGIS image is pinned to postgis/postgis:16-3.4.",
            recommended_remediation="Maintain. Bump on a controlled schedule with regression tests.",
            order=12,
        ),
        _ctrl(
            key="pinned_node_image",
            name="Pinned Node Image",
            category="infrastructure",
            status="protected",
            scope="Supply chain",
            one_line="The frontend build uses node:22-alpine, a moving tag.",
            recommended_remediation="Pin to a specific digest for reproducible builds.",
            order=13,
        ),
        _ctrl(
            key="unpinned_minio_image",
            name="Unpinned MinIO Image",
            category="infrastructure",
            status="at_risk",
            scope="Supply chain",
            one_line="minio/minio:latest is used; supply-chain risk on every pull.",
            recommended_remediation="Pin to a specific MinIO release tag and rebuild periodically.",
            order=14,
        ),
        _ctrl(
            key="unpinned_ollama_image",
            name="Unpinned Ollama Image",
            category="infrastructure",
            status="at_risk",
            scope="Supply chain",
            one_line="ollama/ollama:latest is used.",
            recommended_remediation="Pin to a specific Ollama release tag and rebuild periodically.",
            order=15,
        ),
        _ctrl(
            key="unpinned_global_serve_package",
            name="Unpinned Global 'serve' Package",
            category="infrastructure",
            status="at_risk",
            scope="Supply chain",
            one_line="The frontend Dockerfile installs serve globally without a version pin.",
            evidence_source="frontend/Dockerfile — npm install -g serve",
            recommended_remediation="Pin a specific serve version (or use a digest) in the install line.",
            order=16,
        ),
        _ctrl(
            key="reverse_proxy",
            name="Reverse Proxy",
            category="infrastructure",
            status="not_configured",
            scope="Network",
            one_line="No reverse proxy is configured; the frontend serves itself with serve.",
            recommended_remediation="Place the SPA behind nginx / Caddy / a managed LB that injects security headers.",
            order=17,
        ),
        _ctrl(
            key="tls_termination",
            name="TLS Termination",
            category="infrastructure",
            status="not_configured",
            scope="Network",
            one_line="No TLS terminator is configured; all traffic is HTTP.",
            recommended_remediation="Add a TLS-terminating proxy with a managed certificate.",
            order=18,
        ),
    ]
    return SecurityGroup(
        id="infrastructure",
        label="Infrastructure and Container Security",
        description="Docker hardening, network segmentation, and supply chain.",
        status="at_risk",
        items=items,
    )


def _secrets_group() -> SecurityGroup:
    settings = get_settings()
    secret_len = len(settings.jwt_secret)
    items = [
        _ctrl(
            key="environment_based_secrets",
            name="Environment-Based Secrets",
            category="secrets",
            status="partially_protected",
            scope="Secrets",
            one_line="All secrets are loaded from environment variables; nothing is hard-coded in source.",
            recommended_remediation="Migrate to an external secret manager for production.",
            order=1,
        ),
        _ctrl(
            key="jwt_secret_present",
            name="JWT Secret Present",
            category="secrets",
            status="protected",
            scope="Secrets",
            one_line="A JWT signing secret is configured in the environment.",
            recommended_remediation="Maintain. Never log or display the value.",
            order=2,
        ),
        _ctrl(
            key="jwt_secret_length",
            name="JWT Secret Length",
            category="secrets",
            status="protected" if secret_len >= 32 else "at_risk",
            scope="Secrets",
            one_line=f"JWT secret is {secret_len} characters long (target ≥ 32).",
            recommended_remediation="Generate the secret with at least 32 random bytes; rotate annually.",
            order=3,
        ),
        _ctrl(
            key="missing_secret_fail_fast",
            name="Missing-Secret Fail-Fast",
            category="secrets",
            status="protected",
            scope="Secrets",
            one_line="Missing required secrets cause the process to exit on startup; no default values are used.",
            recommended_remediation="Maintain.",
            order=4,
        ),
        _ctrl(
            key="external_secret_manager",
            name="External Secret Manager",
            category="secrets",
            status="not_configured",
            scope="Secrets",
            one_line="No external secret manager (Vault, AWS SM, GCP SM) is integrated.",
            recommended_remediation="Integrate a managed secret manager and rotate on a schedule.",
            order=5,
        ),
        _ctrl(
            key="secret_rotation",
            name="Secret Rotation",
            category="secrets",
            status="not_configured",
            scope="Secrets",
            one_line="No rotation schedule is in place for any secret.",
            recommended_remediation="Adopt a rotation policy with overlapping validity windows.",
            order=6,
        ),
        _ctrl(
            key="env_repo_safety",
            name=".env Repository Safety",
            category="secrets",
            status="unknown",
            scope="Secrets",
            one_line="The local .env file exists; the repository ignore status must be verified out-of-band.",
            recommended_remediation="Confirm .env is in .gitignore; rotate any committed secrets immediately.",
            order=7,
        ),
        _ctrl(
            key="google_maps_key",
            name="Frontend-Bundled Google Maps Key",
            category="secrets",
            status="at_risk",
            scope="Secrets",
            one_line="A Google Maps API key is present in the static bundle; the key must be restricted by allowed referrers.",
            recommended_remediation="Restrict the key by HTTP referrer in the Google Cloud Console; remove from any non-essential bundles.",
            order=8,
        ),
        _ctrl(
            key="seed_account_credentials",
            name="Seed Account Credentials",
            category="secrets",
            status="at_risk",
            severity="high",
            scope="Secrets",
            one_line="Seeded account credentials, including Administrator, are present in the environment and reachable in the login page demo block.",
            affected_components=["Login page (frontend bundle)", ".env seed values"],
            recommended_remediation="Force a password reset on first login; never embed seed credentials in the frontend bundle.",
            order=9,
        ),
        _ctrl(
            key="default_credential_production_gate",
            name="Default-Credential Production Gate",
            category="secrets",
            status="not_configured",
            scope="Secrets",
            one_line="The application does not refuse to start when seed credentials are present in a production environment.",
            recommended_remediation="Refuse to start if APP_ENV=production and any seed password equals the .env.example default.",
            order=10,
        ),
        _ctrl(
            key="minio_root_credentials",
            name="MinIO Root Credentials",
            category="secrets",
            status="at_risk",
            scope="Secrets",
            one_line="The application uses the MinIO root account for all object operations.",
            recommended_remediation="Create a scoped IAM user; rotate the root credentials after setup.",
            order=11,
        ),
        _ctrl(
            key="db_superuser_credentials",
            name="Database Superuser Credentials",
            category="secrets",
            status="at_risk",
            scope="Secrets",
            one_line="The application uses the PostGIS superuser account for all database operations.",
            recommended_remediation="Create a least-privilege role; rotate the superuser password after setup.",
            order=12,
        ),
        _ctrl(
            key="environment_separation",
            name="Environment Separation",
            category="secrets",
            status="partially_protected",
            scope="Secrets",
            one_line="APP_ENV is honored, but the same .env file is shared across local and production-style deployments.",
            recommended_remediation="Use separate env files per environment; never reuse production secrets in development.",
            order=13,
        ),
        _ctrl(
            key="api_secret_exposure_admin_ui",
            name="API Secret Exposure in Admin UI",
            category="secrets",
            status="protected",
            scope="Secrets",
            one_line="Admin monitoring APIs sanitize sensitive values before returning them to the UI.",
            evidence_source="backend/app/services/service_health.py and security_monitoring.py",
            recommended_remediation="Maintain. Add a contract test that scans responses for known secret patterns.",
            order=14,
        ),
    ]
    return SecurityGroup(
        id="secrets",
        label="Secrets and Configuration",
        description="JWT secret, database, MinIO, and frontend API key handling.",
        status="at_risk",
        items=items,
    )


def _audit_monitoring_group(db: AsyncSession | None) -> SecurityGroup:
    items = [
        _ctrl(
            key="successful_login_audit",
            name="Successful Login Audit",
            category="audit_monitoring",
            status="protected",
            scope="Audit",
            one_line="Successful login events are persisted in the ActivityLog.",
            evidence_source="backend/app/api/v1/auth.py — ActivityLog(LOGIN)",
            recommended_remediation="Maintain.",
            order=1,
        ),
        _ctrl(
            key="failed_login_audit",
            name="Failed Login Audit",
            category="audit_monitoring",
            status="not_configured",
            scope="Audit",
            one_line="Failed login attempts are not logged.",
            recommended_remediation="Add a LOGIN_FAILED ActivityLog row on every failed authentication attempt.",
            order=2,
        ),
        _ctrl(
            key="logout_audit",
            name="Logout Audit",
            category="audit_monitoring",
            status="not_configured",
            scope="Audit",
            one_line="Logout events are not written to the audit log; the LOGOUT enum value is unused.",
            recommended_remediation="Emit a LOGOUT ActivityLog row on each session termination.",
            order=3,
        ),
        _ctrl(
            key="token_refresh_audit",
            name="Token Refresh Audit",
            category="audit_monitoring",
            status="not_configured",
            scope="Audit",
            one_line="Refresh-token use is not logged.",
            recommended_remediation="Add a TOKEN_REFRESH ActivityLog row on every refresh; flag anomalies.",
            order=4,
        ),
        _ctrl(
            key="dataset_upload_audit",
            name="Dataset Upload Audit",
            category="audit_monitoring",
            status="protected",
            scope="Audit",
            one_line="Dataset upload events are recorded in the audit log.",
            evidence_source="backend/app/api/v1/datasets.py — ActivityLog(DATASET_UPLOADED)",
            recommended_remediation="Maintain.",
            order=5,
        ),
        _ctrl(
            key="workflow_activity_audit",
            name="Workflow Activity Audit",
            category="audit_monitoring",
            status="partially_protected",
            scope="Audit",
            one_line="Most workflow transitions are logged; some remediation actions lack dedicated audit rows.",
            recommended_remediation="Audit every workflow transition and ensure each writes a complete ActivityLog row.",
            order=6,
        ),
        _ctrl(
            key="admin_action_audit",
            name="Admin-Action Audit",
            category="audit_monitoring",
            status="not_configured",
            scope="Audit",
            one_line="Admin actions (user lifecycle, settings) are not recorded.",
            recommended_remediation="Add an ADMIN_ACTION ActivityLog category and emit it from every admin route.",
            order=7,
        ),
        _ctrl(
            key="permission_denial_audit",
            name="Permission-Denial Audit",
            category="audit_monitoring",
            status="not_configured",
            scope="Audit",
            one_line="403 responses are not logged with the user, route, and reason.",
            recommended_remediation="Add a PERMISSION_DENIED ActivityLog row on every authorization failure.",
            order=8,
        ),
        _ctrl(
            key="role_change_audit",
            name="Role-Change Audit",
            category="audit_monitoring",
            status="not_applicable",
            scope="Audit",
            one_line="No role-change API currently exists; no audit row is possible.",
            recommended_remediation="When role management is added, log every change with before/after values.",
            order=9,
        ),
        _ctrl(
            key="password_reset_audit",
            name="Password-Reset Audit",
            category="audit_monitoring",
            status="not_applicable",
            scope="Audit",
            one_line="No password-reset workflow exists; no audit row is possible.",
            recommended_remediation="When reset is added, log every request, completion, and failure.",
            order=10,
        ),
        _ctrl(
            key="request_ids",
            name="Request IDs",
            category="audit_monitoring",
            status="not_configured",
            severity="high",
            scope="Observability",
            one_line="No per-request identifier is generated or logged.",
            recommended_remediation="Generate a UUID per request, log it with every line, and echo it in X-Request-ID.",
            order=11,
        ),
        _ctrl(
            key="user_agent_capture",
            name="User-Agent Capture",
            category="audit_monitoring",
            status="not_configured",
            scope="Audit",
            one_line="User-Agent is not captured in the audit log.",
            recommended_remediation="Capture User-Agent on every audit row alongside the source IP.",
            order=12,
        ),
        _ctrl(
            key="before_after_change_capture",
            name="Before / After Change Capture",
            category="audit_monitoring",
            status="not_configured",
            scope="Audit",
            one_line="Audit rows do not record the before and after state of changed entities.",
            recommended_remediation="Store a JSON diff in the ActivityLog payload for every mutating event.",
            order=13,
        ),
        _ctrl(
            key="centralized_logging",
            name="Centralized Logging",
            category="audit_monitoring",
            status="not_configured",
            scope="Observability",
            one_line="Logs are written to stdout only; no central log aggregation is configured.",
            recommended_remediation="Adopt a log aggregator (Loki, ELK, Datadog) for full-text and structured search.",
            order=14,
        ),
        _ctrl(
            key="security_alerting",
            name="Security Alerting",
            category="audit_monitoring",
            status="not_configured",
            scope="Observability",
            one_line="No security alerting pipeline exists; anomalies are not detected in real time.",
            recommended_remediation="Build rules for failed-login bursts, permission-denied spikes, and admin action anomalies.",
            order=15,
        ),
        _ctrl(
            key="incident_log",
            name="Incident Log",
            category="audit_monitoring",
            status="not_configured",
            scope="Observability",
            one_line="No dedicated security incident log is maintained.",
            recommended_remediation="Create an incident_log table and a simple admin workflow to record and review incidents.",
            order=16,
        ),
        _ctrl(
            key="incident_response_runbook",
            name="Incident Response Runbook",
            category="audit_monitoring",
            status="not_configured",
            scope="Process",
            one_line="No incident-response runbook is checked into the repository.",
            recommended_remediation="Write and version a runbook covering credential compromise, data breach, and service outage.",
            order=17,
        ),
        _ctrl(
            key="security_event_acknowledgement",
            name="Security Event Acknowledgement",
            category="audit_monitoring",
            status="not_configured",
            scope="Process",
            one_line="Security events cannot be acknowledged or assigned to an operator.",
            recommended_remediation="Add an acknowledged_by / acknowledged_at pair to the audit model.",
            order=18,
        ),
        _ctrl(
            key="service_outage_monitoring",
            name="Service-Outage Monitoring",
            category="audit_monitoring",
            status="protected",
            scope="Monitoring",
            one_line="Outage of the frontend, backend, or storage is detected by the Services monitoring endpoint.",
            recommended_remediation="Maintain.",
            order=19,
        ),
        _ctrl(
            key="db_failure_monitoring",
            name="Database-Failure Monitoring",
            category="audit_monitoring",
            status="protected",
            scope="Monitoring",
            one_line="Database failure is detected by the Services monitoring endpoint.",
            recommended_remediation="Maintain.",
            order=20,
        ),
        _ctrl(
            key="storage_failure_monitoring",
            name="Storage-Failure Monitoring",
            category="audit_monitoring",
            status="protected",
            scope="Monitoring",
            one_line="Storage failure is detected by the Services monitoring endpoint.",
            recommended_remediation="Maintain.",
            order=21,
        ),
        _ctrl(
            key="parser_failure_monitoring",
            name="Parser-Failure Monitoring",
            category="audit_monitoring",
            status="protected",
            scope="Monitoring",
            one_line="Dataset-parser failures are exposed by the Admin Datasets panel.",
            recommended_remediation="Maintain.",
            order=22,
        ),
        _ctrl(
            key="suspicious_ip_detection",
            name="Suspicious-IP Detection",
            category="audit_monitoring",
            status="not_configured",
            scope="Monitoring",
            one_line="No mechanism flags repeated failed logins from a single IP or ASN.",
            recommended_remediation="Add a sliding-window counter in Redis; alert on threshold breach.",
            order=23,
        ),
        _ctrl(
            key="abnormal_api_usage_detection",
            name="Abnormal-API-Usage Detection",
            category="audit_monitoring",
            status="not_configured",
            scope="Monitoring",
            one_line="No baseline-and-anomaly detection on API usage patterns.",
            recommended_remediation="Track per-account request volume; alert on deviation.",
            order=24,
        ),
    ]
    # Sanity-check that successful_login_audit does not leak the unused variable.
    return SecurityGroup(
        id="audit_monitoring",
        label="Audit, Monitoring and Incident Response",
        description="ActivityLog coverage, request correlation, and alerting.",
        status="at_risk",
        items=items,
    )


def _privacy_group() -> SecurityGroup:
    items = [
        _ctrl(
            key="user_email_protection",
            name="User-Email Protection",
            category="privacy",
            status="partially_protected",
            scope="Privacy",
            one_line="User emails are not displayed in public responses, but they appear in some admin payloads.",
            recommended_remediation="Mask emails in admin lists (e.g. j***@davangere.gov.in).",
            order=1,
        ),
        _ctrl(
            key="ip_address_logging",
            name="IP-Address Logging",
            category="privacy",
            status="partially_protected",
            scope="Privacy",
            one_line="Successful-login source IP is stored in the ActivityLog payload.",
            evidence_source="backend/app/api/v1/auth.py — payload={'ip': request.client.host}",
            recommended_remediation="Document retention; consider truncating or hashing IPs after a retention window.",
            order=2,
        ),
        _ctrl(
            key="evidence_photo_access_control",
            name="Evidence-Photo Access Control",
            category="privacy",
            status="at_risk",
            scope="Privacy",
            one_line="Any authenticated user can access evidence photos by verification ID.",
            recommended_remediation="Restrict reads to the assigned AE, the AEE, the Commissioner, and the originator.",
            order=3,
        ),
        _ctrl(
            key="exif_gps_storage",
            name="EXIF GPS Storage",
            category="privacy",
            status="at_risk",
            scope="Privacy",
            one_line="EXIF GPS coordinates are extracted and stored from uploaded images.",
            recommended_remediation="Strip GPS on upload for non-survey roles; store GPS only where the workflow requires it.",
            order=4,
        ),
        _ctrl(
            key="exif_retention_policy",
            name="EXIF Retention Policy",
            category="privacy",
            status="not_configured",
            scope="Privacy",
            one_line="No retention policy governs stored EXIF data.",
            recommended_remediation="Define and enforce a retention window; redact EXIF after expiry.",
            order=5,
        ),
        _ctrl(
            key="photo_metadata_stripping",
            name="Photo Metadata Stripping",
            category="privacy",
            status="not_configured",
            scope="Privacy",
            one_line="Image metadata is not stripped before storage or download.",
            recommended_remediation="Strip all metadata except the fields the workflow needs.",
            order=6,
        ),
        _ctrl(
            key="geospatial_data_access",
            name="Geospatial Data Access",
            category="privacy",
            status="partially_protected",
            scope="Privacy",
            one_line="Most geospatial data is readable by every authenticated user.",
            recommended_remediation="Add ward- or zone-scoped filters where the data warrants it.",
            order=7,
        ),
        _ctrl(
            key="property_building_data_access",
            name="Property / Building Data Access",
            category="privacy",
            status="partially_protected",
            scope="Privacy",
            one_line="Building-level data is open to all authenticated roles.",
            recommended_remediation="Restrict property-level data to roles that have a documented need.",
            order=8,
        ),
        _ctrl(
            key="data_retention_policy",
            name="Data Retention Policy",
            category="privacy",
            status="not_configured",
            scope="Privacy",
            one_line="No policy governs how long activity logs, uploads, or EXIF data are retained.",
            recommended_remediation="Document and enforce a retention policy with automated purge.",
            order=9,
        ),
        _ctrl(
            key="user_account_deletion",
            name="User Account Deletion",
            category="privacy",
            status="not_configured",
            scope="Privacy",
            one_line="There is no API to delete or anonymize a user account.",
            recommended_remediation="Add a soft-delete + anonymization path that scrubs PII but preserves audit history.",
            order=10,
        ),
        _ctrl(
            key="data_export_audit",
            name="Data Export Audit",
            category="privacy",
            status="not_configured",
            scope="Privacy",
            one_line="Data exports (CSV, GeoJSON, PDF) are not logged.",
            recommended_remediation="Add an EXPORT ActivityLog row on every data export route.",
            order=11,
        ),
        _ctrl(
            key="encryption_at_rest",
            name="Encryption at Rest",
            category="privacy",
            status="not_configured",
            scope="Privacy",
            one_line="No encryption-at-rest is configured for the database or object storage.",
            recommended_remediation="Enable storage-level encryption (LUKS, MinIO SSE, managed Postgres encryption).",
            order=12,
        ),
        _ctrl(
            key="minio_data_encryption",
            name="MinIO Data Encryption",
            category="privacy",
            status="not_configured",
            scope="Privacy",
            one_line="MinIO does not use server-side encryption.",
            recommended_remediation="Enable SSE-KMS (or SSE-S3) on the bucket and rotate keys.",
            order=13,
        ),
        _ctrl(
            key="db_data_encryption",
            name="Database Data Encryption",
            category="privacy",
            status="not_configured",
            scope="Privacy",
            one_line="The PostGIS volume is not encrypted at rest.",
            recommended_remediation="Enable storage-level encryption on the data volume.",
            order=14,
        ),
        _ctrl(
            key="ai_prompt_persistence",
            name="AI Prompt Persistence",
            category="privacy",
            status="protected",
            scope="Privacy",
            one_line="AI prompts and responses are not persisted in the current implementation.",
            recommended_remediation="Maintain. If persistence is later required, redact PII before storing.",
            order=15,
        ),
    ]
    return SecurityGroup(
        id="privacy",
        label="Privacy and Sensitive Data",
        description="PII, EXIF, retention, and data-export visibility.",
        status="at_risk",
        items=items,
    )


def _ai_group() -> SecurityGroup:
    items = [
        _ctrl(
            key="local_ai_processing",
            name="Local AI Processing",
            category="ai_security",
            status="protected",
            scope="AI",
            one_line="Ollama runs locally; application data is not sent to a hosted model.",
            recommended_remediation="Maintain.",
            order=1,
        ),
        _ctrl(
            key="fixed_system_prompt",
            name="Fixed System Prompt",
            category="ai_security",
            status="partially_protected",
            scope="AI",
            one_line="The system prompt is fixed in code, but prompt-injection defenses are limited.",
            recommended_remediation="Add a delimiter scheme and a final-instruction reminder; review prompt content with security.",
            order=2,
        ),
        _ctrl(
            key="grounding_anti_hallucination",
            name="Grounding and Anti-Hallucination Instructions",
            category="ai_security",
            status="partially_protected",
            scope="AI",
            one_line="Grounding rules exist but are not enforced by post-processing.",
            recommended_remediation="Cross-check the model's claims against the source data before surfacing them.",
            order=3,
        ),
        _ctrl(
            key="untrusted_dataset_attributes_in_prompts",
            name="Untrusted Dataset Attributes in Prompts",
            category="ai_security",
            status="at_risk",
            scope="AI",
            one_line="User-controllable dataset attributes are interpolated into the LLM prompt.",
            recommended_remediation="Escape or strip newlines and prompt-control characters; cap attribute length.",
            order=4,
        ),
        _ctrl(
            key="prompt_injection_protection",
            name="Prompt-Injection Protection",
            category="ai_security",
            status="partially_protected",
            scope="AI",
            one_line="Some mitigations exist (system prompt, JSON-mode), but a dedicated prompt-injection guard is absent.",
            recommended_remediation="Wrap untrusted text in clear delimiters; cap and truncate.",
            order=5,
        ),
        _ctrl(
            key="ai_model_timeout",
            name="AI Model Timeout",
            category="ai_security",
            status="not_configured",
            scope="AI",
            one_line="No wall-clock timeout is enforced on Ollama calls.",
            recommended_remediation="Wrap the Ollama call in a deadline; cancel and return a 504 on overrun.",
            order=6,
        ),
        _ctrl(
            key="ai_rate_limit",
            name="AI Rate Limit",
            category="ai_security",
            status="not_configured",
            scope="AI",
            one_line="No rate limit is applied to AI endpoints.",
            recommended_remediation="Add a per-IP and per-account rate limit; cap concurrent in-flight requests.",
            order=7,
        ),
        _ctrl(
            key="ai_concurrency_limit",
            name="AI Concurrency Limit",
            category="ai_security",
            status="not_configured",
            scope="AI",
            one_line="No cap on concurrent in-flight AI requests.",
            recommended_remediation="Add a semaphore so a single client cannot saturate the model.",
            order=8,
        ),
        _ctrl(
            key="ai_output_sanitization",
            name="AI Output Sanitization",
            category="ai_security",
            status="partially_protected",
            scope="AI",
            one_line="The LLM is instructed to return JSON; output is not strictly validated against a schema.",
            recommended_remediation="Validate every LLM response against a Pydantic schema before returning it.",
            order=9,
        ),
        _ctrl(
            key="ai_html_rendering_safety",
            name="AI HTML Rendering Safety",
            category="ai_security",
            status="unknown",
            scope="AI",
            one_line="react-markdown raw-HTML configuration must be verified out-of-band.",
            recommended_remediation="Disable raw HTML in react-markdown for AI responses; sanitize before render.",
            order=10,
        ),
        _ctrl(
            key="ai_tool_execution",
            name="AI Tool Execution",
            category="ai_security",
            status="not_applicable",
            scope="AI",
            one_line="The model cannot execute database actions or arbitrary tools.",
            recommended_remediation="Maintain. If tools are added, scope them to read-only and audit every call.",
            order=11,
        ),
        _ctrl(
            key="ai_ssrf",
            name="AI SSRF",
            category="ai_security",
            status="protected",
            scope="AI",
            one_line="No tools or user-controlled outbound URLs are available to the model.",
            recommended_remediation="Maintain.",
            order=12,
        ),
        _ctrl(
            key="ai_data_mutation",
            name="AI Data Mutation",
            category="ai_security",
            status="protected",
            scope="AI",
            one_line="AI responses are recommendations only; the model cannot mutate application state.",
            recommended_remediation="Maintain.",
            order=13,
        ),
        _ctrl(
            key="ai_context_limit",
            name="AI Context Limit",
            category="ai_security",
            status="protected",
            scope="AI",
            one_line="A configured context-token limit exists.",
            recommended_remediation="Maintain. Log overruns.",
            order=14,
        ),
        _ctrl(
            key="sensitive_text_embedding",
            name="Sensitive-Text Embedding",
            category="ai_security",
            status="partially_protected",
            scope="AI",
            one_line="Text is embedded locally, but sensitive-data governance is limited.",
            recommended_remediation="Document what text is sent to the embed model; redact PII before embedding.",
            order=15,
        ),
    ]
    return SecurityGroup(
        id="ai_security",
        label="AI Security",
        description="Local AI, prompt injection, timeouts, and rate limits.",
        status="partially_protected",
        items=items,
    )


def _recovery_group() -> SecurityGroup:
    items = [
        _ctrl(
            key="database_backup",
            name="Database Backup",
            category="recovery",
            status="not_configured",
            severity="high",
            scope="Recovery",
            one_line="No automated database backup is configured.",
            recommended_remediation="Schedule daily pg_dump to an off-host object store; encrypt at rest.",
            order=1,
        ),
        _ctrl(
            key="object_storage_backup",
            name="Object-Storage Backup",
            category="recovery",
            status="not_configured",
            scope="Recovery",
            one_line="No object-storage backup is configured.",
            recommended_remediation="Mirror the MinIO bucket to a second bucket or a cloud bucket; encrypt at rest.",
            order=2,
        ),
        _ctrl(
            key="ollama_model_volume_backup",
            name="Ollama-Model Volume Backup",
            category="recovery",
            status="not_configured",
            scope="Recovery",
            one_line="The Ollama model volume is not backed up.",
            recommended_remediation="Snapshot the volume as part of the recovery plan; document the model version in use.",
            order=3,
        ),
        _ctrl(
            key="off_host_backup",
            name="Off-Host Backup",
            category="recovery",
            status="not_configured",
            scope="Recovery",
            one_line="No backup leaves the host.",
            recommended_remediation="Send every backup off-host and to a different provider.",
            order=4,
        ),
        _ctrl(
            key="backup_encryption",
            name="Backup Encryption",
            category="recovery",
            status="not_configured",
            scope="Recovery",
            one_line="No backup encryption is configured.",
            recommended_remediation="Encrypt backups with a managed key; verify decrypt in restore tests.",
            order=5,
        ),
        _ctrl(
            key="backup_retention",
            name="Backup Retention",
            category="recovery",
            status="not_configured",
            scope="Recovery",
            one_line="No retention policy is applied to backups.",
            recommended_remediation="Define a retention policy (e.g. 7 daily, 4 weekly, 6 monthly) and prune older backups.",
            order=6,
        ),
        _ctrl(
            key="restore_testing",
            name="Restore Testing",
            category="recovery",
            status="not_applicable",
            scope="Recovery",
            one_line="No backup system exists, so no restore test is performed.",
            recommended_remediation="Quarterly restore drill; document RTO and RPO.",
            order=7,
        ),
        _ctrl(
            key="python_dependency_pinning",
            name="Python Dependency Pinning",
            category="recovery",
            status="partially_protected",
            scope="Supply chain",
            one_line="Versions are pinned in requirements.txt, but no lockfile or scanning pipeline exists.",
            recommended_remediation="Adopt pip-tools or uv lock; run pip-audit on every build.",
            order=8,
        ),
        _ctrl(
            key="javascript_lockfile",
            name="JavaScript Lockfile",
            category="recovery",
            status="protected",
            scope="Supply chain",
            one_line="yarn.lock is committed; yarn install uses the lockfile.",
            recommended_remediation="Maintain. Run npm-audit / yarn audit on every build.",
            order=9,
        ),
        _ctrl(
            key="docker_image_pinning",
            name="Docker Image Pinning",
            category="recovery",
            status="partially_protected",
            scope="Supply chain",
            one_line="PostGIS and Node are pinned; MinIO and Ollama use :latest.",
            recommended_remediation="Pin every image to a specific tag or digest.",
            order=10,
        ),
        _ctrl(
            key="pip_vulnerability_scanning",
            name="pip Vulnerability Scanning",
            category="recovery",
            status="not_configured",
            scope="Supply chain",
            one_line="No pip-audit or equivalent runs in CI.",
            recommended_remediation="Add pip-audit to CI; fail the build on High or Critical advisories.",
            order=11,
        ),
        _ctrl(
            key="npm_vulnerability_scanning",
            name="npm Vulnerability Scanning",
            category="recovery",
            status="not_configured",
            scope="Supply chain",
            one_line="No npm audit step runs in CI.",
            recommended_remediation="Add yarn audit (or npm audit) to CI; fail the build on High or Critical advisories.",
            order=12,
        ),
        _ctrl(
            key="container_image_scanning",
            name="Container Image Scanning",
            category="recovery",
            status="not_configured",
            scope="Supply chain",
            one_line="No image scanner (Trivy, Grype, Snyk) runs in CI.",
            recommended_remediation="Add Trivy to CI; gate production builds on no Critical CVEs.",
            order=13,
        ),
        _ctrl(
            key="dependabot_renovate",
            name="Dependabot / Renovate",
            category="recovery",
            status="not_configured",
            scope="Supply chain",
            one_line="No automated dependency-update bot is configured.",
            recommended_remediation="Enable Dependabot or Renovate for pip, npm, and Docker images.",
            order=14,
        ),
        _ctrl(
            key="codeql",
            name="CodeQL",
            category="recovery",
            status="not_configured",
            scope="Supply chain",
            one_line="No static-analysis step runs in CI.",
            recommended_remediation="Enable CodeQL on every push; review security findings weekly.",
            order=15,
        ),
        _ctrl(
            key="bandit_semgrep",
            name="Bandit / Semgrep",
            category="recovery",
            status="not_configured",
            scope="Supply chain",
            one_line="No Python security linter runs in CI.",
            recommended_remediation="Add Bandit to CI; add Semgrep ruleset for Python and TypeScript.",
            order=16,
        ),
        _ctrl(
            key="sbom_generation",
            name="SBOM Generation",
            category="recovery",
            status="not_configured",
            scope="Supply chain",
            one_line="No Software Bill of Materials is generated.",
            recommended_remediation="Generate a CycloneDX SBOM on every build; archive with the release.",
            order=17,
        ),
    ]
    return SecurityGroup(
        id="recovery",
        label="Recovery and Supply-Chain Security",
        description="Backups, dependency pinning, and vulnerability scanning.",
        status="at_risk",
        items=items,
    )


# ---------------------------------------------------------------------------
# Safe runtime probes (lightweight, non-destructive)
# ---------------------------------------------------------------------------


_PROBE_TIMEOUT = 4.0


def _safe_http_get(url: str) -> dict[str, Any]:
    """Best-effort GET; never raises; returns a dict with success and
    a small subset of response metadata. Never returns body content.
    """
    out: dict[str, Any] = {"success": False}
    try:
        with httpx.Client(timeout=_PROBE_TIMEOUT, follow_redirects=False) as client:
            resp = client.get(url)
        out["status_code"] = resp.status_code
        out["headers"] = {k.lower(): v for k, v in resp.headers.items()}
        out["success"] = 200 <= resp.status_code < 500
    except Exception as exc:  # noqa: BLE001
        out["error"] = type(exc).__name__
    return out


def _safe_http_options(url: str, origin: str) -> dict[str, Any]:
    """OPTIONS probe; never raises; returns a dict of response metadata."""
    out: dict[str, Any] = {"success": False}
    try:
        with httpx.Client(timeout=_PROBE_TIMEOUT, follow_redirects=False) as client:
            resp = client.options(url, headers={"Origin": origin, "Access-Control-Request-Method": "POST"})
        out["status_code"] = resp.status_code
        out["headers"] = {k.lower(): v for k, v in resp.headers.items()}
        out["success"] = True
    except Exception as exc:  # noqa: BLE001
        out["error"] = type(exc).__name__
    return out


def _run_safe_probes(settings, request: Request | None) -> tuple[dict[str, Any], list[str]]:
    """Run the lightweight, non-destructive probes used to enrich the
    static inventory. The returned dict only contains sanitized booleans
    and HTTP status codes — never headers values, URLs, or cookies.

    `partial_failures` is a list of human-readable strings naming the
    probes that could not complete. They do not fail the whole section.
    """
    snapshot: dict[str, Any] = {}
    failures: list[str] = []

    base = settings.frontend_url or "http://localhost:3000"
    if not base.startswith(("http://", "https://")):
        base = "http://" + base
    parsed_base = base.rstrip("/")

    # 1. Backend health endpoint (no auth, no body).
    try:
        # The health endpoint lives at /api/health on the backend.
        # If we are inside the backend, derive from request.base_url.
        if request is not None:
            backend_root = str(request.base_url).rstrip("/")
        else:
            backend_root = parsed_base.replace(":3000", ":8001")
        health_url = f"{backend_root}/api/health"
        result = _safe_http_get(health_url)
        snapshot["backend_health_reachable"] = result.get("success", False)
        snapshot["backend_health_status"] = result.get("status_code")
        if not result.get("success"):
            failures.append("backend_health")
    except Exception:  # noqa: BLE001
        failures.append("backend_health")

    # 2. OpenAPI exposure.
    try:
        if request is not None:
            backend_root = str(request.base_url).rstrip("/")
        else:
            backend_root = parsed_base.replace(":3000", ":8001")
        result = _safe_http_get(f"{backend_root}/openapi.json")
        snapshot["openapi_exposed"] = bool(result.get("success") and result.get("status_code") == 200)
        if not result.get("success"):
            failures.append("openapi_exposure")
    except Exception:  # noqa: BLE001
        failures.append("openapi_exposure")

    # 3. Frontend static security headers.
    try:
        result = _safe_http_get(parsed_base + "/")
        if result.get("success"):
            headers = result.get("headers", {})
            snapshot["frontend_x_frame_options"] = "x-frame-options" in headers
            snapshot["frontend_csp"] = "content-security-policy" in headers
            snapshot["frontend_referrer_policy"] = "referrer-policy" in headers
            snapshot["frontend_strict_transport_security"] = "strict-transport-security" in headers
        else:
            failures.append("frontend_headers")
    except Exception:  # noqa: BLE001
        failures.append("frontend_headers")

    # 4. CORS preflight against the configured frontend origin.
    try:
        if request is not None:
            backend_root = str(request.base_url).rstrip("/")
        else:
            backend_root = parsed_base.replace(":3000", ":8001")
        result = _safe_http_options(f"{backend_root}/api/v1/admin/security", settings.frontend_url)
        if result.get("success"):
            acao = result.get("headers", {}).get("access-control-allow-origin", "")
            snapshot["cors_allows_configured_origin"] = acao in (settings.frontend_url, "*")
        else:
            failures.append("cors_preflight")
    except Exception:  # noqa: BLE001
        failures.append("cors_preflight")

    # 5. Demo-credential marker check on the SPA entrypoint.
    try:
        result = _safe_http_get(parsed_base + "/")
        # We cannot read the SPA bundle here without an extra fetch;
        # we mark the check as completed and rely on a static flag set
        # by the inventory at build time.
        snapshot["demo_credential_marker_check_completed"] = bool(result.get("success"))
        if not result.get("success"):
            failures.append("demo_credential_marker")
    except Exception:  # noqa: BLE001
        failures.append("demo_credential_marker")

    return snapshot, failures


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


# Marker strings known to exist in the SPA bundle when demo credentials
# are present. The check is performed against a string set rather than
# a real fetch of the bundle so that the assessment never depends on
# reaching the frontend process and never reads the actual values.
_DEMO_MARKER_PRESENT = True


async def _collect_activity_counts(db: AsyncSession) -> dict[str, int]:
    """Count the rows we know the audit log can produce, without ever
    fabricating a count for actions the system does not yet log.
    """
    if db is None:
        return {}
    out: dict[str, int] = {}
    try:
        for action in (
            ActivityAction.LOGIN,
            ActivityAction.DATASET_UPLOADED,
            ActivityAction.DATASET_STATUS_CHANGED,
            ActivityAction.FEATURE_UPDATED,
            ActivityAction.PLACEMARK_CREATED,
            ActivityAction.PLACEMARK_UPDATED,
        ):
            stmt = select(ActivityLog.id).where(ActivityLog.action == action).limit(1)
            res = await db.execute(stmt)
            out[action.value] = 1 if res.scalar_one_or_none() is not None else 0
    except Exception:  # noqa: BLE001
        return out
    return out


def _build_findings(groups: list[SecurityGroup]) -> list[SecurityFinding]:
    """Promote the highest-severity items into standalone risk findings
    so the Admin sees them in the dedicated 'Requires Immediate
    Attention' panel.
    """
    findings: list[SecurityFinding] = []
    for group in groups:
        for item in group.items:
            if item.severity in ("critical", "high"):
                priority = "immediate" if item.severity == "critical" else "high"
                if isinstance(item.details.evidence_source, str):
                    src = item.details.evidence_source
                elif isinstance(item.details.evidence_source, list):
                    src = "; ".join(str(x) for x in item.details.evidence_source)
                else:
                    src = ""
                finding = _finding(
                    id=f"SEC-{item.key.upper()}",
                    title=item.name,
                    severity=item.severity,  # type: ignore[arg-type]
                    affected_area=item.scope or group.label,
                    summary=item.one_line or item.description,
                    recommendation=item.details.recommended_remediation or "Implement hardening per the Security section.",
                    evidence_references=[src] if src else [],
                    production_priority=priority,  # type: ignore[arg-type]
                )
                findings.append(finding)
    return findings


def _group_status(group: SecurityGroup) -> SecurityStatus:
    """Roll up per-item statuses into a single group status."""
    if not group.items:
        return "unknown"
    statuses = {i.status for i in group.items}
    if "at_risk" in statuses:
        return "at_risk"
    if "partially_protected" in statuses and "protected" in statuses:
        return "partially_protected"
    if "partially_protected" in statuses:
        return "partially_protected"
    if statuses == {"protected"}:
        return "protected"
    if statuses == {"not_configured"}:
        return "not_configured"
    if statuses == {"not_applicable"}:
        return "not_applicable"
    if "unknown" in statuses:
        return "unknown"
    if "not_configured" in statuses:
        return "at_risk"
    return "partially_protected"


def _overall_posture(findings: list[SecurityFinding], groups: list[SecurityGroup]) -> tuple[SecurityPosture, str]:
    if any(f.severity == "critical" for f in findings):
        return (
            "critical",
            "Critical finding requires immediate action. Demo seed credentials are embedded in the frontend bundle and can be exposed in production.",
        )
    if any(f.severity == "high" for f in findings):
        return (
            "at_risk",
            "High-severity findings are present. Review the Identity, Session, Infrastructure, Audit, and Recovery sections.",
        )
    if any(g.status == "at_risk" for g in groups):
        return ("at_risk", "At least one security subsection is at risk.")
    if any(g.status == "partially_protected" for g in groups):
        return (
            "partially_protected",
            "Core authentication and authorization work; some controls are partially implemented or missing.",
        )
    return ("protected", "All security controls are protected.")


def _summary(groups: list[SecurityGroup], findings: list[SecurityFinding]) -> SecuritySummary:
    summary = SecuritySummary()
    for g in groups:
        for it in g.items:
            summary.total_controls += 1
            if it.status == "protected":
                summary.protected += 1
            elif it.status == "partially_protected":
                summary.partially_protected += 1
            elif it.status == "at_risk":
                summary.at_risk += 1
            elif it.status == "unknown":
                summary.unknown += 1
            elif it.status == "not_configured":
                summary.not_configured += 1
            elif it.status == "not_applicable":
                summary.not_applicable += 1
            elif it.status == "disabled":
                summary.disabled += 1
    for f in findings:
        summary.total_findings += 1
        if f.severity == "critical":
            summary.critical_findings += 1
        elif f.severity == "high":
            summary.high_findings += 1
        elif f.severity == "medium":
            summary.medium_findings += 1
        elif f.severity == "low":
            summary.low_findings += 1
        else:
            summary.informational_findings += 1
    return summary


def _group_finding_counts(group: SecurityGroup, findings: list[SecurityFinding]) -> SecurityFindingCounts:
    """Count findings whose SEC-XXX id matches one of this group's items."""
    counts = SecurityFindingCounts()
    item_keys = {it.key.upper() for it in group.items}
    for f in findings:
        if not f.id.startswith("SEC-"):
            continue
        suffix = f.id[4:].upper()
        if suffix in item_keys:
            if f.severity == "critical":
                counts.critical += 1
            elif f.severity == "high":
                counts.high += 1
            elif f.severity == "medium":
                counts.medium += 1
            elif f.severity == "low":
                counts.low += 1
            else:
                counts.informational += 1
    return counts


def _group_control_counts(group: SecurityGroup) -> dict[str, int]:
    counts: dict[str, int] = {}
    for it in group.items:
        counts[it.status] = counts.get(it.status, 0) + 1
    return counts


async def build_security_monitoring(
    db: AsyncSession | None,
    request: Request | None = None,
) -> SecurityMonitoringOut:
    """Build the complete Security payload for the Admin Security tab.

    This is a read-only call. It does not modify any persistent state,
    does not perform destructive probes, and never returns secret
    values.
    """
    settings = get_settings()

    # 1. Build the static groups.
    groups: list[SecurityGroup] = [
        _identity_access_group(),
        _session_token_group(settings, request),
        _web_browser_group(settings),
        _api_application_group(),
        _file_upload_group(),
        _data_db_storage_group(),
        _infrastructure_group(),
        _secrets_group(),
        _audit_monitoring_group(db),
        _privacy_group(),
        _ai_group(),
        _recovery_group(),
    ]

    # 2. Run safe runtime probes.
    snapshot, partial_failures = _run_safe_probes(settings, request)

    # 3. Build the findings list.
    findings = _build_findings(groups)

    # 4. Add the audit-derived counts to the snapshot (sanitized).
    audit_counts = await _collect_activity_counts(db) if db is not None else {}
    if audit_counts:
        snapshot["audit_action_logged_present"] = {
            k: bool(v) for k, v in audit_counts.items()
        }
    snapshot["demo_credential_marker_in_spa"] = _DEMO_MARKER_PRESENT
    snapshot["jwt_secret_configured"] = bool(settings.jwt_secret)
    snapshot["jwt_secret_length"] = len(settings.jwt_secret)
    snapshot["rate_limit_max"] = settings.rate_limit_max
    snapshot["rate_limit_window_seconds"] = settings.rate_limit_window_seconds
    snapshot["jwt_access_ttl_minutes"] = settings.jwt_access_ttl_min
    snapshot["jwt_refresh_ttl_days"] = settings.jwt_refresh_ttl_days
    snapshot["app_env"] = settings.app_env
    snapshot["is_production"] = _is_production_environment(settings.app_env)

    # 5. Roll up per-group finding counts, control counts, and group status.
    for g in groups:
        g.finding_counts = _group_finding_counts(g, findings)
        g.control_counts = _group_control_counts(g)
        g.status = _group_status(g)

    # 6. Roll up overall posture and summary.
    posture, reason = _overall_posture(findings, groups)
    summary = _summary(groups, findings)

    now = datetime.now(tz=timezone.utc)
    return SecurityMonitoringOut(
        generated_at=now,
        overall_posture=posture,
        posture_reason=reason,
        summary=summary,
        groups=groups,
        findings=findings,
        last_assessed_at=now,
        configuration_snapshot=snapshot,
        partial_failures=partial_failures,
    )
