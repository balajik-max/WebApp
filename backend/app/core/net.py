"""Client IP / user-agent extraction.

Single source of truth so every caller (rate limiter, login, heartbeat,
logout, activity log) agrees on the visitor's real address. Behind the
Cloudflare Tunnel, the connection FastAPI sees is always from the local
`cloudflared` process, so `request.client.host` alone is useless — the real
visitor address only survives in the `CF-Connecting-IP` header that
Cloudflare adds. `X-Forwarded-For` is kept as a fallback for local/dev
setups that go through nginx without Cloudflare in front.

IPv4 addresses are preferred over IPv6 when multiple addresses are available.
"""
from __future__ import annotations

import ipaddress

from fastapi import Request

_MAX_UA_LENGTH = 500


def _is_ipv4(addr: str) -> bool:
    """Check if the address is IPv4."""
    try:
        return isinstance(ipaddress.ip_address(addr), ipaddress.IPv4Address)
    except ValueError:
        return False


def _prefer_ipv4(addr_list: list[str]) -> str:
    """Return the first IPv4 address from the list, or the first address if none are IPv4."""
    if not addr_list:
        return "0.0.0.0"
    # First pass: look for IPv4
    for addr in addr_list:
        if _is_ipv4(addr):
            return addr
    # Fallback: return first address (likely IPv6)
    return addr_list[0]


def client_ip(request: Request) -> str:
    cf_ip = request.headers.get("CF-Connecting-IP", "").strip()
    if cf_ip:
        # Handle potential comma-separated list in CF-Connecting-IP
        candidates = [ip.strip() for ip in cf_ip.split(",") if ip.strip()]
        if candidates:
            return _prefer_ipv4(candidates)
    
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        candidates = [ip.strip() for ip in forwarded.split(",") if ip.strip()]
        if candidates:
            return _prefer_ipv4(candidates)
    
    fallback = request.client.host if request.client else "0.0.0.0"
    return fallback


def user_agent(request: Request) -> str | None:
    ua = request.headers.get("User-Agent", "").strip()
    if not ua:
        return None
    return ua[:_MAX_UA_LENGTH]
