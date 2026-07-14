"""category_class_map table — caches raw survey category strings (as they
appear verbatim in Feature.category, e.g. "Power Pole With Light") resolved
to a small canonical taxonomy (e.g. "Illumination_Asset").

This cache is what makes semantic resolution cheap at any dataset size: the
embedding-based fallback in app.services.classification only ever runs once
per distinct raw_category ever seen system-wide, never per feature row.
"""
from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import Enum as SAEnum, Float, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models._mixins import created_at_col, uuid_pk


class ClassMatchMethod(str, enum.Enum):
    EXACT = "exact"
    FUZZY = "fuzzy"
    EMBEDDING = "embedding"
    MANUAL = "manual"


class CategoryClassMap(Base):
    __tablename__ = "category_class_map"

    id: Mapped[uuid.UUID] = uuid_pk()

    raw_category: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    canonical_class: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    match_method: Mapped[ClassMatchMethod] = mapped_column(
        SAEnum(ClassMatchMethod, name="class_match_method", native_enum=False, length=16),
        nullable=False,
    )
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)

    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[datetime] = created_at_col()
