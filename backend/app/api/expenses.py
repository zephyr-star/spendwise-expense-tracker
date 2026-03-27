"""
Expenses API - Full CRUD + Advanced Search + Filtering
"""
from datetime import datetime
from decimal import Decimal
from typing import List, Optional
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field, validator
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.auth import get_current_user
from app.core.database import get_db
from app.core.exceptions import AppException
from app.models.models import (
    Budget, Category, Expense, ExpenseTag, PaymentMethod,
    SyncLog, SyncOperation, Tag, User, WalletUser
)
from app.services.currency import convert_currency
from app.services import award_points
from app.services.ml_categorizer import suggest_category_and_tags
from app.services import delete_receipt, get_receipt_url

logger = structlog.get_logger(__name__)
router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

class ExpenseCreate(BaseModel):
    amount: Decimal = Field(..., gt=0, max_digits=15, decimal_places=4)
    currency: str = Field(..., min_length=3, max_length=3)
    category_id: Optional[UUID] = None
    wallet_id: Optional[UUID] = None
    expense_date: datetime
    merchant_name: Optional[str] = Field(None, max_length=200)
    notes: Optional[str] = Field(None, max_length=2000)
    payment_method: PaymentMethod = PaymentMethod.OTHER
    location_name: Optional[str] = Field(None, max_length=300)
    location_lat: Optional[float] = None
    location_lng: Optional[float] = None
    tag_ids: List[UUID] = []
    recurring_rule_id: Optional[UUID] = None
    split_data: Optional[dict] = None
    client_id: Optional[str] = None  # idempotency key

    @validator("currency")
    def uppercase_currency(cls, v):
        return v.upper()


class ExpenseUpdate(BaseModel):
    amount: Optional[Decimal] = Field(None, gt=0)
    currency: Optional[str] = Field(None, min_length=3, max_length=3)
    category_id: Optional[UUID] = None
    expense_date: Optional[datetime] = None
    merchant_name: Optional[str] = None
    notes: Optional[str] = None
    payment_method: Optional[PaymentMethod] = None
    location_name: Optional[str] = None
    tag_ids: Optional[List[UUID]] = None


class ExpenseOut(BaseModel):
    id: UUID
    amount: Decimal
    currency: str
    base_amount: Decimal
    exchange_rate: Decimal
    category_id: Optional[UUID]
    wallet_id: Optional[UUID]
    expense_date: datetime
    merchant_name: Optional[str]
    notes: Optional[str]
    payment_method: PaymentMethod
    location_name: Optional[str]
    location_lat: Optional[float]
    location_lng: Optional[float]
    receipt_url: Optional[str]
    is_split: bool
    split_data: Optional[dict]
    tag_ids: List[UUID]
    ml_category_confidence: Optional[float]
    ml_suggested_tags: Optional[list]
    recurring_rule_id: Optional[UUID]
    client_id: Optional[str]
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ExpenseListResponse(BaseModel):
    items: List[ExpenseOut]
    total: int
    page: int
    page_size: int
    total_pages: int


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _check_wallet_access(wallet_id: UUID, user_id: UUID, db: AsyncSession, require_write: bool = True):
    result = await db.execute(
        select(WalletUser).where(WalletUser.wallet_id == wallet_id, WalletUser.user_id == user_id)
    )
    wu = result.scalar_one_or_none()
    if not wu:
        raise AppException("Wallet not found or access denied", "WALLET_ACCESS_DENIED", status.HTTP_403_FORBIDDEN)
    if require_write and wu.role.value == "viewer":
        raise AppException("Insufficient wallet permissions", "INSUFFICIENT_PERMISSIONS", status.HTTP_403_FORBIDDEN)
    return wu


async def _record_sync(expense: Expense, operation: SyncOperation, db: AsyncSession):
    """Write to sync_log for delta sync support."""
    result = await db.execute(
        select(func.coalesce(func.max(SyncLog.sequence), 0)).where(SyncLog.user_id == expense.user_id)
    )
    next_seq = (result.scalar() or 0) + 1
    db.add(SyncLog(
        user_id=expense.user_id,
        entity_type="expense",
        entity_id=expense.id,
        operation=operation,
        payload={"id": str(expense.id), "updated_at": expense.updated_at.isoformat()},
        sequence=next_seq,
        client_id=expense.client_id,
    ))


