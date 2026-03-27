"""
Background Task Scheduler (APScheduler)
Jobs:
- Process recurring expenses
- Budget alerts
- Daily logging reminders
- Weekly summary notifications
- Exchange rate refresh
- Sync log cleanup
"""
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import structlog
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy import and_, func, select

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.models.models import (
    Budget, DeviceToken, Expense, Notification, NotificationType,
    RecurringRule, RecurrenceInterval, User
)
from app.services.currency import refresh_exchange_rates
from app.services import send_push_notification

logger = structlog.get_logger(__name__)
_scheduler = AsyncIOScheduler(timezone="UTC")


async def start_scheduler():
    _scheduler.add_job(process_recurring_expenses, IntervalTrigger(hours=1),    id="recurring_expenses",  replace_existing=True)
    _scheduler.add_job(check_budget_alerts,         IntervalTrigger(hours=4),   id="budget_alerts",       replace_existing=True)
    _scheduler.add_job(send_daily_reminders,        CronTrigger(hour=20, minute=0), id="daily_reminders", replace_existing=True)
    _scheduler.add_job(send_weekly_summaries,       CronTrigger(day_of_week="sun", hour=9), id="weekly_summary", replace_existing=True)
    _scheduler.add_job(refresh_exchange_rates,      IntervalTrigger(hours=1),   id="exchange_rates",      replace_existing=True)
    _scheduler.add_job(cleanup_sync_log,            CronTrigger(hour=3),        id="sync_cleanup",        replace_existing=True)
    _scheduler.start()
    logger.info("Scheduler started", job_count=len(_scheduler.get_jobs()))


async def stop_scheduler():
    _scheduler.shutdown(wait=False)
    logger.info("Scheduler stopped")


# ── Recurring Expenses ────────────────────────────────────────────────────────

async def process_recurring_expenses():
    """Create expense records for due recurring rules."""
    now = datetime.now(timezone.utc)
    logger.info("Processing recurring expenses", time=now.isoformat())

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(RecurringRule).where(
                RecurringRule.is_active == True,
                RecurringRule.next_due_date <= now,
            ).limit(500)
        )
        rules = result.scalars().all()
        logger.info("Found due recurring rules", count=len(rules))

        for rule in rules:
            try:
                if rule.auto_log:
                    from app.services.currency import convert_currency
                    user_result = await db.execute(select(User).where(User.id == rule.user_id))
                    user = user_result.scalar_one_or_none()
                    if not user:
                        continue

                    base_amount, exchange_rate = await convert_currency(
                        rule.amount, rule.currency, user.base_currency
                    )
                    expense = Expense(
                        user_id=rule.user_id,
                        wallet_id=rule.wallet_id,
                        category_id=rule.category_id,
                        recurring_rule_id=rule.id,
                        amount=rule.amount,
                        currency=rule.currency,
                        base_amount=base_amount,
                        exchange_rate=exchange_rate,
                        expense_date=rule.next_due_date,
                        merchant_name=rule.merchant_name,
                        notes=rule.notes or f"Auto-logged: {rule.name}",
                        payment_method=rule.payment_method,
                    )
                    db.add(expense)

                # Send notification
                notif = Notification(
                    user_id=rule.user_id,
                    type=NotificationType.RECURRING_DUE,
                    title="Recurring Expense Due",
                    body=f"{rule.name} - {rule.currency} {rule.amount:.2f} is due today.",
                    data={"rule_id": str(rule.id), "action": "log_expense"},
                )
                db.add(notif)

                # Advance next_due_date
                rule.next_due_date = _advance_date(rule.next_due_date, rule.interval, rule.interval_count)
                rule.last_triggered = now

                await db.flush()

                # Push notification
                tokens_result = await db.execute(
                    select(DeviceToken).where(DeviceToken.user_id == rule.user_id, DeviceToken.is_active == True)
                )
                tokens = tokens_result.scalars().all()
                for token in tokens:
                    await send_push_notification(
                        token=token.token,
                        platform=token.platform,
                        title=notif.title,
                        body=notif.body,
                        data=notif.data or {},
                    )

            except Exception as e:
                logger.error("Failed to process recurring rule", rule_id=str(rule.id), error=str(e))

        await db.commit()
        logger.info("Recurring expense processing complete", processed=len(rules))


