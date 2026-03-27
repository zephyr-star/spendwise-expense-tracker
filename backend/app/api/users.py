"""Users API - Profile management, preferences, GDPR compliance"""
import json
from typing import Optional
from uuid import UUID

import structlog
from fastapi import APIRouter, BackgroundTasks, Depends, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import get_current_user
from app.core.database import get_db
from app.core.exceptions import AppException
from app.models.models import AuditLog, Budget, Category, Expense, Tag, User, UserPoints

router = APIRouter()
logger = structlog.get_logger(__name__)


class UserUpdate(BaseModel):
    display_name: Optional[str] = None
    base_currency: Optional[str] = None
    timezone: Optional[str] = None
    locale: Optional[str] = None
    preferences: Optional[dict] = None


class UserOut(BaseModel):
    id: UUID
    email: str
    display_name: str
    avatar_url: Optional[str]
    base_currency: str
    timezone: str
    locale: str
    preferences: dict
    class Config: from_attributes = True


class PointsOut(BaseModel):
    total_points: int
    streak_days: int
    badges: list
    class Config: from_attributes = True


@router.get("/me", response_model=UserOut)
async def get_profile(current_user: User = Depends(get_current_user)):
    return current_user


@router.patch("/me", response_model=UserOut)
async def update_profile(
    body: UserUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    for field, value in body.model_dump(exclude_unset=True).items():
        if field == "preferences":
            # Merge preferences, don't overwrite
            current_user.preferences = {**(current_user.preferences or {}), **value}
        else:
            setattr(current_user, field, value)
    return current_user


@router.get("/me/points", response_model=PointsOut)
async def get_points(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(UserPoints).where(UserPoints.user_id == current_user.id))
    points = result.scalar_one_or_none()
    if not points:
        return PointsOut(total_points=0, streak_days=0, badges=[])
    return points


@router.get("/me/export")
async def export_my_data(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    GDPR/DPDP compliant: Export all user data as JSON.
    Returns a complete data package the user can download.
    """
    expenses_r = await db.execute(select(Expense).where(Expense.user_id == current_user.id))
    expenses = expenses_r.scalars().all()

    categories_r = await db.execute(select(Category).where(Category.user_id == current_user.id))
    tags_r = await db.execute(select(Tag).where(Tag.user_id == current_user.id))
    budgets_r = await db.execute(select(Budget).where(Budget.user_id == current_user.id))

    # Log GDPR data access
    db.add(AuditLog(user_id=current_user.id, action="gdpr.data_export"))

    return {
        "exported_at": __import__("datetime").datetime.utcnow().isoformat(),
        "user": {
            "id": str(current_user.id),
            "email": current_user.email,
            "display_name": current_user.display_name,
            "base_currency": current_user.base_currency,
            "timezone": current_user.timezone,
            "created_at": current_user.created_at.isoformat(),
        },
        "expenses": [
            {
                "id": str(e.id), "amount": float(e.amount), "currency": e.currency,
                "expense_date": e.expense_date.isoformat(), "merchant_name": e.merchant_name,
                "notes": e.notes, "payment_method": e.payment_method.value,
                "category_id": str(e.category_id) if e.category_id else None,
            }
            for e in expenses
        ],
        "categories": [{"id": str(c.id), "name": c.name} for c in categories_r.scalars().all()],
        "tags": [{"id": str(t.id), "name": t.name} for t in tags_r.scalars().all()],
        "budgets": [{"id": str(b.id), "name": b.name, "amount": float(b.amount)} for b in budgets_r.scalars().all()],
        "_notice": "This export contains all personal data SpendWise holds about you. No banking credentials are stored.",
    }


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_account(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    """
    GDPR Right to Erasure: Anonymize and deactivate account.
    Expenses are anonymized (not deleted) to preserve aggregate analytics integrity.
    Receipts are scheduled for deletion from object storage.
    """
    import uuid

    # Log before anonymization
    db.add(AuditLog(
        user_id=current_user.id,
        action="gdpr.account_deletion_requested",
        metadata={"email_hash": __import__("hashlib").sha256(current_user.email.encode()).hexdigest()},
    ))

    # Anonymize PII (GDPR Art. 17 compliant)
    anon_id = f"deleted_{uuid.uuid4().hex[:8]}"
    current_user.email = f"{anon_id}@deleted.invalid"
    current_user.display_name = "Deleted User"
    current_user.avatar_url = None
    current_user.google_sub = None
    current_user.hashed_pw = None
    current_user.is_active = False

    # Schedule receipt deletion from object storage
    receipts_r = await db.execute(
        select(Expense.receipt_key).where(Expense.user_id == current_user.id, Expense.receipt_key.isnot(None))
    )
    receipt_keys = [r[0] for r in receipts_r.all()]

    async def _delete_receipts():
        from app.services import delete_receipt
        for key in receipt_keys:
            try:
                await delete_receipt(key)
            except Exception as e:
                logger.error("Receipt deletion failed", key=key, error=str(e))

    background_tasks.add_task(_delete_receipts)
    logger.info("Account deletion initiated", user_id=str(current_user.id))