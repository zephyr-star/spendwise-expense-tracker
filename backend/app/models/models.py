"""
SpendWise Database Models - Complete Schema
PostgreSQL with SQLAlchemy ORM
All tables: users, wallets, wallet_users, categories, expenses, tags,
            expense_tags, budgets, recurring_rules, notifications,
            sync_log, device_tokens, audit_log
"""
import uuid
from datetime import datetime
from decimal import Decimal
from enum import Enum as PyEnum
from typing import List, Optional
 
from sqlalchemy import (
    BigInteger, Boolean, Column, DateTime, Enum, ForeignKey,
    Index, Integer, Numeric, String, Text, UniqueConstraint,
    CheckConstraint, JSON, func
)
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY
from sqlalchemy.orm import Mapped, mapped_column, relationship
 
from app.core.database import Base
 
 
def uuid_pk():
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
 
def now_utc():
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
 
def updated_at():
    return mapped_column(DateTime(timezone=True), server_default=func.now(),
                         onupdate=func.now(), nullable=False)
 
 
# ── Enums ─────────────────────────────────────────────────────────────────────
 
class PaymentMethod(str, PyEnum):
    CASH = "cash"
    CREDIT_CARD = "credit_card"
    DEBIT_CARD = "debit_card"
    BANK_TRANSFER = "bank_transfer"
    DIGITAL_WALLET = "digital_wallet"
    CRYPTO = "crypto"
    OTHER = "other"
 
 
class RecurrenceInterval(str, PyEnum):
    DAILY = "daily"
    WEEKLY = "weekly"
    BIWEEKLY = "biweekly"
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    YEARLY = "yearly"
    CUSTOM = "custom"
 
 
class WalletRole(str, PyEnum):
    OWNER = "owner"
    ADMIN = "admin"
    MEMBER = "member"
    VIEWER = "viewer"
 
 
class SyncOperation(str, PyEnum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
 
 
class NotificationType(str, PyEnum):
    BUDGET_ALERT = "budget_alert"
    DAILY_REMINDER = "daily_reminder"
    WEEKLY_SUMMARY = "weekly_summary"
    WALLET_UPDATE = "wallet_update"
    ANOMALY_DETECTED = "anomaly_detected"
    RECURRING_DUE = "recurring_due"
    GOAL_ACHIEVED = "goal_achieved"
 
 
class ExportFormat(str, PyEnum):
    CSV = "csv"
    PDF = "pdf"
    JSON = "json"
 
 
# ── Users ─────────────────────────────────────────────────────────────────────
 
class User(Base):
    __tablename__ = "users"
 
    id:            Mapped[uuid.UUID]        = uuid_pk()
    email:         Mapped[str]              = mapped_column(String(320), unique=True, index=True, nullable=False)
    display_name:  Mapped[str]              = mapped_column(String(100), nullable=False)
    avatar_url:    Mapped[Optional[str]]    = mapped_column(String(1024))
    google_sub:    Mapped[Optional[str]]    = mapped_column(String(256), unique=True, index=True)
    hashed_pw:     Mapped[Optional[str]]    = mapped_column(String(256))  # null if OAuth-only
    is_active:     Mapped[bool]             = mapped_column(Boolean, default=True, nullable=False)
    is_verified:   Mapped[bool]             = mapped_column(Boolean, default=False, nullable=False)
    base_currency: Mapped[str]              = mapped_column(String(3), default="USD", nullable=False)
    timezone:      Mapped[str]              = mapped_column(String(64), default="UTC", nullable=False)
    locale:        Mapped[str]              = mapped_column(String(10), default="en-US", nullable=False)
    preferences:   Mapped[dict]             = mapped_column(JSONB, default=dict, nullable=False)
    # preferences schema: {theme, colorScheme, fontSize, notifications, gamification, ...}
    created_at:    Mapped[datetime]         = now_utc()
    updated_at:    Mapped[datetime]         = updated_at()
    last_login_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
 
    # Relationships
    wallets:        Mapped[List["WalletUser"]]    = relationship(back_populates="user", cascade="all, delete-orphan")
    expenses:       Mapped[List["Expense"]]       = relationship(back_populates="user", cascade="all, delete-orphan")
    categories:     Mapped[List["Category"]]      = relationship(back_populates="user", cascade="all, delete-orphan")
    budgets:        Mapped[List["Budget"]]        = relationship(back_populates="user", cascade="all, delete-orphan")
    notifications:  Mapped[List["Notification"]]  = relationship(back_populates="user", cascade="all, delete-orphan")
    device_tokens:  Mapped[List["DeviceToken"]]   = relationship(back_populates="user", cascade="all, delete-orphan")
    refresh_tokens: Mapped[List["RefreshToken"]]  = relationship(back_populates="user", cascade="all, delete-orphan")
    points:         Mapped[Optional["UserPoints"]] = relationship(back_populates="user", uselist=False)
 
 
class RefreshToken(Base):
    __tablename__ = "refresh_tokens"
 
    id:         Mapped[uuid.UUID]  = uuid_pk()
    user_id:    Mapped[uuid.UUID]  = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash: Mapped[str]        = mapped_column(String(256), unique=True, nullable=False)
    device_id:  Mapped[Optional[str]] = mapped_column(String(256))
    expires_at: Mapped[datetime]   = mapped_column(DateTime(timezone=True), nullable=False)
    revoked:    Mapped[bool]        = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime]   = now_utc()
 
    user: Mapped["User"] = relationship(back_populates="refresh_tokens")
 
 
