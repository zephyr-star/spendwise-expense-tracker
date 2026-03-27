"""
Authentication API - JWT + Google OAuth
Endpoints: register, login, refresh, logout, google-oauth, me
"""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import structlog
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.exceptions import AppException
from app.models.models import AuditLog, RefreshToken, User
from app.services.rate_limiter import rate_limit

logger = structlog.get_logger(__name__)
router = APIRouter()
pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")


# ── Schemas ───────────────────────────────────────────────────────────────────

class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    display_name: str


class LoginResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class RefreshRequest(BaseModel):
    refresh_token: str


class GoogleAuthRequest(BaseModel):
    id_token: str
    device_id: Optional[str] = None


class UserOut(BaseModel):
    id: str
    email: str
    display_name: str
    avatar_url: Optional[str]
    base_currency: str
    timezone: str
    preferences: dict

    class Config:
        from_attributes = True


# ── Token helpers ─────────────────────────────────────────────────────────────

def create_access_token(user_id: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    return jwt.encode({"sub": user_id, "exp": exp, "type": "access"}, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)


def create_refresh_token() -> tuple[str, str]:
    """Returns (raw_token, hashed_token)."""
    raw = secrets.token_urlsafe(64)
    hashed = hashlib.sha256(raw.encode()).hexdigest()
    return raw, hashed


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    try:
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
        if payload.get("type") != "access":
            raise AppException("Invalid token type", "INVALID_TOKEN", status.HTTP_401_UNAUTHORIZED)
        user_id: str = payload.get("sub")
        if not user_id:
            raise AppException("Invalid token", "INVALID_TOKEN", status.HTTP_401_UNAUTHORIZED)
    except JWTError:
        raise AppException("Invalid or expired token", "INVALID_TOKEN", status.HTTP_401_UNAUTHORIZED)

    result = await db.execute(select(User).where(User.id == user_id, User.is_active == True))
    user = result.scalar_one_or_none()
    if not user:
        raise AppException("User not found", "USER_NOT_FOUND", status.HTTP_401_UNAUTHORIZED)
    return user


async def _issue_tokens(user: User, device_id: Optional[str], db: AsyncSession) -> LoginResponse:
    access = create_access_token(str(user.id))
    raw_refresh, hashed_refresh = create_refresh_token()
    exp = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)

    db.add(RefreshToken(
        user_id=user.id,
        token_hash=hashed_refresh,
        device_id=device_id,
        expires_at=exp,
    ))
    user.last_login_at = datetime.now(timezone.utc)
    await db.flush()

    return LoginResponse(
        access_token=access,
        refresh_token=raw_refresh,
        expires_in=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/register", response_model=LoginResponse, status_code=status.HTTP_201_CREATED)
@rate_limit(max_calls=5, period=60)
async def register(body: RegisterRequest, request: Request, db: AsyncSession = Depends(get_db)):
    """Register with email + password."""
    if len(body.password) < 8:
        raise AppException("Password must be at least 8 characters", "WEAK_PASSWORD")

    existing = await db.execute(select(User).where(User.email == body.email))
    if existing.scalar_one_or_none():
        raise AppException("Email already registered", "EMAIL_EXISTS", status.HTTP_409_CONFLICT)

    user = User(
        email=body.email,
        display_name=body.display_name,
        hashed_pw=pwd_ctx.hash(body.password),
        preferences={},
    )
    db.add(user)
    await db.flush()

    db.add(AuditLog(user_id=user.id, action="user.register", ip_address=request.client.host))
    logger.info("User registered", user_id=str(user.id))
    return await _issue_tokens(user, None, db)


@router.post("/login", response_model=LoginResponse)
@rate_limit(max_calls=10, period=60)
async def login(
    form: OAuth2PasswordRequestForm = Depends(),
    request: Request = None,
    db: AsyncSession = Depends(get_db),
):
    """Email + password login."""
    result = await db.execute(select(User).where(User.email == form.username, User.is_active == True))
    user = result.scalar_one_or_none()
    if not user or not user.hashed_pw or not pwd_ctx.verify(form.password, user.hashed_pw):
        raise AppException("Invalid credentials", "INVALID_CREDENTIALS", status.HTTP_401_UNAUTHORIZED)

    db.add(AuditLog(user_id=user.id, action="user.login", ip_address=request.client.host if request else None))
    return await _issue_tokens(user, None, db)


@router.post("/google", response_model=LoginResponse)
@rate_limit(max_calls=10, period=60)
async def google_oauth(body: GoogleAuthRequest, request: Request, db: AsyncSession = Depends(get_db)):
    """Google OAuth - verify ID token, upsert user."""
    try:
        info = id_token.verify_oauth2_token(body.id_token, google_requests.Request(), settings.GOOGLE_CLIENT_ID)
    except ValueError as e:
        raise AppException(f"Invalid Google token: {e}", "INVALID_GOOGLE_TOKEN", status.HTTP_401_UNAUTHORIZED)

    email = info["email"]
    google_sub = info["sub"]

    result = await db.execute(select(User).where(User.google_sub == google_sub))
    user = result.scalar_one_or_none()

    if not user:
        # Check by email (link accounts)
        result2 = await db.execute(select(User).where(User.email == email))
        user = result2.scalar_one_or_none()
        if user:
            user.google_sub = google_sub
        else:
            user = User(
                email=email,
                display_name=info.get("name", email.split("@")[0]),
                avatar_url=info.get("picture"),
                google_sub=google_sub,
                is_verified=True,
                preferences={},
            )
            db.add(user)
            await db.flush()

    db.add(AuditLog(user_id=user.id, action="user.google_login", ip_address=request.client.host))
    return await _issue_tokens(user, body.device_id, db)


@router.post("/refresh", response_model=LoginResponse)
async def refresh(body: RefreshRequest, db: AsyncSession = Depends(get_db)):
    """Rotate refresh token."""
    hashed = hashlib.sha256(body.refresh_token.encode()).hexdigest()
    result = await db.execute(
        select(RefreshToken).where(
            RefreshToken.token_hash == hashed,
            RefreshToken.revoked == False,
            RefreshToken.expires_at > datetime.now(timezone.utc),
        )
    )
    token = result.scalar_one_or_none()
    if not token:
        raise AppException("Invalid or expired refresh token", "INVALID_REFRESH_TOKEN", status.HTTP_401_UNAUTHORIZED)

    token.revoked = True  # Rotate: revoke old
    user_result = await db.execute(select(User).where(User.id == token.user_id))
    user = user_result.scalar_one()
    return await _issue_tokens(user, token.device_id, db)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(body: RefreshRequest, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Revoke refresh token."""
    hashed = hashlib.sha256(body.refresh_token.encode()).hexdigest()
    result = await db.execute(select(RefreshToken).where(RefreshToken.token_hash == hashed, RefreshToken.user_id == current_user.id))
    token = result.scalar_one_or_none()
    if token:
        token.revoked = True


@router.get("/me", response_model=UserOut)
async def me(current_user: User = Depends(get_current_user)):
    return current_user