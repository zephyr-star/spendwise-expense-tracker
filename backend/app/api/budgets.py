"""Budgets API - CRUD + live spent calculation"""
from datetime import datetime
from decimal import Decimal
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import get_current_user
from app.core.database import get_db
from app.core.exceptions import AppException
from app.models.models import Budget, Expense, User

router = APIRouter()


class BudgetCreate(BaseModel):
    name: str = Field(..., max_length=100)
    amount: Decimal = Field(..., gt=0)
    currency: str = Field(..., min_length=3, max_length=3)
    category_id: Optional[UUID] = None
    wallet_id: Optional[UUID] = None
    period_start: datetime
    period_end: datetime
    alert_at_pct: int = Field(default=80, ge=1, le=100)
    is_recurring: bool = False
    recurrence: Optional[str] = None


class BudgetOut(BaseModel):
    id: UUID
    name: str
    amount: Decimal
    currency: str
    category_id: Optional[UUID]
    wallet_id: Optional[UUID]
    period_start: datetime
    period_end: datetime
    alert_at_pct: int
    is_recurring: bool
    is_active: bool
    spent: float = 0.0
    remaining: float = 0.0
    pct_used: float = 0.0

    class Config:
        from_attributes = True


async def _calc_spent(budget: Budget, user_id: UUID, db: AsyncSession) -> Decimal:
    conditions = [
        Expense.user_id == user_id,
        Expense.is_deleted == False,
        Expense.expense_date >= budget.period_start,
        Expense.expense_date <= budget.period_end,
    ]
    if budget.category_id:
        conditions.append(Expense.category_id == budget.category_id)
    if budget.wallet_id:
        conditions.append(Expense.wallet_id == budget.wallet_id)
    result = await db.execute(select(func.sum(Expense.base_amount)).where(and_(*conditions)))
    return result.scalar() or Decimal("0")


def _build_out(budget: Budget, spent: Decimal) -> BudgetOut:
    pct = float(spent / budget.amount * 100) if budget.amount else 0
    return BudgetOut(
        id=budget.id, name=budget.name, amount=budget.amount,
        currency=budget.currency, category_id=budget.category_id,
        wallet_id=budget.wallet_id, period_start=budget.period_start,
        period_end=budget.period_end, alert_at_pct=budget.alert_at_pct,
        is_recurring=budget.is_recurring, is_active=budget.is_active,
        spent=float(spent),
        remaining=float(budget.amount - spent),
        pct_used=round(pct, 2),
    )


@router.get("", response_model=List[BudgetOut])
async def list_budgets(
    active_only: bool = True,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = select(Budget).where(Budget.user_id == current_user.id)
    if active_only:
        q = q.where(Budget.is_active == True)
    result = await db.execute(q.order_by(Budget.period_start.desc()))
    budgets = result.scalars().all()
    out = []
    for b in budgets:
        spent = await _calc_spent(b, current_user.id, db)
        out.append(_build_out(b, spent))
    return out


@router.post("", response_model=BudgetOut, status_code=status.HTTP_201_CREATED)
async def create_budget(
    body: BudgetCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.period_end <= body.period_start:
        raise AppException("period_end must be after period_start", "INVALID_PERIOD")
    budget = Budget(user_id=current_user.id, **body.model_dump())
    db.add(budget)
    await db.flush()
    return _build_out(budget, Decimal("0"))


@router.delete("/{budget_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_budget(
    budget_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Budget).where(Budget.id == budget_id, Budget.user_id == current_user.id))
    b = result.scalar_one_or_none()
    if not b:
        raise AppException("Budget not found", "NOT_FOUND", status.HTTP_404_NOT_FOUND)
    b.is_active = False  # soft deactivate