# ── Wallets ───────────────────────────────────────────────────────────────────
 
class Wallet(Base):
    __tablename__ = "wallets"
 
    id:          Mapped[uuid.UUID]        = uuid_pk()
    name:        Mapped[str]              = mapped_column(String(100), nullable=False)
    description: Mapped[Optional[str]]   = mapped_column(String(500))
    currency:    Mapped[str]              = mapped_column(String(3), default="USD", nullable=False)
    color:       Mapped[Optional[str]]   = mapped_column(String(7))  # hex
    icon:        Mapped[Optional[str]]   = mapped_column(String(50))
    is_shared:   Mapped[bool]            = mapped_column(Boolean, default=False, nullable=False)
    is_archived: Mapped[bool]            = mapped_column(Boolean, default=False, nullable=False)
    created_at:  Mapped[datetime]        = now_utc()
    updated_at:  Mapped[datetime]        = updated_at()
 
    members:     Mapped[List["WalletUser"]] = relationship(back_populates="wallet", cascade="all, delete-orphan")
    expenses:    Mapped[List["Expense"]]    = relationship(back_populates="wallet")
    budgets:     Mapped[List["Budget"]]     = relationship(back_populates="wallet")
 
 
class WalletUser(Base):
    __tablename__ = "wallet_users"
    __table_args__ = (UniqueConstraint("wallet_id", "user_id"),)
 
    id:         Mapped[uuid.UUID]  = uuid_pk()
    wallet_id:  Mapped[uuid.UUID]  = mapped_column(ForeignKey("wallets.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id:    Mapped[uuid.UUID]  = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    role:       Mapped[WalletRole] = mapped_column(Enum(WalletRole), default=WalletRole.MEMBER, nullable=False)
    balance:    Mapped[Decimal]    = mapped_column(Numeric(15, 4), default=0, nullable=False)
    # balance = how much this user is owed (positive) or owes (negative) in wallet currency
    joined_at:  Mapped[datetime]   = now_utc()
 
    wallet: Mapped["Wallet"] = relationship(back_populates="members")
    user:   Mapped["User"]   = relationship(back_populates="wallets")
 
 
# ── Categories ────────────────────────────────────────────────────────────────
 
class Category(Base):
    __tablename__ = "categories"
    __table_args__ = (
        UniqueConstraint("user_id", "name", name="uq_category_user_name"),
    )
 
    id:          Mapped[uuid.UUID]        = uuid_pk()
    user_id:     Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # user_id=NULL → system/default category
    name:        Mapped[str]              = mapped_column(String(80), nullable=False)
    icon:        Mapped[str]              = mapped_column(String(50), default="tag", nullable=False)
    color:       Mapped[str]              = mapped_column(String(7), default="#6B7280", nullable=False)
    is_default:  Mapped[bool]             = mapped_column(Boolean, default=False, nullable=False)
    parent_id:   Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"))
    ml_keywords: Mapped[Optional[list]]   = mapped_column(JSONB)  # for edge ML matching
    created_at:  Mapped[datetime]         = now_utc()
 
    user:       Mapped[Optional["User"]] = relationship(back_populates="categories")
    expenses:   Mapped[List["Expense"]]  = relationship(back_populates="category")
    children:   Mapped[List["Category"]] = relationship(back_populates="parent")
    parent:     Mapped[Optional["Category"]] = relationship(back_populates="children", remote_side="Category.id")
 
 
# ── Tags ──────────────────────────────────────────────────────────────────────
 
class Tag(Base):
    __tablename__ = "tags"
    __table_args__ = (UniqueConstraint("user_id", "name"),)
 
    id:        Mapped[uuid.UUID]        = uuid_pk()
    user_id:   Mapped[uuid.UUID]        = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name:      Mapped[str]              = mapped_column(String(50), nullable=False)
    color:     Mapped[str]              = mapped_column(String(7), default="#9CA3AF", nullable=False)
    created_at: Mapped[datetime]        = now_utc()
 
    expenses: Mapped[List["Expense"]] = relationship(secondary="expense_tags", back_populates="tags")
 
 
class ExpenseTag(Base):
    __tablename__ = "expense_tags"
    __table_args__ = (UniqueConstraint("expense_id", "tag_id"),)
 
    expense_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("expenses.id", ondelete="CASCADE"), primary_key=True)
    tag_id:     Mapped[uuid.UUID] = mapped_column(ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True)
 
 
# ── Recurring Rules ───────────────────────────────────────────────────────────
 
class RecurringRule(Base):
    __tablename__ = "recurring_rules"
 
    id:            Mapped[uuid.UUID]           = uuid_pk()
    user_id:       Mapped[uuid.UUID]           = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    name:          Mapped[str]                 = mapped_column(String(200), nullable=False)
    amount:        Mapped[Decimal]             = mapped_column(Numeric(15, 4), nullable=False)
    currency:      Mapped[str]                 = mapped_column(String(3), nullable=False)
    category_id:   Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"))
    wallet_id:     Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("wallets.id", ondelete="SET NULL"))
    merchant_name: Mapped[Optional[str]]       = mapped_column(String(200))
    notes:         Mapped[Optional[str]]       = mapped_column(Text)
    payment_method: Mapped[PaymentMethod]      = mapped_column(Enum(PaymentMethod), default=PaymentMethod.OTHER)
    interval:      Mapped[RecurrenceInterval]  = mapped_column(Enum(RecurrenceInterval), nullable=False)
    interval_count: Mapped[int]               = mapped_column(Integer, default=1, nullable=False)
    # For CUSTOM: interval_count=N + interval=DAILY means every N days
    start_date:    Mapped[datetime]            = mapped_column(DateTime(timezone=True), nullable=False)
    end_date:      Mapped[Optional[datetime]]  = mapped_column(DateTime(timezone=True))
    next_due_date: Mapped[datetime]            = mapped_column(DateTime(timezone=True), nullable=False)
    last_triggered: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    is_active:     Mapped[bool]               = mapped_column(Boolean, default=True, nullable=False)
    auto_log:      Mapped[bool]               = mapped_column(Boolean, default=False, nullable=False)
    created_at:    Mapped[datetime]            = now_utc()
    updated_at:    Mapped[datetime]            = updated_at()
 
 
 
 
