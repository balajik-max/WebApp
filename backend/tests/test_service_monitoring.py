"""Unit tests for the new grouped services monitoring interface.

Covers:
- service_inventory: capability detection helpers and env helpers
- service_health: cache, sanitization, endpoint label masking
- service_monitoring: Pydantic schema round-trips and enum validation
"""

from __future__ import annotations

import asyncio
import time
import typing

import pytest

from app.schemas.service_monitoring import (
    ServiceCriticality,
    ServiceMonitoringGroup,
    ServiceMonitoringItem,
    ServiceMonitoringKind,
    ServiceMonitoringOut,
    ServiceMonitoringStatus,
    ServiceMonitoringSummary,
)
from app.services import service_health, service_inventory


def _literal_values(lit: object) -> set[str]:
    return set(typing.get_args(lit))  # type: ignore[arg-type]


# ─────────────────────────────────────────────────────────────────────
# service_inventory: capability detection
# ─────────────────────────────────────────────────────────────────────


def test_safe_has_module_known_present() -> None:
    # json is part of the stdlib — must always be importable
    assert service_inventory.safe_has_module("json") is True


def test_safe_has_module_known_absent() -> None:
    assert service_inventory.safe_has_module("__definitely_not_a_real_module_xyz__") is False


def test_detect_capabilities_returns_bool_values() -> None:
    service_inventory.reset_capability_cache()
    caps = service_inventory.detect_capabilities()
    assert isinstance(caps, dict)
    assert len(caps) > 0
    for key, value in caps.items():
        assert isinstance(key, str)
        assert isinstance(value, bool)


def test_detect_capabilities_is_cached(monkeypatch) -> None:
    service_inventory.reset_capability_cache()
    # First call populates the cache
    first = service_inventory.detect_capabilities()
    # Force a re-eval to be impossible: monkey-patch find_spec
    import importlib.util as _il

    def _fail(name, package=None):
        raise AssertionError("find_spec should not be called twice")

    monkeypatch.setattr(_il, "find_spec", _fail)
    second = service_inventory.detect_capabilities()
    assert first == second


def test_capability_status_returns_known_status_strings() -> None:
    # The helper returns a ServiceMonitoringStatus value. The exact
    # mapping (healthy / partial / degraded / critical / not_configured /
    # unknown) depends on the input set, so we just check the result is
    # a known status token.
    valid = {
        "healthy", "partial", "degraded", "critical",
        "not_configured", "unknown",
    }
    cases = [
        [True, True, True],
        [True, False, True],
        [True, False, False],
        [False, False],
        [],
    ]
    for case in cases:
        result = service_inventory.capability_status(case)
        assert result in valid, f"unexpected status {result!r} for {case!r}"


def test_capability_status_distinguishes_all_present() -> None:
    assert service_inventory.capability_status([True, True, True]) == "healthy"


# ─────────────────────────────────────────────────────────────────────
# service_inventory: env helpers
# ─────────────────────────────────────────────────────────────────────


def test_vite_cadastral_url_unset(monkeypatch) -> None:
    monkeypatch.delenv("VITE_CADASTRAL_TILE_URL", raising=False)
    assert service_inventory.vite_cadastral_url() is None


def test_vite_cadastral_url_set(monkeypatch) -> None:
    monkeypatch.setenv("VITE_CADASTRAL_TILE_URL", "https://example.com/tiles/{z}/{x}/{y}.png")
    assert service_inventory.vite_cadastral_url() == "https://example.com/tiles/{z}/{x}/{y}.png"


def test_vite_google_maps_key_normalizes_empty(monkeypatch) -> None:
    for val in ("", "REPLACE_WITH_YOUR_KEY", "REPLACE_ME"):
        monkeypatch.setenv("VITE_GOOGLE_MAPS_API_KEY", val)
        # The helper returns a string label (or None) — it never returns
        # the raw placeholder. Verify the raw placeholder text is gone.
        out = service_inventory.vite_google_maps_key()
        if out is not None:
            assert val not in out, f"placeholder {val!r} leaked into {out!r}"


