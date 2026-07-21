"""Users and active operational roles.

The role enum is deliberately a `str` enum stored as a plain VARCHAR
(`native_enum=False`), so adding a new role is a code-only change that needs
no native PostgreSQL enum migration. Admin and Architect remain enum members
only so historically referenced rows decode safely; startup deactivates them.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Boolean, Enum as SAEnum, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models._mixins import created_at_col, updated_at_col, uuid_pk


class UserRole(str, enum.Enum):
    COMMISSIONER = "commissioner"
    AEE = "aee"  # Assistant Executive Engineer
    AE = "ae"  # Assistant Engineer
    MLA = "mla"  # Strictly read-only
    ADMIN = "admin"
    ARCHITECT = "architect"


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[UserRole] = mapped_column(
        SAEnum(UserRole, name="user_role", native_enum=False, length=32),
        nullable=False,
    )
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    # Relationships (declared lazily to avoid circular imports).
    datasets = relationship("Dataset", back_populates="uploader", lazy="raise")
    comments = relationship("Comment", back_populates="author", lazy="raise")
    activity_logs = relationship("ActivityLog", back_populates="actor", lazy="raise")
    placemarks = relationship(
        "Placemark", back_populates="owner", cascade="all, delete-orphan", lazy="raise"
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<User {self.email} ({self.role.value})>"
