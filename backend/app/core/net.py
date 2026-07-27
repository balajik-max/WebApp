"""Client IP / user-agent extraction.

Single source of truth so every caller (rate limiter, login, heartbeat,
logout, activity log) agrees on the visitor's real address. Behind the
Cloudflare Tunnel, the connection FastAPI sees is always from the local
`cloudflared` process, so `request.client.host` alone is useless — the real
visitor address only survives in the `CF-Connecting-IP` header that
Cloudflare adds. `X-Forwarded-For` is kept as a fallback for local/dev
setups that go through nginx without Cloudflare in front.
"""
from __future__ import annotations

from fastapi import Request

_MAX_UA_LENGTH = 500


def client_ip(request: Request) -> str:
    cf_ip = request.headers.get("CF-Connecting-IP", "").strip()
    if cf_ip:
        return cf_ip
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"


def user_agent(request: Request) -> str | None:
    ua = request.headers.get("User-Agent", "").strip()
    if not ua:
        return None
    return ua[:_MAX_UA_LENGTH]
