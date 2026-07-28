"""Auth request/response payloads."""
from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field

from app.schemas.user import UserPublic


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=256)
    # Client viewport size (window.screen.width/height), best-effort — used
    # only to show device details in Admin -> Users & Activity.
    screen_width: int | None = Field(default=None, ge=0, le=32767)
    screen_height: int | None = Field(default=None, ge=0, le=32767)


class HeartbeatRequest(BaseModel):
    screen_width: int | None = Field(default=None, ge=0, le=32767)
    screen_height: int | None = Field(default=None, ge=0, le=32767)


class ChangePasswordRequest(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)
    confirm_password: str = Field(min_length=1, max_length=256)


class ChangePasswordResponse(BaseModel):
    ok: bool = True
    message: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserPublic
