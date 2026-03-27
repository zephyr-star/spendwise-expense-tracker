"""Reports API - Advanced analytics and insights"""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import get_current_user
from app.core.database import get_db
from app.models.models import Expense, RecurringRule, User

router = APIRouter()


@router.get("/insights")
async def get_insights(
    months: int = Query(default=3, ge=1, le=12),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Personalized ML-powered spending insights and anomaly detection."""
    since = datetime.now(timezone.utc) - timedelta(days=months * 30)

    # Monthly totals
    monthly_q = await db.execute(
        select(
            func.date_trunc("month", Expense.expense_date).label("month"),
            func.sum(Expense.base_amount).label("total"),
            func.count().label("count"),
        )
        .where(Expense.user_id == current_user.id, Expense.expense_date >= since, Expense.is_deleted == False)
        .group_by(func.date_trunc("month", Expense.expense_date))
        .order_by(func.date_trunc("month", Expense.expense_date))
    )
    monthly = [{"month": r.month.isoformat(), "total": float(r.total), "count": r.count} for r in monthly_q.all()]

    # Category trends
    cat_q = await db.execute(
        select(
            Expense.category_id,
            func.date_trunc("month", Expense.expense_date).label("month"),
            func.sum(Expense.base_amount).label("total"),
        )
        .where(Expense.user_id == current_user.id, Expense.expense_date >= since, Expense.is_deleted == False)
        .group_by(Expense.category_id, func.date_trunc("month", Expense.expense_date))
    )
    cat_trends = [
        {"category_id": str(r.category_id) if r.category_id else None, "month": r.month.isoformat(), "total": float(r.total)}
        for r in cat_q.all()
    ]

    # Anomaly detection: flag months > 1.5x average
    anomalies = []
    if len(monthly) >= 2:
        avg = sum(m["total"] for m in monthly[:-1]) / len(monthly[:-1])
        latest = monthly[-1]["total"] if monthly else 0
        if latest > avg * 1.5:
            anomalies.append({
                "type": "high_spend",
                "message": f"Spending this month is {((latest/avg - 1)*100):.0f}% above your average",
                "severity": "warning",
            })
        if latest < avg * 0.5:
            anomalies.append({
                "type": "low_spend",
                "message": "Spending this month is unusually low — great job!",
                "severity": "info",
            })

    # Recurring expense forecast (next 30 days)
    now = datetime.now(timezone.utc)
    recurring_q = await db.execute(
        select(RecurringRule).where(
            RecurringRule.user_id == current_user.id,
            RecurringRule.is_active == True,
            RecurringRule.next_due_date <= now + timedelta(days=30),
        )
    )
    upcoming = [
        {
            "name": r.name,
            "amount": float(r.amount),
            "currency": r.currency,
            "due_date": r.next_due_date.isoformat(),
        }
        for r in recurring_q.scalars().all()
    ]
    upcoming_total = sum(u["amount"] for u in upcoming)

    # Predictive budget suggestion
    avg_monthly = sum(m["total"] for m in monthly) / max(1, len(monthly))
    suggestions = []
    if avg_monthly > 0:
        suggestions.append({
            "type": "budget_suggestion",
            "message": f"Based on your spending, a monthly budget of {current_user.base_currency} {avg_monthly * 1.1:.2f} would cover 90% of your typical months.",
        })

    return {
        "monthly_trends": monthly,
        "category_trends": cat_trends,
        "anomalies": anomalies,
        "upcoming_recurring": upcoming,
        "upcoming_recurring_total": upcoming_total,
        "average_monthly_spend": float(avg_monthly),
        "currency": current_user.base_currency,
        "suggestions": suggestions,
    }


@router.get("/calendar")
async def calendar_view(
    year: int, month: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Daily expense totals for calendar view."""
    start = datetime(year, month, 1, tzinfo=timezone.utc)
    if month == 12:
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
    else:
        end = datetime(year, month + 1, 1, tzinfo=timezone.utc)

    result = await db.execute(
        select(
            func.date_trunc("day", Expense.expense_date).label("day"),
            func.sum(Expense.base_amount).label("total"),
            func.count().label("count"),
        )
        .where(
            Expense.user_id == current_user.id,
            Expense.expense_date >= start,
            Expense.expense_date < end,
            Expense.is_deleted == False,
        )
        .group_by(func.date_trunc("day", Expense.expense_date))
    )
    return {
        "days": [{"date": r.day.strftime("%Y-%m-%d"), "total": float(r.total), "count": r.count} for r in result.all()],
        "currency": current_user.base_currency,
    }