def _build_expense_out(expense: Expense) -> ExpenseOut:
    return ExpenseOut(
        **{k: v for k, v in expense.__dict__.items() if k in ExpenseOut.model_fields},
        tag_ids=[t.id for t in (expense.tags or [])],
        receipt_url=get_receipt_url(expense.receipt_key) if expense.receipt_key else None,
    )


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("", response_model=ExpenseOut, status_code=status.HTTP_201_CREATED)
async def create_expense(
    body: ExpenseCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Idempotency: check client_id
    if body.client_id:
        result = await db.execute(
            select(Expense).where(Expense.user_id == current_user.id, Expense.client_id == body.client_id)
        )
        existing = result.scalar_one_or_none()
        if existing:
            await db.refresh(existing, ["tags"])
            return _build_expense_out(existing)

    # Wallet access check
    if body.wallet_id:
        await _check_wallet_access(body.wallet_id, current_user.id, db)

    # Currency conversion
    base_amount, exchange_rate = await convert_currency(
        body.amount, body.currency, current_user.base_currency
    )

    # ML suggestions (non-blocking)
    ml_category_id = None
    ml_confidence = None
    ml_tags = None
    if not body.category_id:
        suggestion = await suggest_category_and_tags(
            merchant=body.merchant_name, notes=body.notes, user_id=current_user.id, db=db
        )
        if suggestion:
            ml_category_id = suggestion.get("category_id")
            ml_confidence = suggestion.get("confidence")
            ml_tags = suggestion.get("tags")

    expense = Expense(
        user_id=current_user.id,
        wallet_id=body.wallet_id,
        category_id=body.category_id or ml_category_id,
        recurring_rule_id=body.recurring_rule_id,
        amount=body.amount,
        currency=body.currency,
        base_amount=base_amount,
        exchange_rate=exchange_rate,
        expense_date=body.expense_date,
        merchant_name=body.merchant_name,
        notes=body.notes,
        payment_method=body.payment_method,
        location_name=body.location_name,
        location_lat=body.location_lat,
        location_lng=body.location_lng,
        is_split=bool(body.split_data),
        split_data=body.split_data,
        ml_category_confidence=ml_confidence,
        ml_suggested_tags=ml_tags,
        client_id=body.client_id,
    )
    db.add(expense)
    await db.flush()

    # Tags
    if body.tag_ids:
        result = await db.execute(select(Tag).where(Tag.id.in_(body.tag_ids), Tag.user_id == current_user.id))
        tags = result.scalars().all()
        expense.tags = list(tags)

    await _record_sync(expense, SyncOperation.CREATE, db)
    await award_points(current_user.id, "expense_logged", db)

    logger.info("Expense created", expense_id=str(expense.id), user_id=str(current_user.id), amount=str(body.amount))
    return _build_expense_out(expense)


@router.get("", response_model=ExpenseListResponse)
async def list_expenses(
    # Filters
    category_id: Optional[UUID] = None,
    wallet_id: Optional[UUID] = None,
    tag_ids: Optional[str] = Query(None, description="Comma-separated tag UUIDs"),
    merchant: Optional[str] = Query(None, description="Merchant name search (partial)"),
    payment_method: Optional[PaymentMethod] = None,
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    currency: Optional[str] = None,
    is_recurring: Optional[bool] = None,
    min_amount: Optional[Decimal] = None,
    max_amount: Optional[Decimal] = None,
    search: Optional[str] = Query(None, description="Full-text search notes + merchant"),
    is_deleted: bool = False,
    # Pagination + sorting
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    sort_by: str = Query("expense_date", regex="^(expense_date|amount|created_at|merchant_name)$"),
    sort_dir: str = Query("desc", regex="^(asc|desc)$"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    conditions = [Expense.user_id == current_user.id, Expense.is_deleted == is_deleted]

    if category_id:
        conditions.append(Expense.category_id == category_id)
    if wallet_id:
        await _check_wallet_access(wallet_id, current_user.id, db, require_write=False)
        conditions.append(Expense.wallet_id == wallet_id)
    if payment_method:
        conditions.append(Expense.payment_method == payment_method)
    if date_from:
        conditions.append(Expense.expense_date >= date_from)
    if date_to:
        conditions.append(Expense.expense_date <= date_to)
    if currency:
        conditions.append(Expense.currency == currency.upper())
    if is_recurring is not None:
        if is_recurring:
            conditions.append(Expense.recurring_rule_id.isnot(None))
        else:
            conditions.append(Expense.recurring_rule_id.is_(None))
    if min_amount is not None:
        conditions.append(Expense.base_amount >= min_amount)
    if max_amount is not None:
        conditions.append(Expense.base_amount <= max_amount)
    if merchant:
        conditions.append(Expense.merchant_name.ilike(f"%{merchant}%"))
    if search:
        conditions.append(or_(
            Expense.merchant_name.ilike(f"%{search}%"),
            Expense.notes.ilike(f"%{search}%"),
        ))

    # Tag filter (subquery join)
    if tag_ids:
        parsed_tags = [UUID(t.strip()) for t in tag_ids.split(",") if t.strip()]
        if parsed_tags:
            tag_subq = (
                select(ExpenseTag.expense_id)
                .where(ExpenseTag.tag_id.in_(parsed_tags))
                .group_by(ExpenseTag.expense_id)
                .having(func.count(ExpenseTag.tag_id) == len(parsed_tags))
                .scalar_subquery()
            )
            conditions.append(Expense.id.in_(tag_subq))

    # Count
    count_q = select(func.count()).select_from(Expense).where(and_(*conditions))
    total = (await db.execute(count_q)).scalar()

    # Data
    sort_col = getattr(Expense, sort_by)
    order = sort_col.desc() if sort_dir == "desc" else sort_col.asc()
    offset = (page - 1) * page_size

    result = await db.execute(
        select(Expense)
        .options(selectinload(Expense.tags))
        .where(and_(*conditions))
        .order_by(order)
        .offset(offset)
        .limit(page_size)
    )
    expenses = result.scalars().all()

    return ExpenseListResponse(
        items=[_build_expense_out(e) for e in expenses],
        total=total,
        page=page,
        page_size=page_size,
        total_pages=max(1, -(-total // page_size)),  # ceiling division
    )


@router.get("/{expense_id}", response_model=ExpenseOut)
async def get_expense(
    expense_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Expense)
        .options(selectinload(Expense.tags))
        .where(Expense.id == expense_id, Expense.user_id == current_user.id, Expense.is_deleted == False)
    )
    expense = result.scalar_one_or_none()
    if not expense:
        raise AppException("Expense not found", "EXPENSE_NOT_FOUND", status.HTTP_404_NOT_FOUND)
    return _build_expense_out(expense)


@router.patch("/{expense_id}", response_model=ExpenseOut)
async def update_expense(
    expense_id: UUID,
    body: ExpenseUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Expense)
        .options(selectinload(Expense.tags))
        .where(Expense.id == expense_id, Expense.user_id == current_user.id, Expense.is_deleted == False)
    )
    expense = result.scalar_one_or_none()
    if not expense:
        raise AppException("Expense not found", "EXPENSE_NOT_FOUND", status.HTTP_404_NOT_FOUND)

    update_data = body.model_dump(exclude_unset=True)

    if "tag_ids" in update_data:
        tag_ids = update_data.pop("tag_ids")
        tag_result = await db.execute(select(Tag).where(Tag.id.in_(tag_ids), Tag.user_id == current_user.id))
        expense.tags = list(tag_result.scalars().all())

    # Re-convert if amount/currency changes
    amount_changed = "amount" in update_data or "currency" in update_data
    for field, val in update_data.items():
        setattr(expense, field, val)

    if amount_changed:
        expense.base_amount, expense.exchange_rate = await convert_currency(
            expense.amount, expense.currency, current_user.base_currency
        )

    await _record_sync(expense, SyncOperation.UPDATE, db)
    return _build_expense_out(expense)


@router.delete("/{expense_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_expense(
    expense_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Expense).where(Expense.id == expense_id, Expense.user_id == current_user.id)
    )
    expense = result.scalar_one_or_none()
    if not expense:
        raise AppException("Expense not found", "EXPENSE_NOT_FOUND", status.HTTP_404_NOT_FOUND)

    expense.is_deleted = True  # Soft delete for sync consistency
    if expense.receipt_key:
        await delete_receipt(expense.receipt_key)

    await _record_sync(expense, SyncOperation.DELETE, db)
    logger.info("Expense deleted", expense_id=str(expense_id), user_id=str(current_user.id))


@router.get("/stats/summary")
async def expense_summary(
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    wallet_id: Optional[UUID] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Dashboard summary: total, by-category breakdown, trend data."""
    conditions = [Expense.user_id == current_user.id, Expense.is_deleted == False]
    if date_from:
        conditions.append(Expense.expense_date >= date_from)
    if date_to:
        conditions.append(Expense.expense_date <= date_to)
    if wallet_id:
        conditions.append(Expense.wallet_id == wallet_id)

    # Total spend
    total_q = select(func.sum(Expense.base_amount)).where(and_(*conditions))
    total = (await db.execute(total_q)).scalar() or Decimal("0")

    # By category
    cat_q = (
        select(Expense.category_id, func.sum(Expense.base_amount).label("total"), func.count().label("count"))
        .where(and_(*conditions))
        .group_by(Expense.category_id)
        .order_by(func.sum(Expense.base_amount).desc())
    )
    cat_rows = (await db.execute(cat_q)).all()

    # Monthly trend (last 12 months)
    trend_q = (
        select(
            func.date_trunc("month", Expense.expense_date).label("month"),
            func.sum(Expense.base_amount).label("total"),
        )
        .where(and_(*conditions))
        .group_by(func.date_trunc("month", Expense.expense_date))
        .order_by(func.date_trunc("month", Expense.expense_date))
    )
    trend_rows = (await db.execute(trend_q)).all()

    return {
        "total": float(total),
        "currency": current_user.base_currency,
        "by_category": [
            {"category_id": str(r.category_id) if r.category_id else None, "total": float(r.total), "count": r.count}
            for r in cat_rows
        ],
        "monthly_trend": [
            {"month": r.month.isoformat(), "total": float(r.total)}
            for r in trend_rows
        ],
    }