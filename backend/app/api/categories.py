"""
Categories API
"""
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import get_current_user
from app.core.database import get_db
from app.core.exceptions import AppException
from app.models.models import Category, User

router = APIRouter()


class CategoryCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    icon: str = Field(default="tag", max_length=50)
    color: str = Field(default="#6B7280", max_length=7)
    parent_id: Optional[UUID] = None


class CategoryOut(BaseModel):
    id: UUID
    name: str
    icon: str
    color: str
    is_default: bool
    parent_id: Optional[UUID]
    user_id: Optional[UUID]

    class Config:
        from_attributes = True


@router.get("", response_model=List[CategoryOut])
async def list_categories(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Return system categories + user-created categories."""
    result = await db.execute(
        select(Category).where(
            (Category.user_id == current_user.id) | (Category.user_id.is_(None))
        ).order_by(Category.is_default.desc(), Category.name)
    )
    return result.scalars().all()


@router.post("", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
async def create_category(
    body: CategoryCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    cat = Category(user_id=current_user.id, **body.model_dump())
    db.add(cat)
    await db.flush()
    return cat


@router.patch("/{category_id}", response_model=CategoryOut)
async def update_category(
    category_id: UUID,
    body: CategoryCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Category).where(Category.id == category_id, Category.user_id == current_user.id)
    )
    cat = result.scalar_one_or_none()
    if not cat:
        raise AppException("Category not found or not editable", "NOT_FOUND", status.HTTP_404_NOT_FOUND)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(cat, k, v)
    return cat


@router.delete("/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_category(
    category_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Category).where(Category.id == category_id, Category.user_id == current_user.id)
    )
    cat = result.scalar_one_or_none()
    if not cat:
        raise AppException("Category not found", "NOT_FOUND", status.HTTP_404_NOT_FOUND)
    await db.delete(cat)