# ── Expenses ──────────────────────────────────────────────────────────────────
 
class Expense(Base):
    __tablename__ = "expenses"
    __table_args__ = (
        Index("ix_expenses_user_date", "user_id", "expense_date"),
        Index("ix_expenses_wallet_id", "wallet_id"),
        Index("ix_expenses_category_id", "category_id"),
        Index("ix_expenses_sync_updated", "user_id", "updated_at"),
        CheckConstraint("amount > 0", name="chk_expense_amount_positive"),
    )
 
    id:              Mapped[uuid.UUID]           = uuid_pk()
    user_id:         Mapped[uuid.UUID]           = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    wallet_id:       Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("wallets.id", ondelete="SET NULL"))
    category_id:     Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"))
    recurring_rule_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("recurring_rules.id", ondelete="SET NULL"))
 
    # Core financial data
    amount:          Mapped[Decimal]             = mapped_column(Numeric(15, 4), nullable=False)
    currency:        Mapped[str]                 = mapped_column(String(3), nullable=False)
    base_amount:     Mapped[Decimal]             = mapped_column(Numeric(15, 4), nullable=False)  # converted to user base currency
    exchange_rate:   Mapped[Decimal]             = mapped_column(Numeric(20, 8), default=1, nullable=False)
 
    # Expense details
    expense_date:    Mapped[datetime]            = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    merchant_name:   Mapped[Optional[str]]       = mapped_column(String(200), index=True)
    notes:           Mapped[Optional[str]]       = mapped_column(Text)
    payment_method:  Mapped[PaymentMethod]       = mapped_column(Enum(PaymentMethod), default=PaymentMethod.OTHER)
    location_name:   Mapped[Optional[str]]       = mapped_column(String(300))
    location_lat:    Mapped[Optional[float]]     = mapped_column()
    location_lng:    Mapped[Optional[float]]     = mapped_column()
 
    # Receipt / OCR
    receipt_url:     Mapped[Optional[str]]       = mapped_column(String(1024))
    receipt_key:     Mapped[Optional[str]]       = mapped_column(String(512))  # storage key
    ocr_raw:         Mapped[Optional[dict]]      = mapped_column(JSONB)         # raw OCR output
    ocr_confidence:  Mapped[Optional[float]]     = mapped_column()
 
    # Splitting (shared wallets)
    is_split:        Mapped[bool]               = mapped_column(Boolean, default=False, nullable=False)
    split_data:      Mapped[Optional[dict]]     = mapped_column(JSONB)
    # split_data: [{user_id, amount, settled: bool}, ...]
 
    # ML
    ml_category_confidence: Mapped[Optional[float]] = mapped_column()
    ml_suggested_tags:      Mapped[Optional[list]]  = mapped_column(JSONB)
 
    # Sync
    client_id:       Mapped[Optional[str]]      = mapped_column(String(256), index=True)  # idempotency key
    is_deleted:      Mapped[bool]               = mapped_column(Boolean, default=False, nullable=False)  # soft delete for sync
 
    created_at:      Mapped[datetime]           = now_utc()
    updated_at:      Mapped[datetime]           = updated_at()
 
    # Relationships
    user:     Mapped["User"]               = relationship(back_populates="expenses")
    wallet:   Mapped[Optional["Wallet"]]   = relationship(back_populates="expenses")
    category: Mapped[Optional["Category"]] = relationship(back_populates="expenses")
    tags:     Mapped[List["Tag"]]          = relationship(secondary="expense_tags", back_populates="expenses")
 
 
