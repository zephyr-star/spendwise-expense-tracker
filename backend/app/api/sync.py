"""
Offline-First Cloud Sync API
- Pull: get all changes since a sequence number
- Push: upload local mutations with conflict detection
- Idempotent: safe to retry
"""
from datetime import datetime
from typing import List, Optional
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import get_current_user
from app.core.database import get_db
from app.core.exceptions import AppException
from app.models.models import (
    Budget, Category, Expense, RecurringRule, SyncLog, SyncOperation, Tag, User
)

logger = structlog.get_logger(__name__)
router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

class SyncPushItem(BaseModel):
    entity_type: str   # expense | category | tag | budget | recurring_rule
    entity_id: UUID
    operation: SyncOperation
    payload: dict
    client_id: Optional[str] = None
    client_timestamp: datetime


class SyncPushRequest(BaseModel):
    device_id: str
    items: List[SyncPushItem]


class SyncPushResult(BaseModel):
    accepted: int
    rejected: int
    conflicts: List[dict]
    server_sequence: int


class SyncPullResponse(BaseModel):
    changes: List[dict]
    server_sequence: int
    has_more: bool


# ── Conflict resolution strategy: Last-Write-Wins (server time) ───────────────
# For financial data: if client timestamp is older than server's updated_at,
# we flag as conflict and return server state. Client can re-apply or discard.

ENTITY_MAP = {
    "expense": Expense,
    "category": Category,
    "tag": Tag,
    "budget": Budget,
    "recurring_rule": RecurringRule,
}

# Fields allowed to be set by clients per entity (security whitelist)
ALLOWED_FIELDS = {
    "expense": {
        "amount", "currency", "category_id", "wallet_id", "expense_date",
        "merchant_name", "notes", "payment_method", "location_name",
        "location_lat", "location_lng", "is_deleted", "tag_ids", "split_data",
        "client_id", "recurring_rule_id",
    },
    "category": {"name", "icon", "color", "parent_id", "is_deleted"},
    "tag": {"name", "color", "is_deleted"},
    "budget": {"name", "amount", "currency", "period_start", "period_end", "alert_at_pct", "is_active"},
    "recurring_rule": {"name", "amount", "currency", "category_id", "interval", "interval_count",
                        "start_date", "end_date", "next_due_date", "is_active", "auto_log"},
}


@router.post("/push", response_model=SyncPushResult)
async def sync_push(
    body: SyncPushRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Client pushes local mutations. Server applies them idempotently.
    Returns conflicts where server state is newer than client state.
    """
    accepted = 0
    rejected = 0
    conflicts = []

    from sqlalchemy import func
    # Get current max sequence
    seq_result = await db.execute(
        select(func.coalesce(func.max(SyncLog.sequence), 0)).where(SyncLog.user_id == current_user.id)
    )
    server_seq = seq_result.scalar() or 0

    for item in body.items:
        entity_type = item.entity_type.lower()
        if entity_type not in ENTITY_MAP:
            rejected += 1
            logger.warning("Unknown entity type in sync push", entity_type=entity_type)
            continue

        Model = ENTITY_MAP[entity_type]
        allowed = ALLOWED_FIELDS.get(entity_type, set())

        try:
            if item.operation == SyncOperation.CREATE:
                # Idempotency: check client_id or entity_id
                check_q = select(Model).where(Model.id == item.entity_id)
                existing = (await db.execute(check_q)).scalar_one_or_none()

                if existing:
                    # Already exists - check ownership
                    if hasattr(existing, "user_id") and existing.user_id != current_user.id:
                        rejected += 1
                        continue
                    # Idempotent: already created
                    accepted += 1
                    continue

                # Build entity from payload
                safe_payload = {k: v for k, v in item.payload.items() if k in allowed}
                safe_payload["id"] = item.entity_id
                safe_payload["user_id"] = current_user.id
                entity = Model(**safe_payload)
                db.add(entity)

            elif item.operation == SyncOperation.UPDATE:
                result = await db.execute(select(Model).where(Model.id == item.entity_id))
                existing = result.scalar_one_or_none()
                if not existing:
                    rejected += 1
                    continue
                if hasattr(existing, "user_id") and existing.user_id != current_user.id:
                    rejected += 1
                    continue

                # Conflict detection: client's ts vs server's updated_at
                if hasattr(existing, "updated_at") and item.client_timestamp < existing.updated_at:
                    conflicts.append({
                        "entity_type": entity_type,
                        "entity_id": str(item.entity_id),
                        "reason": "server_newer",
                        "server_updated_at": existing.updated_at.isoformat(),
                    })
                    # Still accept client changes (Last-Write-Wins), but flag conflict
                    # Client can choose to override or keep server state

                safe_payload = {k: v for k, v in item.payload.items() if k in allowed}
                for field, value in safe_payload.items():
                    setattr(existing, field, value)

            elif item.operation == SyncOperation.DELETE:
                result = await db.execute(select(Model).where(Model.id == item.entity_id))
                existing = result.scalar_one_or_none()
                if not existing:
                    accepted += 1  # Already deleted = idempotent
                    continue
                if hasattr(existing, "user_id") and existing.user_id != current_user.id:
                    rejected += 1
                    continue
                if hasattr(existing, "is_deleted"):
                    existing.is_deleted = True
                else:
                    await db.delete(existing)

            # Log to sync_log
            server_seq += 1
            db.add(SyncLog(
                user_id=current_user.id,
                entity_type=entity_type,
                entity_id=item.entity_id,
                operation=item.operation,
                payload=item.payload,
                sequence=server_seq,
                client_id=item.client_id,
            ))
            accepted += 1
            await db.flush()

        except Exception as e:
            logger.error("Sync push item failed", entity_type=entity_type, entity_id=str(item.entity_id), error=str(e))
            rejected += 1

    logger.info("Sync push complete", accepted=accepted, rejected=rejected, device=body.device_id)
    return SyncPushResult(accepted=accepted, rejected=rejected, conflicts=conflicts, server_sequence=server_seq)


@router.get("/pull", response_model=SyncPullResponse)
async def sync_pull(
    since_sequence: int = 0,
    limit: int = 200,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Client pulls all server changes since a sequence number.
    Returns delta of mutations to apply locally.
    """
    result = await db.execute(
        select(SyncLog)
        .where(SyncLog.user_id == current_user.id, SyncLog.sequence > since_sequence)
        .order_by(SyncLog.sequence.asc())
        .limit(limit + 1)  # fetch one extra to detect has_more
    )
    logs = result.scalars().all()

    has_more = len(logs) > limit
    logs = logs[:limit]

    changes = [
        {
            "entity_type": log.entity_type,
            "entity_id": str(log.entity_id),
            "operation": log.operation.value,
            "payload": log.payload,
            "sequence": log.sequence,
            "created_at": log.created_at.isoformat(),
        }
        for log in logs
    ]

    server_seq = logs[-1].sequence if logs else since_sequence

    return SyncPullResponse(changes=changes, server_sequence=server_seq, has_more=has_more)


@router.get("/status")
async def sync_status(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Returns user's current max sync sequence."""
    from sqlalchemy import func
    result = await db.execute(
        select(func.coalesce(func.max(SyncLog.sequence), 0)).where(SyncLog.user_id == current_user.id)
    )
    return {"server_sequence": result.scalar(), "user_id": str(current_user.id)}