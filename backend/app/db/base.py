"""SQLAlchemy async declarative base."""
from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Root declarative base for all ORM models."""
