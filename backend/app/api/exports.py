"""
Export Service - PDF + CSV + JSON Report Generation
"""
import csv
import io
from datetime import datetime
from decimal import Decimal
from typing import List, Optional
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response, StreamingResponse
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.platypus import (
    SimpleDocTemplate, Table, TableStyle, Paragraph,
    Spacer, HRFlowable
)
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.auth import get_current_user
from app.core.database import get_db
from app.models.models import Category, Expense, Tag, User

logger = structlog.get_logger(__name__)
router = APIRouter()


# ── CSV Export ────────────────────────────────────────────────────────────────

async def generate_csv(expenses: list, user: User) -> io.StringIO:
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=[
        "Date", "Merchant", "Category", "Amount", "Currency", "Base Amount",
        "Base Currency", "Payment Method", "Notes", "Location", "Tags",
        "Wallet", "Is Recurring", "Receipt"
    ])
    writer.writeheader()

    for exp in expenses:
        writer.writerow({
            "Date": exp.expense_date.strftime("%Y-%m-%d %H:%M:%S"),
            "Merchant": exp.merchant_name or "",
            "Category": exp.category.name if exp.category else "",
            "Amount": f"{exp.amount:.2f}",
            "Currency": exp.currency,
            "Base Amount": f"{exp.base_amount:.2f}",
            "Base Currency": user.base_currency,
            "Payment Method": exp.payment_method.value,
            "Notes": exp.notes or "",
            "Location": exp.location_name or "",
            "Tags": ", ".join(t.name for t in (exp.tags or [])),
            "Wallet": "",  # Wallet name not eager-loaded in all contexts
            "Is Recurring": "Yes" if exp.recurring_rule_id else "No",
            "Receipt": "Yes" if exp.receipt_key else "No",
        })

    output.seek(0)
    return output


# ── PDF Export ────────────────────────────────────────────────────────────────

async def generate_pdf(
    expenses: list,
    user: User,
    title: str = "Expense Report",
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
) -> io.BytesIO:
    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        rightMargin=1.5 * cm,
        leftMargin=1.5 * cm,
        topMargin=2 * cm,
        bottomMargin=2 * cm,
    )

    styles = getSampleStyleSheet()
    accent_color = colors.HexColor("#4F46E5")

    title_style = ParagraphStyle("Title", parent=styles["Title"], textColor=accent_color, fontSize=20, spaceAfter=6)
    subtitle_style = ParagraphStyle("Subtitle", parent=styles["Normal"], textColor=colors.grey, fontSize=10)
    section_style = ParagraphStyle("Section", parent=styles["Heading2"], textColor=accent_color, spaceBefore=12)

    story = []

    # Header
    story.append(Paragraph(title, title_style))
    period = ""
    if date_from and date_to:
        period = f"{date_from.strftime('%b %d, %Y')} – {date_to.strftime('%b %d, %Y')}"
    elif date_from:
        period = f"From {date_from.strftime('%b %d, %Y')}"
    story.append(Paragraph(f"{user.display_name}  |  {user.base_currency}  |  {period}", subtitle_style))
    story.append(Paragraph(f"Generated: {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}", subtitle_style))
    story.append(HRFlowable(color=accent_color, thickness=2, width="100%"))
    story.append(Spacer(1, 0.4 * cm))

    # Summary section
    total = sum(e.base_amount for e in expenses)
    by_category: dict = {}
    for exp in expenses:
        cat_name = exp.category.name if exp.category else "Uncategorized"
        by_category[cat_name] = by_category.get(cat_name, Decimal("0")) + exp.base_amount

    story.append(Paragraph("Summary", section_style))
    summary_data = [
        ["Metric", "Value"],
        ["Total Expenses", str(len(expenses))],
        ["Total Amount", f"{user.base_currency} {total:.2f}"],
        ["Average per Expense", f"{user.base_currency} {(total/len(expenses) if expenses else 0):.2f}"],
        ["Top Category", max(by_category, key=by_category.get, default="—")],
    ]
    summary_table = Table(summary_data, colWidths=[8 * cm, 8 * cm])
    summary_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), accent_color),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F3F4F6")]),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#E5E7EB")),
        ("PADDING", (0, 0), (-1, -1), 6),
    ]))
    story.append(summary_table)
    story.append(Spacer(1, 0.4 * cm))

    # Category breakdown
    if by_category:
        story.append(Paragraph("Category Breakdown", section_style))
        cat_data = [["Category", f"Amount ({user.base_currency})", "% of Total"]]
        for cat, amount in sorted(by_category.items(), key=lambda x: x[1], reverse=True):
            pct = float(amount / total * 100) if total > 0 else 0
            cat_data.append([cat, f"{amount:.2f}", f"{pct:.1f}%"])

        cat_table = Table(cat_data, colWidths=[9 * cm, 5 * cm, 4 * cm])
        cat_table.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), accent_color),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F3F4F6")]),
            ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
            ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#E5E7EB")),
            ("PADDING", (0, 0), (-1, -1), 5),
        ]))
        story.append(cat_table)
        story.append(Spacer(1, 0.4 * cm))

    # Expense detail table
    story.append(Paragraph("Expense Details", section_style))
    expense_headers = ["Date", "Merchant", "Category", "Method", f"Amount ({user.base_currency})"]
    expense_data = [expense_headers]

    for exp in expenses:
        expense_data.append([
            exp.expense_date.strftime("%Y-%m-%d"),
            (exp.merchant_name or "—")[:25],
            (exp.category.name if exp.category else "—")[:20],
            exp.payment_method.value.replace("_", " ").title(),
            f"{exp.base_amount:.2f}",
        ])

    detail_table = Table(
        expense_data,
        colWidths=[3 * cm, 5.5 * cm, 4 * cm, 3.5 * cm, 3.5 * cm],
        repeatRows=1,
    )
    detail_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), accent_color),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 7.5),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F9FAFB")]),
        ("ALIGN", (4, 0), (4, -1), "RIGHT"),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#E5E7EB")),
        ("PADDING", (0, 0), (-1, -1), 4),
        ("FONTNAME", (0, 1), (-1, -1), "Helvetica"),
    ]))
    story.append(detail_table)

    # Footer
    story.append(Spacer(1, 0.5 * cm))
    story.append(HRFlowable(color=colors.HexColor("#E5E7EB"), thickness=1, width="100%"))
    story.append(Paragraph(
        "This report is generated by SpendWise. No banking credentials or account numbers are stored or transmitted.",
        ParagraphStyle("Footer", parent=styles["Normal"], fontSize=7, textColor=colors.grey)
    ))

    doc.build(story)
    buffer.seek(0)
    return buffer