# ── Budgets ───────────────────────────────────────────────────────────────────
 
class Budget(Base):
    __tablename__ = "budgets"
    __table_args__ = (
        Index("ix_budgets_user_period", "user_id", "period_start", "period_end"),
    )
 
    id:           Mapped[uuid.UUID]           = uuid_pk()
    user_id:      Mapped[uuid.UUID]           = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    wallet_id:    Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("wallets.id", ondelete="CASCADE"))
    category_id:  Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"))
    name:         Mapped[str]                 = mapped_column(String(100), nullable=False)
    amount:       Mapped[Decimal]             = mapped_column(Numeric(15, 4), nullable=False)
    currency:     Mapped[str]                 = mapped_column(String(3), nullable=False)
    period_start: Mapped[datetime]            = mapped_column(DateTime(timezone=True), nullable=False)
    period_end:   Mapped[datetime]            = mapped_column(DateTime(timezone=True), nullable=False)
    alert_at_pct: Mapped[int]                = mapped_column(Integer, default=80, nullable=False)
    # alert_at_pct: notify when spent% >= this
    is_recurring: Mapped[bool]               = mapped_column(Boolean, default=False, nullable=False)
    recurrence:   Mapped[Optional[str]]      = mapped_column(String(20))  # monthly|weekly|yearly
    is_active:    Mapped[bool]              = mapped_column(Boolean, default=True, nullable=False)
    created_at:   Mapped[datetime]           = now_utc()
    updated_at:   Mapped[datetime]           = updated_at()
 
    user:     Mapped["User"]               = relationship(back_populates="budgets")
    wallet:   Mapped[Optional["Wallet"]]   = relationship(back_populates="budgets")
    category: Mapped[Optional["Category"]] = relationship()
 
 
# ── Notifications ─────────────────────────────────────────────────────────────
 
