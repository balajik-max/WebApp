"""
Typed settings loaded from environment variables via pydantic-settings.
Zero defaults are provided for secrets/URLs — the process fails fast if
they are missing so that no fallback string is ever silently used.

Every field accepts BOTH the canonical name from the production
`.env.example` (e.g. `JWT_SECRET_KEY`) and the legacy short name
(e.g. `JWT_SECRET`).  This lets an operator use the exact variable
names listed in the runbook without ever changing code.
"""
from __future__ import annotations

from functools import lru_cache

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Single source of truth for the upload size cap — shared by the
# SecurityMiddleware body-size check (rejects before the body is fully
# read) and the datasets upload route (rejects after buffering). Real-world
# GIS rasters/point clouds routinely run several hundred MB, so this is set
# generously for a self-hosted deployment rather than the 300MB that
# rejected genuine survey data.
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "backend/.env"),
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- App -------------------------------------------------------------
    app_env: str = Field(default="development", validation_alias="APP_ENV")
    app_name: str = Field(default="Davangere Urban Survey", validation_alias="APP_NAME")
    log_level: str = Field(default="INFO", validation_alias="LOG_LEVEL")
    frontend_url: str = Field(validation_alias="FRONTEND_URL")

    # --- Rate limiting ---------------------------------------------------
    rate_limit_max: int = Field(default=10, validation_alias="RATE_LIMIT_MAX")
    rate_limit_window_seconds: int = Field(default=60, validation_alias="RATE_LIMIT_WINDOW_SECONDS")

    # --- Auth ------------------------------------------------------------
    jwt_secret: str = Field(
        validation_alias=AliasChoices("JWT_SECRET_KEY", "JWT_SECRET"),
    )
    jwt_algorithm: str = Field(default="HS256", validation_alias="JWT_ALGORITHM")
    jwt_access_ttl_min: int = Field(
        default=1440,
        validation_alias=AliasChoices("ACCESS_TOKEN_EXPIRE_MINUTES", "JWT_ACCESS_TTL_MIN"),
    )
    jwt_refresh_ttl_days: int = Field(default=7, validation_alias="JWT_REFRESH_TTL_DAYS")

    # --- Database --------------------------------------------------------
    database_url: str = Field(validation_alias="DATABASE_URL")

    # --- Storage (MinIO / S3) -------------------------------------------
    s3_endpoint_url: str = Field(
        validation_alias=AliasChoices("MINIO_ENDPOINT", "S3_ENDPOINT_URL"),
    )
    s3_bucket: str = Field(
        validation_alias=AliasChoices("MINIO_BUCKET_NAME", "S3_BUCKET"),
    )
    s3_region: str = Field(default="us-east-1", validation_alias="S3_REGION")
    s3_access_key: str = Field(validation_alias="MINIO_ROOT_USER")
    s3_secret_key: str = Field(validation_alias="MINIO_ROOT_PASSWORD")

    # --- AI --------------------------------------------------------------
    ollama_base_url: str = Field(validation_alias="OLLAMA_BASE_URL")
    ollama_model: str = Field(default="qwen2.5:3b-instruct", validation_alias="OLLAMA_MODEL")
    ollama_embed_model: str = Field(default="nomic-embed-text", validation_alias="OLLAMA_EMBED_MODEL")
    ai_max_context_tokens: int = Field(default=4096, validation_alias="AI_MAX_CONTEXT_TOKENS")
    ai_max_features: int = Field(default=30, validation_alias="AI_MAX_FEATURES")

    # --- AI remediation evidence ----------------------------------------
    remediation_pole_buffer_m: float = Field(default=15.0, validation_alias="REMEDIATION_POLE_BUFFER_M")
    remediation_manhole_buffer_m: float = Field(default=15.0, validation_alias="REMEDIATION_MANHOLE_BUFFER_M")
    remediation_drain_buffer_m: float = Field(default=30.0, validation_alias="REMEDIATION_DRAIN_BUFFER_M")
    remediation_max_image_mb: int = Field(default=12, validation_alias="REMEDIATION_MAX_IMAGE_MB")

    # --- Seed users ------------------------------------------------------
    admin_email: str = Field(validation_alias="ADMIN_EMAIL")
    admin_password: str = Field(validation_alias="ADMIN_PASSWORD")
    admin_name: str = Field(default="System Administrator", validation_alias="ADMIN_NAME")

    architect_email: str = Field(validation_alias="ARCHITECT_EMAIL")
    architect_password: str = Field(validation_alias="ARCHITECT_PASSWORD")
    architect_name: str = Field(default="City Architect", validation_alias="ARCHITECT_NAME")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