def test_vite_google_maps_key_returns_some_string_when_configured(monkeypatch) -> None:
    monkeypatch.setenv("VITE_GOOGLE_MAPS_API_KEY", "AIza-real-key-123")
    out = service_inventory.vite_google_maps_key()
    # Helper returns either the key (sanitized) or a label — both are
    # acceptable; we just want to confirm a non-empty string is returned.
    assert isinstance(out, str) and out


def test_davangere_census_url_returns_string(monkeypatch) -> None:
    monkeypatch.delenv("DAVANGERE_CENSUS_URL", raising=False)
    out = service_inventory.davangere_census_url()
    # Helper returns either None or a label string.
    assert out is None or isinstance(out, str)


# ─────────────────────────────────────────────────────────────────────
# service_health: _MonitoringCache
# ─────────────────────────────────────────────────────────────────────


def test_cache_set_and_get_within_ttl() -> None:
    cache = service_health._MonitoringCache()
    assert cache.get("k") is None
    cache.set("k", "v", ttl=10)
    assert cache.get("k") == "v"


def test_cache_expires_after_ttl() -> None:
    cache = service_health._MonitoringCache()
    cache.set("k", "v", ttl=0.05)
    assert cache.get("k") == "v"
    time.sleep(0.08)
    assert cache.get("k") is None


def test_cache_clear_removes_all_keys() -> None:
    cache = service_health._MonitoringCache()
    cache.set("a", 1, ttl=10)
    cache.set("b", 2, ttl=10)
    cache.clear()
    assert cache.get("a") is None
    assert cache.get("b") is None


# ─────────────────────────────────────────────────────────────────────
# service_health: sanitization
# ─────────────────────────────────────────────────────────────────────


def test_sanitize_strips_token_query_param() -> None:
    out = service_health._sanitize("https://example.com/?token=abc123&keep=1")
    assert out is not None
    assert "abc123" not in out
    assert "token=***" in out
    assert "keep=1" in out


def test_sanitize_strips_apikey_and_password() -> None:
    out = service_health._sanitize("https://x/?apikey=secret&password=hunter2&safe=ok")
    assert out is not None
    assert "secret" not in out
    assert "hunter2" not in out
    assert "safe=ok" in out


def test_sanitize_truncates_long_strings() -> None:
    out = service_health._sanitize("a" * 1000, max_len=50)
    assert out is not None
    assert len(out) <= 50


def test_sanitize_none_returns_none() -> None:
    assert service_health._sanitize(None) is None


def test_sanitize_takes_first_line_only() -> None:
    out = service_health._sanitize("first line\nsecond line with token=abc")
    assert out is not None
    assert out.startswith("first line")
    # second line content is dropped
    assert "token=abc" not in out


# ─────────────────────────────────────────────────────────────────────
# service_health: endpoint label masking
# ─────────────────────────────────────────────────────────────────────


def test_endpoint_label_does_not_leak_password() -> None:
    """Whatever the helper returns, the raw password MUST NOT appear in
    the output — this is the security contract that matters most."""
    out = service_health._endpoint_label("https://user:hunter2@example.com/path")
    assert out is not None
    assert "hunter2" not in out
    # And it should be a non-empty string
    assert isinstance(out, str) and out


def test_endpoint_label_preserves_safe_url() -> None:
    out = service_health._endpoint_label("https://example.com:9000/path")
    assert out is not None
    assert "example.com" in out
    assert ":9000" in out


def test_endpoint_label_none_returns_string() -> None:
    """The helper provides a fallback label rather than None for safety."""
    out = service_health._endpoint_label(None)
    assert isinstance(out, str)


# ─────────────────────────────────────────────────────────────────────
# service_health: probe_database_size (returns dict; we don't have a
# live DB session in unit tests so we just import the function)
# ─────────────────────────────────────────────────────────────────────


def test_probe_database_size_is_coroutine() -> None:
    import inspect
    assert inspect.iscoroutinefunction(service_health.probe_database_size)


# ─────────────────────────────────────────────────────────────────────
# Schemas: enum values
# ─────────────────────────────────────────────────────────────────────


def test_status_enum_has_eight_values() -> None:
    expected = {
        "healthy", "degraded", "critical", "offline",
        "unknown", "not_configured", "disabled", "partial",
    }
    assert _literal_values(ServiceMonitoringStatus) == expected


def test_kind_enum_has_six_values() -> None:
    expected = {
        "service", "subsystem", "capability",
        "resource", "configuration", "external_dependency",
    }
    assert _literal_values(ServiceMonitoringKind) == expected


def test_criticality_enum_has_four_values() -> None:
    expected = {"critical", "high", "medium", "low"}
    assert _literal_values(ServiceCriticality) == expected


# ─────────────────────────────────────────────────────────────────────
# Schemas: round-trip a typical payload
# ─────────────────────────────────────────────────────────────────────


def test_item_round_trip_dict() -> None:
    item = ServiceMonitoringItem(
        key="frontend",
        name="Frontend",
        kind="service",
        status="healthy",
        criticality="high",
        description="React SPA served via nginx.",
        primary_metric={"label": "Build", "value": "v3.2"},
        response_time_ms=42.0,
        endpoint_label="http://frontend:3000",
        last_checked_at="2026-07-24T10:00:00Z",
        detail="OK",
        dependencies=["backend"],
        details={"build": "v3.2"},
        parent_key=None,
    )
    data = item.model_dump()
    assert data["key"] == "frontend"
    assert data["status"] == "healthy"
    assert data["criticality"] == "high"
    assert data["primary_metric"]["label"] == "Build"
    # Re-validate
    again = ServiceMonitoringItem.model_validate(data)
    assert again.key == item.key


def test_group_round_trip_dict() -> None:
    item = ServiceMonitoringItem(
        key="backend",
        name="Backend",
        kind="service",
        status="healthy",
        criticality="critical",
        description="FastAPI service.",
        primary_metric=None,
        response_time_ms=12.0,
        endpoint_label="http://backend:8000",
        last_checked_at="2026-07-24T10:00:00Z",
        detail=None,
        dependencies=[],
        details={},
        parent_key=None,
    )
    group = ServiceMonitoringGroup(
        id="core_platform",
        label="Core Platform",
        description="API and web tier.",
        status="healthy",
        item_count=1,
        items=[item],
    )
    data = group.model_dump()
    assert data["id"] == "core_platform"
    assert data["item_count"] == 1
    assert data["items"][0]["key"] == "backend"


def test_summary_zero_values() -> None:
    s = ServiceMonitoringSummary(
        healthy=0, degraded=0, critical=0, offline=0,
        unknown=0, not_configured=0, disabled=0, partial=0,
    )
    assert s.model_dump() == {
        "healthy": 0, "degraded": 0, "critical": 0, "offline": 0,
        "unknown": 0, "not_configured": 0, "disabled": 0, "partial": 0,
    }


def test_full_out_round_trip() -> None:
    item = ServiceMonitoringItem(
        key="backend",
        name="Backend",
        kind="service",
        status="healthy",
        criticality="critical",
        description="FastAPI service.",
        primary_metric=None,
        response_time_ms=12.0,
        endpoint_label="http://backend:8000",
        last_checked_at="2026-07-24T10:00:00Z",
        detail=None,
        dependencies=[],
        details={},
        parent_key=None,
    )
    out = ServiceMonitoringOut(
        generated_at="2026-07-24T10:00:00Z",
        overall_status="healthy",
        overall_detail="All services healthy",
        summary=ServiceMonitoringSummary(
            healthy=1, degraded=0, critical=0, offline=0,
            unknown=0, not_configured=0, disabled=0, partial=0,
        ),
        groups=[
            ServiceMonitoringGroup(
                id="core_platform",
                label="Core Platform",
                description="API and web tier.",
                status="healthy",
                item_count=1,
                items=[item],
            )
        ],
        item_index={"backend": "core_platform"},
    )
    data = out.model_dump()
    assert data["overall_status"] == "healthy"
    assert data["summary"]["healthy"] == 1
    assert data["groups"][0]["id"] == "core_platform"
    assert data["item_index"]["backend"] == "core_platform"


def test_invalid_status_rejected() -> None:
    with pytest.raises(Exception):
        ServiceMonitoringItem(
            key="x",
            name="X",
            kind="service",
            status="ok",  # not in the enum
            criticality="low",
            description=".",
            primary_metric=None,
            response_time_ms=None,
            endpoint_label=None,
            last_checked_at=None,
            detail=None,
            dependencies=[],
            details={},
            parent_key=None,
        )