class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        Index("ix_notifications_user_created", "user_id", "created_at"),
    )
 
    id:         Mapped[uuid.UUID]          = uuid_pk()
    user_id:    Mapped[uuid.UUID]          = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    type:       Mapped[NotificationType]   = mapped_column(Enum(NotificationType), nullable=False)
    title:      Mapped[str]               = mapped_column(String(200), nullable=False)
    body:       Mapped[str]               = mapped_column(Text, nullable=False)
    data:       Mapped[Optional[dict]]    = mapped_column(JSONB)   # deeplink, entity_id, etc.
    is_read:    Mapped[bool]              = mapped_column(Boolean, default=False, nullable=False)
    sent_push:  Mapped[bool]              = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime]          = now_utc()
 
    user: Mapped["User"] = relationship(back_populates="notifications")
 
 
class DeviceToken(Base):
    __tablename__ = "device_tokens"
    __table_args__ = (UniqueConstraint("token"),)
 
    id:         Mapped[uuid.UUID]  = uuid_pk()
    user_id:    Mapped[uuid.UUID]  = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token:      Mapped[str]        = mapped_column(String(512), nullable=False)
    platform:   Mapped[str]        = mapped_column(String(10), nullable=False)  # ios | android | web
    device_id:  Mapped[str]        = mapped_column(String(256), nullable=False)
    is_active:  Mapped[bool]       = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime]   = now_utc()
    updated_at: Mapped[datetime]   = updated_at()
 
    user: Mapped["User"] = relationship(back_populates="device_tokens")
 
 
# ── Sync log ──────────────────────────────────────────────────────────────────
 
class SyncLog(Base):
    """Tracks every mutation for offline-to-cloud delta sync."""
    __tablename__ = "sync_log"
    __table_args__ = (
        Index("ix_sync_log_user_seq", "user_id", "sequence"),
    )
 
    id:          Mapped[uuid.UUID]    = uuid_pk()
    user_id:     Mapped[uuid.UUID]    = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    entity_type: Mapped[str]          = mapped_column(String(50), nullable=False)  # expense|category|tag|budget
    entity_id:   Mapped[uuid.UUID]    = mapped_column(UUID(as_uuid=True), nullable=False)
    operation:   Mapped[SyncOperation] = mapped_column(Enum(SyncOperation), nullable=False)
    payload:     Mapped[dict]         = mapped_column(JSONB, nullable=False)
    sequence:    Mapped[int]          = mapped_column(BigInteger, nullable=False)  # monotonic per user
    client_id:   Mapped[Optional[str]] = mapped_column(String(256))
    created_at:  Mapped[datetime]     = now_utc()
 
    user: Mapped["User"] = relationship()
 
 
# ── Gamification ──────────────────────────────────────────────────────────────
 
class UserPoints(Base):
    __tablename__ = "user_points"
 
    user_id:       Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    total_points:  Mapped[int]       = mapped_column(Integer, default=0, nullable=False)
    streak_days:   Mapped[int]       = mapped_column(Integer, default=0, nullable=False)
    last_log_date: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    badges:        Mapped[list]      = mapped_column(JSONB, default=list, nullable=False)
    updated_at:    Mapped[datetime]  = updated_at()
 
    user: Mapped["User"] = relationship(back_populates="points")
 
 
# ── Audit log (compliance) ────────────────────────────────────────────────────
 
class AuditLog(Base):
    """Immutable audit trail for GDPR/DPDP compliance."""
    __tablename__ = "audit_log"
    __table_args__ = (
        Index("ix_audit_log_user_created", "user_id", "created_at"),
    )
 
    id:          Mapped[uuid.UUID]      = uuid_pk()
    user_id:     Mapped[Optional[uuid.UUID]] = mapped_column(UUID(as_uuid=True), index=True)
    action:      Mapped[str]            = mapped_column(String(100), nullable=False)
    entity_type: Mapped[Optional[str]]  = mapped_column(String(50))
    entity_id:   Mapped[Optional[str]]  = mapped_column(String(256))
    ip_address:  Mapped[Optional[str]]  = mapped_column(String(45))
    user_agent:  Mapped[Optional[str]]  = mapped_column(String(512))
    extra_data:  Mapped[Optional[dict]] = mapped_column(JSONB)
    created_at:  Mapped[datetime]       = now_utc()