# ── API Endpoints ─────────────────────────────────────────────────────────────

@router.get("/expenses.csv")
async def export_csv(
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    category_id: Optional[UUID] = None,
    wallet_id: Optional[UUID] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    expenses = await _fetch_expenses_for_export(
        current_user.id, db, date_from, date_to, category_id, wallet_id
    )
    csv_buffer = await generate_csv(expenses, current_user)
    filename = f"spendwise-export-{datetime.utcnow().strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        io.BytesIO(csv_buffer.read().encode("utf-8-sig")),  # BOM for Excel compatibility
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/expenses.pdf")
async def export_pdf(
    date_from: Optional[datetime] = None,
    date_to: Optional[datetime] = None,
    category_id: Optional[UUID] = None,
    wallet_id: Optional[UUID] = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    expenses = await _fetch_expenses_for_export(
        current_user.id, db, date_from, date_to, category_id, wallet_id
    )
    pdf_buffer = await generate_pdf(
        expenses, current_user,
        title="Expense Report",
        date_from=date_from,
        date_to=date_to,
    )
    filename = f"spendwise-report-{datetime.utcnow().strftime('%Y%m%d')}.pdf"
    return StreamingResponse(
        pdf_buffer,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


async def _fetch_expenses_for_export(
    user_id: UUID,
    db: AsyncSession,
    date_from: Optional[datetime],
    date_to: Optional[datetime],
    category_id: Optional[UUID],
    wallet_id: Optional[UUID],
) -> list:
    conditions = [Expense.user_id == user_id, Expense.is_deleted == False]
    if date_from:
        conditions.append(Expense.expense_date >= date_from)
    if date_to:
        conditions.append(Expense.expense_date <= date_to)
    if category_id:
        conditions.append(Expense.category_id == category_id)
    if wallet_id:
        conditions.append(Expense.wallet_id == wallet_id)

    result = await db.execute(
        select(Expense)
        .options(selectinload(Expense.category), selectinload(Expense.tags))
        .where(and_(*conditions))
        .order_by(Expense.expense_date.desc())
        .limit(5000)  # Cap export size
    )
    return result.scalars().all()