def _advance_date(date: datetime, interval: RecurrenceInterval, count: int) -> datetime:
    """Advance a datetime by the specified interval × count."""
    if interval == RecurrenceInterval.DAILY:
        return date + timedelta(days=count)
    elif interval == RecurrenceInterval.WEEKLY:
        return date + timedelta(weeks=count)
    elif interval == RecurrenceInterval.BIWEEKLY:
        return date + timedelta(weeks=2 * count)
    elif interval == RecurrenceInterval.MONTHLY:
        # Advance by N months
        month = date.month + count
        year = date.year + (month - 1) // 12
        month = (month - 1) % 12 + 1
        from calendar import monthrange
        max_day = monthrange(year, month)[1]
        return date.replace(year=year, month=month, day=min(date.day, max_day))
    elif interval == RecurrenceInterval.QUARTERLY:
        return _advance_date(date, RecurrenceInterval.MONTHLY, 3 * count)
    elif interval == RecurrenceInterval.YEARLY:
        return date.replace(year=date.year + count)
    elif interval == RecurrenceInterval.CUSTOM:
        return date + timedelta(days=count)
    return date


# ── Budget Alerts ─────────────────────────────────────────────────────────────

async def check_budget_alerts():
    """Check all active budgets and notify users approaching limits."""
    now = datetime.now(timezone.utc)
    logger.info("Checking budget alerts")

    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Budget).where(
                Budget.is_active == True,
                Budget.period_start <= now,
                Budget.period_end >= now,
            )
        )
        budgets = result.scalars().all()

        for budget in budgets:
            try:
                # Calculate spent in this budget's scope
                conditions = [
                    Expense.user_id == budget.user_id,
                    Expense.is_deleted == False,
                    Expense.expense_date >= budget.period_start,
                    Expense.expense_date <= budget.period_end,
                ]
                if budget.category_id:
                    conditions.append(Expense.category_id == budget.category_id)
                if budget.wallet_id:
                    conditions.append(Expense.wallet_id == budget.wallet_id)

                spent_result = await db.execute(
                    select(func.sum(Expense.base_amount)).where(and_(*conditions))
                )
                spent = spent_result.scalar() or Decimal("0")
                pct_used = float(spent / budget.amount * 100) if budget.amount > 0 else 0

                if pct_used >= budget.alert_at_pct:
                    # Check if we already sent this alert recently (within 24h)
                    recent_notif = await db.execute(
                        select(Notification).where(
                            Notification.user_id == budget.user_id,
                            Notification.type == NotificationType.BUDGET_ALERT,
                            Notification.data["budget_id"].as_string() == str(budget.id),
                            Notification.created_at >= now - timedelta(hours=24),
                        )
                    )
                    if recent_notif.scalar_one_or_none():
                        continue

                    title = "⚠️ Budget Alert"
                    body = (
                        f'You\'ve used {pct_used:.0f}% of your "{budget.name}" budget '
                        f"({budget.currency} {float(spent):.2f} / {float(budget.amount):.2f})"
                    )
                    if pct_used >= 100:
                        title = "🚨 Budget Exceeded"
                        body = f'Your "{budget.name}" budget is over by {budget.currency} {float(spent - budget.amount):.2f}'

                    notif = Notification(
                        user_id=budget.user_id,
                        type=NotificationType.BUDGET_ALERT,
                        title=title,
                        body=body,
                        data={"budget_id": str(budget.id), "pct_used": pct_used},
                    )
                    db.add(notif)
                    await db.flush()

                    # Push
                    tokens_result = await db.execute(
                        select(DeviceToken).where(DeviceToken.user_id == budget.user_id, DeviceToken.is_active == True)
                    )
                    for token in tokens_result.scalars().all():
                        await send_push_notification(token.token, token.platform, title, body, notif.data)

            except Exception as e:
                logger.error("Budget alert check failed", budget_id=str(budget.id), error=str(e))

        await db.commit()


