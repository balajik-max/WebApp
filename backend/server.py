"""
Supervisor / uvicorn entrypoint.

Historically this file contained the whole FastAPI app.  The application
has been restructured into the `app/` package for modularity; this
shim only re-exports the ASGI application so existing tooling
(`uvicorn server:app`) keeps working.
"""
from app.main import app  # noqa: F401
