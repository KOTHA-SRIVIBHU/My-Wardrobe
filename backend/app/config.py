import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")


@dataclass(frozen=True)
class Settings:
    environment: str
    database_url: str
    db_schema: str | None  # Postgres only: put the tables in this schema instead of "public"
    auth_mode: str
    dev_user_id: str
    supabase_url: str | None
    supabase_jwt_secret: str | None
    supabase_service_key: str | None
    storage_mode: str
    storage_bucket: str
    upload_dir: Path
    cors_origins: list[str]
    groq_api_key: str | None
    groq_base_url: str
    groq_vision_model: str
    groq_text_model: str
    # Abuse protection (sign-up is open in production).
    ai_daily_limit: int
    rate_limit_per_minute: int
    max_garments_per_user: int

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


def _normalize_db_url(url: str) -> str:
    # Supabase hands out postgres:// URLs; SQLAlchemy needs the psycopg (v3) driver named.
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


def load_settings() -> Settings:
    settings = Settings(
        environment=os.getenv("ENVIRONMENT", "development"),
        database_url=_normalize_db_url(
            os.getenv("DATABASE_URL", f"sqlite:///{BACKEND_DIR / 'closetiq.db'}")
        ),
        db_schema=os.getenv("DB_SCHEMA") or None,
        auth_mode=os.getenv("AUTH_MODE", "dev"),
        dev_user_id=os.getenv("DEV_USER_ID", "dev-user"),
        supabase_url=(os.getenv("SUPABASE_URL") or "").rstrip("/") or None,
        supabase_jwt_secret=os.getenv("SUPABASE_JWT_SECRET") or None,
        supabase_service_key=os.getenv("SUPABASE_SERVICE_KEY") or None,
        storage_mode=os.getenv("STORAGE_MODE", "local"),
        storage_bucket=os.getenv("SUPABASE_BUCKET", "garment-images"),
        upload_dir=Path(os.getenv("UPLOAD_DIR", str(BACKEND_DIR / "uploads"))),
        cors_origins=[
            o.strip()
            for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",")
            if o.strip()
        ],
        groq_api_key=os.getenv("GROQ_API_KEY") or None,
        groq_base_url=os.getenv("GROQ_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/"),
        groq_vision_model=os.getenv("GROQ_VISION_MODEL", "qwen/qwen3.8-27b"),
        groq_text_model=os.getenv("GROQ_TEXT_MODEL", "openai/gpt-oss-120b"),
        ai_daily_limit=int(os.getenv("AI_DAILY_LIMIT_PER_USER", "40")),
        rate_limit_per_minute=int(os.getenv("RATE_LIMIT_PER_MINUTE", "240")),
        max_garments_per_user=int(os.getenv("MAX_GARMENTS_PER_USER", "1500")),
    )
    if settings.environment == "production" and settings.auth_mode == "dev":
        raise RuntimeError("AUTH_MODE=dev is not allowed when ENVIRONMENT=production")
    if settings.auth_mode == "supabase" and not settings.supabase_url:
        raise RuntimeError("AUTH_MODE=supabase requires SUPABASE_URL")
    if settings.storage_mode == "supabase" and not (
        settings.supabase_url and settings.supabase_service_key
    ):
        raise RuntimeError("STORAGE_MODE=supabase requires SUPABASE_URL and SUPABASE_SERVICE_KEY")
    return settings


settings = load_settings()
