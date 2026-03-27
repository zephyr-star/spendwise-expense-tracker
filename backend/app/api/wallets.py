"""Wallets API - Shared wallets with role-based access and per-user balances"""
from datetime import datetime
from decimal import Decimal
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.auth import get_current_user
from app.core.database import get_db
from app.core.exceptions import AppException
from app.models.models import User, Wallet, WalletRole, WalletUser

router = APIRouter()


class WalletCreate(BaseModel):
    name: str = Field(..., max_length=100)
    description: Optional[str] = Field(None, max_length=500)
    currency: str = Field(default="USD", min_length=3, max_length=3)
    color: Optional[str] = Field(None, max_length=7)
    icon: Optional[str] = Field(None, max_length=50)


class WalletMemberOut(BaseModel):
    user_id: UUID
    display_name: str
    email: str
    avatar_url: Optional[str]
    role: WalletRole
    balance: Decimal
    joined_at: datetime


class WalletOut(BaseModel):
    id: UUID
    name: str
    description: Optional[str]
    currency: str
    color: Optional[str]
    icon: Optional[str]
    is_shared: bool
    is_archived: bool
    members: List[WalletMemberOut] = []
    my_role: Optional[WalletRole] = None
    my_balance: Decimal = Decimal("0")
    created_at: datetime


class InviteMember(BaseModel):
    email: str
    role: WalletRole = WalletRole.MEMBER


class SettleRequest(BaseModel):
    from_user_id: UUID
    to_user_id: UUID
    amount: Decimal = Field(..., gt=0)


def _build_wallet_out(wallet: Wallet, current_user_id: UUID) -> WalletOut:
    members = []
    my_role = None
    my_balance = Decimal("0")
    for wu in (wallet.members or []):
        if wu.user and not wu.user.is_active:
            continue
        members.append(WalletMemberOut(
            user_id=wu.user_id,
            display_name=wu.user.display_name if wu.user else "Unknown",
            email=wu.user.email if wu.user else "",
            avatar_url=wu.user.avatar_url if wu.user else None,
            role=wu.role,
            balance=wu.balance,
            joined_at=wu.joined_at,
        ))
        if wu.user_id == current_user_id:
            my_role = wu.role
            my_balance = wu.balance
    return WalletOut(
        id=wallet.id, name=wallet.name, description=wallet.description,
        currency=wallet.currency, color=wallet.color, icon=wallet.icon,
        is_shared=wallet.is_shared, is_archived=wallet.is_archived,
        members=members, my_role=my_role, my_balance=my_balance,
        created_at=wallet.created_at,
    )


@router.get("", response_model=List[WalletOut])
async def list_wallets(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Wallet)
        .join(WalletUser, WalletUser.wallet_id == Wallet.id)
        .where(WalletUser.user_id == current_user.id, Wallet.is_archived == False)
        .options(selectinload(Wallet.members).selectinload(WalletUser.user))
    )
    wallets = result.scalars().unique().all()
    return [_build_wallet_out(w, current_user.id) for w in wallets]


@router.post("", response_model=WalletOut, status_code=status.HTTP_201_CREATED)
async def create_wallet(
    body: WalletCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    wallet = Wallet(**body.model_dump())
    db.add(wallet)
    await db.flush()
    # Owner membership
    wu = WalletUser(wallet_id=wallet.id, user_id=current_user.id, role=WalletRole.OWNER)
    db.add(wu)
    await db.flush()
    await db.refresh(wallet, ["members"])
    for m in wallet.members:
        await db.refresh(m, ["user"])
    return _build_wallet_out(wallet, current_user.id)


@router.post("/{wallet_id}/invite", response_model=dict)
async def invite_member(
    wallet_id: UUID,
    body: InviteMember,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Check caller is owner/admin
    wu_result = await db.execute(
        select(WalletUser).where(WalletUser.wallet_id == wallet_id, WalletUser.user_id == current_user.id)
    )
    caller_wu = wu_result.scalar_one_or_none()
    if not caller_wu or caller_wu.role not in (WalletRole.OWNER, WalletRole.ADMIN):
        raise AppException("Insufficient permissions", "FORBIDDEN", status.HTTP_403_FORBIDDEN)

    # Find invitee by email
    user_result = await db.execute(select(User).where(User.email == body.email, User.is_active == True))
    invitee = user_result.scalar_one_or_none()
    if not invitee:
        raise AppException("User not found", "USER_NOT_FOUND", status.HTTP_404_NOT_FOUND)

    # Check already member
    existing = await db.execute(
        select(WalletUser).where(WalletUser.wallet_id == wallet_id, WalletUser.user_id == invitee.id)
    )
    if existing.scalar_one_or_none():
        raise AppException("User already a member", "ALREADY_MEMBER", status.HTTP_409_CONFLICT)

    new_wu = WalletUser(wallet_id=wallet_id, user_id=invitee.id, role=body.role)
    db.add(new_wu)

    # Mark wallet as shared
    wallet_result = await db.execute(select(Wallet).where(Wallet.id == wallet_id))
    wallet = wallet_result.scalar_one()
    wallet.is_shared = True

    return {"message": f"{invitee.display_name} added to wallet", "user_id": str(invitee.id)}


@router.post("/{wallet_id}/settle", response_model=dict)
async def settle_balance(
    wallet_id: UUID,
    body: SettleRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Record a settlement between two wallet members."""
    # Validate caller is member
    caller_wu = await db.execute(
        select(WalletUser).where(WalletUser.wallet_id == wallet_id, WalletUser.user_id == current_user.id)
    )
    if not caller_wu.scalar_one_or_none():
        raise AppException("Not a wallet member", "FORBIDDEN", status.HTTP_403_FORBIDDEN)

    from_wu_result = await db.execute(select(WalletUser).where(WalletUser.wallet_id == wallet_id, WalletUser.user_id == body.from_user_id))
    to_wu_result = await db.execute(select(WalletUser).where(WalletUser.wallet_id == wallet_id, WalletUser.user_id == body.to_user_id))
    from_wu = from_wu_result.scalar_one_or_none()
    to_wu = to_wu_result.scalar_one_or_none()
    if not from_wu or not to_wu:
        raise AppException("Settlement member not found", "NOT_FOUND", status.HTTP_404_NOT_FOUND)

    from_wu.balance -= body.amount
    to_wu.balance += body.amount
    return {"message": "Settlement recorded", "amount": float(body.amount)}


@router.delete("/{wallet_id}", status_code=status.HTTP_204_NO_CONTENT)
async def archive_wallet(
    wallet_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    wu_result = await db.execute(
        select(WalletUser).where(WalletUser.wallet_id == wallet_id, WalletUser.user_id == current_user.id)
    )
    wu = wu_result.scalar_one_or_none()
    if not wu or wu.role != WalletRole.OWNER:
        raise AppException("Only owner can archive wallet", "FORBIDDEN", status.HTTP_403_FORBIDDEN)

    wallet_result = await db.execute(select(Wallet).where(Wallet.id == wallet_id))
    wallet = wallet_result.scalar_one()
    wallet.is_archived = True