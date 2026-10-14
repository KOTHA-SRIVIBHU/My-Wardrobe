import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from . import models  # noqa: F401  (registers tables on Base.metadata)
from .ai import AIUnavailable
from .config import settings
from .db import Base, SessionLocal, add_missing_columns, add_missing_indexes, engine
from .lifecycle import LifecycleError, consolidate_ironing_baskets
from .routers import (
    backup,
    baskets,
    calendar,
    dashboard,
    garments,
    insights,
    outfits,
    pairs,
    plan,
    routines,
)

log = logging.getLogger("closetiq")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if settings.auth_mode == "dev":
        log.warning("AUTH_MODE=dev: all requests act as '%s'. Local use only.", settings.dev_user_id)
    Base.metadata.create_all(engine)
    for column in add_missing_columns(engine):
        log.warning("Added missing column %s", column)
    # Older versions could leave several ironing baskets; merge them before the
    # one-per-user index is created.
    with SessionLocal() as db:
        if merged := consolidate_ironing_baskets(db):
            log.warning("Merged %d duplicate ironing basket(s)", merged)
        db.commit()
    add_missing_indexes(engine)
    yield


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# Interactive API docs only outside production.
_docs = {} if not settings.is_production else {"docs_url": None, "redoc_url": None, "openapi_url": None}
app = FastAPI(title="ClosetIQ API", version="1.0.0", lifespan=lifespan, **_docs)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,  # auth is a bearer token, not cookies
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=600,
)

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "cross-origin",
}


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    for k, v in SECURITY_HEADERS.items():
        response.headers.setdefault(k, v)
    if settings.is_production:
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


@app.exception_handler(LifecycleError)
async def lifecycle_error(_request: Request, exc: LifecycleError):
    return JSONResponse(status_code=409, content={"detail": exc.message, "code": exc.code})


@app.exception_handler(AIUnavailable)
async def ai_unavailable(_request: Request, exc: AIUnavailable):
    # 503 tells the client "this optional AI feature is unavailable", never "the app is broken";
    # 429 when this user's own daily allowance is used up.
    return JSONResponse(
        status_code=429 if exc.code == "ai_user_limit" else 503,
        content={"detail": exc.message, "code": exc.code, "retry_after": exc.retry_after},
    )


@app.exception_handler(IntegrityError)
async def integrity_error(_request: Request, _exc: IntegrityError):
    # Most likely two requests raced to put the same garment in different baskets.
    return JSONResponse(
        status_code=409,
        content={"detail": "That change conflicts with another one. Refresh and try again.",
                 "code": "integrity"},
    )


@app.exception_handler(Exception)
async def unexpected_error(request: Request, exc: Exception):
    # Log the details; never leak internals to the client.
    log.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(status_code=500, content={"detail": "Something went wrong on our side. Please try again."})


@app.get("/api/health")
def health(deep: bool = False):
    """deep=true also checks the database (used by the keep-alive job, which keeps Supabase active)."""
    out = {"status": "ok", "auth_mode": settings.auth_mode, "storage_mode": settings.storage_mode}
    if deep:
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            out["database"] = "ok"
        except Exception:
            log.exception("Database health check failed")
            return JSONResponse(status_code=503, content={**out, "status": "degraded", "database": "unreachable"})
    return out


app.include_router(garments.router)
app.include_router(pairs.router)
app.include_router(baskets.router)
app.include_router(dashboard.router)
app.include_router(outfits.router)
app.include_router(routines.router)
app.include_router(calendar.router)
app.include_router(plan.router)
app.include_router(insights.router)
app.include_router(backup.router)

if settings.storage_mode == "local":
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/media", StaticFiles(directory=settings.upload_dir), name="media")
