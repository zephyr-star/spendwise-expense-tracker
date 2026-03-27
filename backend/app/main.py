"""
SpendWise - Production-Grade Expense Tracker
FastAPI Backend - Main Application Entry Point
"""
import logging
import time
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from prometheus_client import Counter, Histogram, make_asgi_app

from app.api import (
    auth, budgets, categories, expenses, exports,
    notifications, receipts, reports, sync, tags,
    users, wallets
)
from app.core.config import settings
from app.core.database import engine, Base
from app.core.exceptions import AppException
from app.workers.scheduler import start_scheduler, stop_scheduler

# ── Structured logging ────────────────────────────────────────────────────────
structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
        structlog.processors.UnicodeDecoder(),
        structlog.processors.JSONRenderer(),
    ],
    wrapper_class=structlog.stdlib.BoundLogger,
    context_class=dict,
    logger_factory=structlog.stdlib.LoggerFactory(),
    cache_logger_on_first_use=True,
)
logger = structlog.get_logger(__name__)

# ── Prometheus metrics ────────────────────────────────────────────────────────
REQUEST_COUNT = Counter("http_requests_total", "Total HTTP requests", ["method", "endpoint", "status"])
REQUEST_LATENCY = Histogram("http_request_duration_seconds", "HTTP request latency", ["method", "endpoint"])


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup/shutdown lifecycle."""
    logger.info("Starting SpendWise API", version=settings.VERSION, env=settings.ENVIRONMENT)
    async with engine.begin() as conn:
        await conn.run_sync(lambda conn: Base.metadata.create_all(conn, checkfirst=True))
    await start_scheduler()
    yield
    await stop_scheduler()
    logger.info("SpendWise API shutdown complete")


# ── Application factory ───────────────────────────────────────────────────────
def create_app() -> FastAPI:
    app = FastAPI(
        title="SpendWise API",
        description="Production-grade expense tracker with offline-first sync",
        version=settings.VERSION,
        docs_url="/api/docs" if settings.ENVIRONMENT != "production" else None,
        redoc_url="/api/redoc" if settings.ENVIRONMENT != "production" else None,
        lifespan=lifespan,
    )

    # ── Middleware ─────────────────────────────────────────────────────────────
    app.add_middleware(GZipMiddleware, minimum_size=1000)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.ALLOWED_ORIGINS,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def observability_middleware(request: Request, call_next):
        start = time.perf_counter()
        response = await call_next(request)
        duration = time.perf_counter() - start
        endpoint = request.url.path
        REQUEST_COUNT.labels(request.method, endpoint, response.status_code).inc()
        REQUEST_LATENCY.labels(request.method, endpoint).observe(duration)
        response.headers["X-Request-ID"] = request.headers.get("X-Request-ID", "")
        response.headers["X-Response-Time"] = f"{duration:.4f}s"
        return response

    @app.middleware("http")
    async def security_headers_middleware(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response

    # ── Exception handlers ─────────────────────────────────────────────────────
    @app.exception_handler(AppException)
    async def app_exception_handler(request: Request, exc: AppException):
        logger.warning("App exception", error=exc.message, code=exc.code, path=request.url.path)
        return JSONResponse(status_code=exc.status_code, content={"error": exc.message, "code": exc.code})

    @app.exception_handler(Exception)
    async def generic_exception_handler(request: Request, exc: Exception):
        logger.error("Unhandled exception", exc_info=exc, path=request.url.path)
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"error": "Internal server error", "code": "INTERNAL_ERROR"},
        )

    # ── Routes ─────────────────────────────────────────────────────────────────
    prefix = "/api/v1"
    app.include_router(auth.router,          prefix=f"{prefix}/auth",          tags=["Auth"])
    app.include_router(users.router,         prefix=f"{prefix}/users",         tags=["Users"])
    app.include_router(expenses.router,      prefix=f"{prefix}/expenses",      tags=["Expenses"])
    app.include_router(categories.router,    prefix=f"{prefix}/categories",    tags=["Categories"])
    app.include_router(tags.router,          prefix=f"{prefix}/tags",          tags=["Tags"])
    app.include_router(budgets.router,       prefix=f"{prefix}/budgets",       tags=["Budgets"])
    app.include_router(wallets.router,       prefix=f"{prefix}/wallets",       tags=["Wallets"])
    app.include_router(receipts.router,      prefix=f"{prefix}/receipts",      tags=["Receipts"])
    app.include_router(reports.router,       prefix=f"{prefix}/reports",       tags=["Reports"])
    app.include_router(exports.router,       prefix=f"{prefix}/exports",       tags=["Exports"])
    app.include_router(notifications.router, prefix=f"{prefix}/notifications", tags=["Notifications"])
    app.include_router(sync.router,          prefix=f"{prefix}/sync",          tags=["Sync"])

    # Prometheus metrics endpoint
    metrics_app = make_asgi_app()
    app.mount("/metrics", metrics_app)

    @app.get("/health", tags=["Health"])
    async def health():
        return {"status": "ok", "version": settings.VERSION}

    return app


app = create_app()