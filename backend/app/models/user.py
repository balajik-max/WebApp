"""users table — admin & architect are the only v1 roles."""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Enum as SAEnum, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models._mixins import created_at_col, updated_at_col, uuid_pk


class UserRole(str, enum.Enum):
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

    created_at: Mapped[datetime] = created_at_col()
    updated_at: Mapped[datetime] = updated_at_col()

    # Relationships (declared lazily to avoid circular imports).
    datasets = relationship("Dataset", back_populates="uploader", lazy="raise")
    comments = relationship("Comment", back_populates="author", lazy="raise")
    activity_logs = relationship("ActivityLog", back_populates="actor", lazy="raise")

    def __repr__(self) -> str:  # pragma: no cover
        return f"<User {self.email} ({self.role.value})>"
