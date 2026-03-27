"""Tags API"""
from typing import List, Optional
from uuid import UUID
from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.api.auth import get_current_user
from app.core.database import get_db
from app.core.exceptions import AppException
from app.models.models import Tag, User

router = APIRouter()

class TagCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=50)
    color: str = Field(default="#9CA3AF", max_length=7)

class TagOut(BaseModel):
    id: UUID; name: str; color: str
    class Config: from_attributes = True

@router.get("", response_model=List[TagOut])
async def list_tags(current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Tag).where(Tag.user_id == current_user.id).order_by(Tag.name))
    return result.scalars().all()

@router.post("", response_model=TagOut, status_code=status.HTTP_201_CREATED)
async def create_tag(body: TagCreate, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    tag = Tag(user_id=current_user.id, **body.model_dump())
    db.add(tag); await db.flush(); return tag

@router.delete("/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_tag(tag_id: UUID, current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Tag).where(Tag.id == tag_id, Tag.user_id == current_user.id))
    tag = result.scalar_one_or_none()
    if not tag: raise AppException("Tag not found", "NOT_FOUND", status.HTTP_404_NOT_FOUND)
    await db.delete(tag)