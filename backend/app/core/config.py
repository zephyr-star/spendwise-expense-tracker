"""
Application configuration - environment-driven, secrets-safe.
"""
from functools import lru_cache
from typing import List, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", case_sensitive=False)

    # ── App ───────────────────────────────────────────────────────────────────
    APP_NAME: str = "SpendWise"
    VERSION: str = "1.0.0"
    ENVIRONMENT: str = "development"
    DEBUG: bool = False
    SECRET_KEY: str  # REQUIRED - no default

    # ── Database ──────────────────────────────────────────────────────────────
    DATABASE_URL: str  # postgresql+asyncpg://user:pass@host:5432/db
    DATABASE_POOL_SIZE: int = 20
    DATABASE_MAX_OVERFLOW: int = 10
    DATABASE_POOL_TIMEOUT: int = 30

    # ── JWT ───────────────────────────────────────────────────────────────────
    JWT_SECRET_KEY: str  # REQUIRED
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30

    # ── Google OAuth ──────────────────────────────────────────────────────────
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""

    # ── Object Storage (S3-compatible) ────────────────────────────────────────
    STORAGE_BACKEND: str = "s3"   # s3 | gcs | local
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_REGION: str = "us-east-1"
    S3_BUCKET_RECEIPTS: str = "spendwise-receipts"
    GCS_BUCKET_RECEIPTS: str = ""
    LOCAL_STORAGE_PATH: str = "/tmp/receipts"

    # ── Redis (Celery broker + cache) ─────────────────────────────────────────
    REDIS_URL: str = "redis://localhost:6379/0"
    CACHE_TTL_SECONDS: int = 300

    # ── Currency exchange ─────────────────────────────────────────────────────
    EXCHANGE_RATE_API_URL: str = "https://api.exchangerate-api.com/v4/latest"
    EXCHANGE_RATE_API_KEY: str = ""
    EXCHANGE_RATE_CACHE_TTL: int = 3600  # 1 hour

    # ── ML / OCR ──────────────────────────────────────────────────────────────
    OCR_BACKEND: str = "tesseract"   # tesseract | google_vision | aws_textract
    GOOGLE_VISION_CREDENTIALS: str = ""
    AWS_TEXTRACT_REGION: str = "us-east-1"
    CLOUD_ML_ENABLED: bool = False
    CLOUD_ML_ENDPOINT: str = ""

    # ── Notifications ─────────────────────────────────────────────────────────
    FIREBASE_SERVER_KEY: str = ""
    FIREBASE_PROJECT_ID: str = ""
    APNS_KEY_ID: str = ""
    APNS_AUTH_KEY: str = ""
    APNS_TEAM_ID: str = ""
    APNS_BUNDLE_ID: str = "com.spendwise.app"

    # ── Email (for account ops only, no PII leakage) ──────────────────────────
    SMTP_HOST: str = ""
    SMTP_PORT: int = 587
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    EMAIL_FROM: str = "noreply@spendwise.app"

    # ── Security ──────────────────────────────────────────────────────────────
    ALLOWED_ORIGINS: List[str] = ["http://localhost:3000", "capacitor://localhost"]
    RATE_LIMIT_PER_MINUTE: int = 100
    MAX_RECEIPT_SIZE_MB: int = 10
    ENCRYPTION_KEY: str  # REQUIRED - Fernet key for local backup encryption

    # ── Observability ─────────────────────────────────────────────────────────
    SENTRY_DSN: Optional[str] = None
    LOG_LEVEL: str = "INFO"
    OTEL_ENDPOINT: str = ""  # OpenTelemetry collector

    # ── Feature flags ─────────────────────────────────────────────────────────
    FEATURE_GAMIFICATION: bool = True
    FEATURE_BANK_INTEGRATION: bool = False
    FEATURE_VOICE_ENTRY: bool = False
    FEATURE_COLLABORATIVE_GOALS: bool = False


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()