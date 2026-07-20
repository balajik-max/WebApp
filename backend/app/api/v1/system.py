"""System storage statistics."""
from __future__ import annotations

import os
import shutil

from fastapi import APIRouter

router = APIRouter()


@router.get("/v1/system/storage")
async def system_storage() -> dict:
    path = os.environ.get("STORAGE_MOUNT", "/data")
    try:
        usage = shutil.disk_usage(path)
    except OSError:
        usage = shutil.disk_usage("/")
    total = usage.total
    free = usage.free
    used = total - free
    return {
        "path": path,
        "total_bytes": total,
        "used_bytes": used,
        "free_bytes": free,
        "used_percent": round((used / total) * 100, 1) if total else 0.0,
    }
