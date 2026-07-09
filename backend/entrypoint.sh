#!/bin/sh
# ---------------------------------------------------------------------------
# Davangere backend entrypoint.
#
# Runs every time the FastAPI container starts. Idempotent by design.
#
#   1. Wait until PostGIS reports ready (belt-and-braces on top of the
#      compose healthcheck).
#   2. Run the schema + spatial index bootstrap AND the seed script - both
#      are safe on repeat invocations. Failures are FATAL: the container
#      exits with a non-zero status so Docker restarts it.
#   3. Exec into the command supplied via CMD (default: uvicorn).
# ---------------------------------------------------------------------------
set -eu

log() { printf '[entrypoint] %s\n' "$*" >&2; }

# ---- 1. wait for Postgres -------------------------------------------------
if [ -n "${DATABASE_URL:-}" ]; then
    log "waiting for database to accept connections..."
    tries=0
    until python -c "
import asyncio, os, sys
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy import text

async def probe():
    engine = create_async_engine(os.environ['DATABASE_URL'])
    async with engine.connect() as conn:
        await conn.execute(text('SELECT 1'))
    await engine.dispose()

asyncio.run(probe())
" >/dev/null 2>&1; do
        tries=$((tries + 1))
        if [ "$tries" -gt 60 ]; then
            log "database did not become reachable after 60 attempts - aborting"
            exit 1
        fi
        sleep 2
    done
    log "database reachable."
fi

# ---- 2. schema bootstrap + seed ------------------------------------------
log "running schema bootstrap + seed (idempotent)..."
python seed.py

# ---- 3. hand off to CMD ---------------------------------------------------
log "starting: $*"
exec "$@"
