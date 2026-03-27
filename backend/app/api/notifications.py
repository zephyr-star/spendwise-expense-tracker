"""Notifications API"""
from typing import List, Optional
from uuid import UUID
from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from app.api.auth import get_current_user
from app.core.database import get_db
from app.models.models import DeviceToken, Notification, User

router = APIRouter()

class DeviceTokenRegister(BaseModel):
    token: str
    platform: str  # ios | android | web
    device_id: str

class NotificationOut(BaseModel):
    id: UUID
    type: str
    title: str
    body: str
    data: Optional[dict]
    is_read: bool
    created_at: str
    class Config: from_attributes = True

@router.get("", response_model=List[NotificationOut])
async def list_notifications(
    unread_only: bool = False,
    limit: int = 50,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    q = select(Notification).where(Notification.user_id == current_user.id)
    if unread_only:
        q = q.where(Notification.is_read == False)
    result = await db.execute(q.order_by(Notification.created_at.desc()).limit(limit))
    notifs = result.scalars().all()
    return [NotificationOut(
        id=n.id, type=n.type.value, title=n.title, body=n.body,
        data=n.data, is_read=n.is_read, created_at=n.created_at.isoformat()
    ) for n in notifs]

@router.post("/read-all", status_code=status.HTTP_204_NO_CONTENT)
async def mark_all_read(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    await db.execute(
        update(Notification).where(Notification.user_id == current_user.id, Notification.is_read == False).values(is_read=True)
    )

@router.post("/device-token", status_code=status.HTTP_201_CREATED)
async def register_device_token(
    body: DeviceTokenRegister,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(DeviceToken).where(DeviceToken.token == body.token))
    existing = result.scalar_one_or_none()
    if existing:
        existing.user_id = current_user.id; existing.is_active = True
    else:
        db.add(DeviceToken(user_id=current_user.id, token=body.token, platform=body.platform, device_id=body.device_id))
    return {"message": "Device token registered"}

@router.delete("/device-token/{device_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unregister_device_token(
    device_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(DeviceToken).where(DeviceToken.device_id == device_id, DeviceToken.user_id == current_user.id))
    token = result.scalar_one_or_none()
    if token:
        token.is_active = False