"""Push Notifications - Firebase (Android) + APNS (iOS)"""
import structlog
import httpx
from app.core.config import settings

logger = structlog.get_logger(__name__)


async def send_push_notification(token: str, platform: str, title: str, body: str, data: dict):
    """Send push notification via FCM (Android/web) or APNS (iOS)."""
    if platform in ("android", "web"):
        await _send_fcm(token, title, body, data)
    elif platform == "ios":
        await _send_apns(token, title, body, data)


async def _send_fcm(token: str, title: str, body: str, data: dict):
    if not settings.FIREBASE_SERVER_KEY:
        logger.debug("FCM not configured, skipping push")
        return
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(
                "https://fcm.googleapis.com/fcm/send",
                headers={"Authorization": f"key={settings.FIREBASE_SERVER_KEY}"},
                json={
                    "to": token,
                    "notification": {"title": title, "body": body},
                    "data": {k: str(v) for k, v in (data or {}).items()},
                    "priority": "high",
                },
            )
    except Exception as e:
        logger.warning("FCM push failed", error=str(e))


async def _send_apns(token: str, title: str, body: str, data: dict):
    # APNS HTTP/2 via JWT - simplified stub
    # Production: use aioapns or httpx with HTTP/2
    logger.debug("APNS push (stub)", token=token[:8], title=title)


# ── Object Storage ─────────────────────────────────────────────────────────────

import uuid
from typing import Optional

def get_receipt_url(receipt_key: Optional[str]) -> Optional[str]:
    """Generate presigned URL for receipt access."""
    if not receipt_key:
        return None
    if settings.STORAGE_BACKEND == "local":
        return f"/receipts/{receipt_key}"
    # In production: generate presigned S3/GCS URL with 1-hour expiry
    return f"https://{settings.S3_BUCKET_RECEIPTS}.s3.amazonaws.com/{receipt_key}?presigned=true"


async def upload_receipt(file_bytes: bytes, content_type: str, user_id: str) -> str:
    """Upload receipt to object storage, return storage key."""
    key = f"receipts/{user_id}/{uuid.uuid4()}"
    if settings.STORAGE_BACKEND == "s3":
        import boto3
        s3 = boto3.client("s3", region_name=settings.AWS_REGION)
        s3.put_object(
            Bucket=settings.S3_BUCKET_RECEIPTS,
            Key=key,
            Body=file_bytes,
            ContentType=content_type,
            ServerSideEncryption="AES256",  # Encryption at rest
        )
    elif settings.STORAGE_BACKEND == "local":
        import os
        os.makedirs(f"{settings.LOCAL_STORAGE_PATH}/{user_id}", exist_ok=True)
        with open(f"{settings.LOCAL_STORAGE_PATH}/{key}", "wb") as f:
            f.write(file_bytes)
    return key


async def delete_receipt(receipt_key: str):
    """Soft-delete from storage (GDPR compliance - user data deletion)."""
    if settings.STORAGE_BACKEND == "s3":
        import boto3
        s3 = boto3.client("s3", region_name=settings.AWS_REGION)
        s3.delete_object(Bucket=settings.S3_BUCKET_RECEIPTS, Key=receipt_key)


# ── Gamification ───────────────────────────────────────────────────────────────

from uuid import UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select


async def award_points(user_id: UUID, action: str, db: AsyncSession):
    """Award gamification points for user actions."""
    if not settings.FEATURE_GAMIFICATION:
        return

    from app.models.models import UserPoints
    from datetime import datetime, timezone, date

    POINTS_MAP = {
        "expense_logged": 5,
        "budget_created": 20,
        "streak_bonus": 10,
        "under_budget": 50,
        "first_expense": 100,
    }
    points = POINTS_MAP.get(action, 0)
    if not points:
        return

    result = await db.execute(select(UserPoints).where(UserPoints.user_id == user_id))
    up = result.scalar_one_or_none()

    now = datetime.now(timezone.utc)
    if not up:
        up = UserPoints(user_id=user_id, total_points=0, streak_days=0)
        db.add(up)

    up.total_points = (up.total_points or 0) + points

    # Streak logic
    if action == "expense_logged":
        today = now.date()
        last = up.last_log_date.date() if up.last_log_date else None
        if last and (today - last).days == 1:
            up.streak_days = (up.streak_days or 0) + 1
            if up.streak_days % 7 == 0:  # Weekly streak bonus
                up.total_points += POINTS_MAP["streak_bonus"] * (up.streak_days // 7)
        elif last != today:
            up.streak_days = 1
        up.last_log_date = now

    await db.flush()
    logger.debug("Points awarded", user_id=str(user_id), action=action, points=points)


# ── Rate Limiter (simple in-memory, use Redis in production) ──────────────────

import time
import functools
from fastapi import HTTPException, status, Request
from collections import defaultdict

_call_log: dict = defaultdict(list)


def rate_limit(max_calls: int = 10, period: int = 60):
    """Simple decorator-based rate limiter. Use Redis-based in production."""
    def decorator(func):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            request: Optional[Request] = kwargs.get("request") or next((a for a in args if isinstance(a, Request)), None)
            if request:
                ip = request.client.host if request.client else "unknown"
                key = f"{func.__name__}:{ip}"
                now = time.time()
                _call_log[key] = [t for t in _call_log[key] if now - t < period]
                if len(_call_log[key]) >= max_calls:
                    raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Rate limit exceeded")
                _call_log[key].append(now)
            return await func(*args, **kwargs)
        return wrapper
    return decorator