"""Public/citizen portal API contracts."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.models.dataset import DatasetFileType, DatasetStatus
from app.models.public_portal import PublicComplaintStatus, PublicNotificationKind


class PublicUserOut(BaseModel):
    id: uuid.UUID
    first_name: str
    last_name: str
    phone: str
    email: EmailStr | None = None
    username: str
    created_at: datetime

    model_config = {"from_attributes": True}


class PublicOtpRequest(BaseModel):
    phone: str = Field(min_length=8, max_length=20)
    email: EmailStr


class PublicOtpRequestOut(BaseModel):
    challenge_id: uuid.UUID
    expires_at: datetime
    resend_after_seconds: int
    masked_email: str
    debug_otp: str | None = None


class PublicOtpVerifyRequest(BaseModel):
    challenge_id: uuid.UUID
    otp: str = Field(pattern=r"^\d{6}$")


class PublicOtpVerifyOut(BaseModel):
    challenge_id: uuid.UUID
    registration_token: str
    registration_token_expires_at: datetime
    masked_email: str


class PublicUsernameAvailabilityOut(BaseModel):
    username: str
    available: bool


class PublicRegisterRequest(BaseModel):
    challenge_id: uuid.UUID
    registration_token: str = Field(min_length=32, max_length=512)
    first_name: str = Field(min_length=1, max_length=120)
    last_name: str = Field(min_length=1, max_length=120)
    username: str = Field(min_length=4, max_length=64)
    password: str = Field(min_length=1, max_length=128)
    confirm_password: str = Field(min_length=1, max_length=128)
    screen_width: int | None = Field(default=None, ge=0, le=32767)
    screen_height: int | None = Field(default=None, ge=0, le=32767)

    @field_validator("first_name", "last_name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("Name is required")
        return cleaned


class PublicLoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)
    screen_width: int | None = Field(default=None, ge=0, le=32767)
    screen_height: int | None = Field(default=None, ge=0, le=32767)


class PublicTokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: PublicUserOut


class PublicImageMetadataOut(BaseModel):
    filename: str
    size_bytes: int
    content_type: str
    has_geotag: bool
    latitude: float | None = None
    longitude: float | None = None
    captured_at: datetime | None = None


class PublicComplaintOut(BaseModel):
    id: uuid.UUID
    title: str
    description: str
    status: PublicComplaintStatus
    latitude: float
    longitude: float
    location_accuracy_m: float | None = None
    location_label: str | None = None
    location_source: str | None = None
    image_url: str
    commissioner_viewed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class OfficerPublicComplaintOut(PublicComplaintOut):
    public_user_name: str
    public_username: str
    public_phone: str
    image_exif_latitude: float | None = None
    image_exif_longitude: float | None = None
    submitted_ip: str | None = None
    submitted_user_agent: str | None = None


class PublicNotificationOut(BaseModel):
    id: uuid.UUID
    complaint_id: uuid.UUID | None = None
    kind: PublicNotificationKind
    message: str
    read_at: datetime | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class OfficerPublicComplaintNotificationOut(BaseModel):
    notification_id: uuid.UUID
    complaint_id: uuid.UUID
    title: str
    message: str
    created_at: datetime
    read_at: datetime | None = None


class PublicDatasetOut(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None = None
    file_type: DatasetFileType
    status: DatasetStatus
    size_bytes: int | None = None
    processing_error: str | None = None
    dataset_metadata: dict = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class PublicDatasetUploadAccepted(BaseModel):
    dataset: PublicDatasetOut
    poll_url: str


class PublicDatasetBoundsOut(BaseModel):
    min_lon: float
    min_lat: float
    max_lon: float
    max_lat: float


class PublicDatasetLayerOut(BaseModel):
    name: str
    feature_count: int