# ── Daily Reminders ───────────────────────────────────────────────────────────

async def send_daily_reminders():
    """Send reminder to users who haven't logged an expense today."""
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)

    async with AsyncSessionLocal() as db:
        # Users who want daily reminders (check preferences)
        users_result = await db.execute(
            select(User).where(User.is_active == True)
        )
        users = users_result.scalars().all()

        for user in users:
            prefs = user.preferences or {}
            if not prefs.get("notifications", {}).get("daily_reminder", True):
                continue

            # Check if user logged anything today
            logged_result = await db.execute(
                select(func.count()).select_from(Expense).where(
                    Expense.user_id == user.id,
                    Expense.expense_date >= today_start,
                    Expense.is_deleted == False,
                )
            )
            logged_today = logged_result.scalar()
            if logged_today and logged_today > 0:
                continue

            notif = Notification(
                user_id=user.id,
                type=NotificationType.DAILY_REMINDER,
                title="💰 Don't forget to log your expenses!",
                body="Track your spending to stay on budget. Tap to add an expense.",
                data={"action": "open_quick_add"},
            )
            db.add(notif)

            tokens_result = await db.execute(
                select(DeviceToken).where(DeviceToken.user_id == user.id, DeviceToken.is_active == True)
            )
            for token in tokens_result.scalars().all():
                await send_push_notification(token.token, token.platform, notif.title, notif.body, {})

        await db.commit()
        logger.info("Daily reminders sent")


# ── Weekly Summary ────────────────────────────────────────────────────────────

async def send_weekly_summaries():
    """Send weekly spending summary to all active users."""
    now = datetime.now(timezone.utc)
    week_start = now - timedelta(days=7)

    async with AsyncSessionLocal() as db:
        users_result = await db.execute(select(User).where(User.is_active == True))
        users = users_result.scalars().all()

        for user in users:
            prefs = user.preferences or {}
            if not prefs.get("notifications", {}).get("weekly_summary", True):
                continue

            try:
                spent_result = await db.execute(
                    select(func.sum(Expense.base_amount)).where(
                        Expense.user_id == user.id,
                        Expense.expense_date >= week_start,
                        Expense.is_deleted == False,
                    )
                )
                total = spent_result.scalar() or Decimal("0")

                count_result = await db.execute(
                    select(func.count()).select_from(Expense).where(
                        Expense.user_id == user.id,
                        Expense.expense_date >= week_start,
                        Expense.is_deleted == False,
                    )
                )
                count = count_result.scalar() or 0

                body = f"You logged {count} expenses totalling {user.base_currency} {float(total):.2f} this week."

                notif = Notification(
                    user_id=user.id,
                    type=NotificationType.WEEKLY_SUMMARY,
                    title="📊 Your Weekly Summary",
                    body=body,
                    data={"week_start": week_start.isoformat(), "total": float(total), "count": count},
                )
                db.add(notif)

                tokens_result = await db.execute(
                    select(DeviceToken).where(DeviceToken.user_id == user.id, DeviceToken.is_active == True)
                )
                for token in tokens_result.scalars().all():
                    await send_push_notification(token.token, token.platform, notif.title, body, {})

            except Exception as e:
                logger.error("Weekly summary failed for user", user_id=str(user.id), error=str(e))

        await db.commit()
        logger.info("Weekly summaries sent")


# ── Sync Log Cleanup ──────────────────────────────────────────────────────────

async def cleanup_sync_log():
    """Remove sync log entries older than 90 days to control table size."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=90)
    async with AsyncSessionLocal() as db:
        from sqlalchemy import delete
        result = await db.execute(
            delete(type("SyncLog", (), {"__tablename__": "sync_log"}))
            .__class__  # workaround - use raw SQL
        )
        # Use raw SQL for bulk delete
        from sqlalchemy import text
        result = await db.execute(
            text("DELETE FROM sync_log WHERE created_at < :cutoff"),
            {"cutoff": cutoff}
        )
        await db.commit()
        logger.info("Sync log cleaned up", cutoff=cutoff.isoformat(), deleted=result.rowcount)