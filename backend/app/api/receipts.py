"""
Receipts API - Upload + OCR extraction
Supports Tesseract (local), Google Vision, AWS Textract
"""
import io
import re
from typing import Optional
from uuid import UUID

import structlog
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import get_current_user
from app.core.config import settings
from app.core.database import get_db
from app.core.exceptions import AppException
from app.models.models import Expense, User
from app.services import upload_receipt

logger = structlog.get_logger(__name__)
router = APIRouter()

MAX_SIZE_BYTES = settings.MAX_RECEIPT_SIZE_MB * 1024 * 1024
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"}


@router.post("/upload")
async def upload_receipt_file(
    file: UploadFile = File(...),
    expense_id: Optional[str] = Form(None),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Upload receipt image, run OCR, return extracted fields.
    Client can review and attach to an expense.
    """
    if file.content_type not in ALLOWED_TYPES:
        raise AppException(f"Unsupported file type: {file.content_type}", "INVALID_FILE_TYPE")

    contents = await file.read()
    if len(contents) > MAX_SIZE_BYTES:
        raise AppException(f"File too large. Max {settings.MAX_RECEIPT_SIZE_MB}MB.", "FILE_TOO_LARGE")

    # Upload to object storage
    receipt_key = await upload_receipt(contents, file.content_type, str(current_user.id))

    # OCR extraction
    ocr_result = await _extract_receipt_data(contents, file.content_type)

    # If expense_id provided, attach receipt
    if expense_id:
        result = await db.execute(
            select(Expense).where(Expense.id == expense_id, Expense.user_id == current_user.id)
        )
        expense = result.scalar_one_or_none()
        if expense:
            expense.receipt_key = receipt_key
            expense.ocr_raw = ocr_result.get("raw")
            expense.ocr_confidence = ocr_result.get("confidence")

    logger.info("Receipt uploaded", user_id=str(current_user.id), key=receipt_key)

    return {
        "receipt_key": receipt_key,
        "extracted": {
            "amount": ocr_result.get("amount"),
            "merchant_name": ocr_result.get("merchant"),
            "date": ocr_result.get("date"),
            "currency": ocr_result.get("currency"),
            "line_items": ocr_result.get("line_items", []),
        },
        "confidence": ocr_result.get("confidence", 0),
        "raw_text": ocr_result.get("raw_text", ""),
    }


async def _extract_receipt_data(image_bytes: bytes, content_type: str) -> dict:
    """Route to appropriate OCR backend."""
    if settings.OCR_BACKEND == "tesseract":
        return await _tesseract_ocr(image_bytes)
    elif settings.OCR_BACKEND == "google_vision":
        return await _google_vision_ocr(image_bytes)
    elif settings.OCR_BACKEND == "aws_textract":
        return await _textract_ocr(image_bytes)
    return {}


async def _tesseract_ocr(image_bytes: bytes) -> dict:
    """Local Tesseract OCR - zero cost, runs offline."""
    try:
        import pytesseract
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        # Pre-process: increase contrast for better OCR
        from PIL import ImageEnhance, ImageFilter
        img = img.filter(ImageFilter.SHARPEN)
        img = ImageEnhance.Contrast(img).enhance(1.5)

        raw_text = pytesseract.image_to_string(img, lang="eng")
        data = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)

        avg_conf = sum(c for c in data["conf"] if c > 0) / max(1, len([c for c in data["conf"] if c > 0]))

        parsed = _parse_receipt_text(raw_text)
        parsed["raw_text"] = raw_text
        parsed["confidence"] = round(avg_conf / 100, 2)
        return parsed
    except Exception as e:
        logger.warning("Tesseract OCR failed", error=str(e))
        return {"confidence": 0, "raw_text": ""}


async def _google_vision_ocr(image_bytes: bytes) -> dict:
    """Google Vision API OCR - higher accuracy."""
    try:
        from google.cloud import vision
        client = vision.ImageAnnotatorClient()
        image = vision.Image(content=image_bytes)
        response = client.text_detection(image=image)
        texts = response.text_annotations
        if not texts:
            return {}
        raw_text = texts[0].description
        parsed = _parse_receipt_text(raw_text)
        parsed["raw_text"] = raw_text
        parsed["confidence"] = 0.90  # Vision API is high quality
        return parsed
    except Exception as e:
        logger.warning("Google Vision OCR failed", error=str(e))
        return await _tesseract_ocr(image_bytes)  # Fallback


async def _textract_ocr(image_bytes: bytes) -> dict:
    """AWS Textract - structured receipt parsing."""
    try:
        import boto3
        client = boto3.client("textract", region_name=settings.AWS_TEXTRACT_REGION)
        response = client.analyze_expense(Document={"Bytes": image_bytes})
        result = {"line_items": [], "confidence": 0.92}
        fields = response.get("ExpenseDocuments", [{}])[0].get("SummaryFields", [])
        for f in fields:
            label = f.get("LabelDetection", {}).get("Text", "").lower()
            value = f.get("ValueDetection", {}).get("Text", "")
            if "total" in label:
                result["amount"] = _extract_amount(value)
            elif "merchant" in label or "vendor" in label:
                result["merchant"] = value
            elif "date" in label:
                result["date"] = value
        line_items = response.get("ExpenseDocuments", [{}])[0].get("LineItemGroups", [])
        for group in line_items:
            for item in group.get("LineItems", []):
                li = {}
                for field in item.get("LineItemExpenseFields", []):
                    t = field.get("Type", {}).get("Text", "").lower()
                    v = field.get("ValueDetection", {}).get("Text", "")
                    if t in ("item", "product"):
                        li["name"] = v
                    elif t == "price":
                        li["amount"] = _extract_amount(v)
                if li:
                    result["line_items"].append(li)
        return result
    except Exception as e:
        logger.warning("Textract OCR failed", error=str(e))
        return await _tesseract_ocr(image_bytes)


def _parse_receipt_text(text: str) -> dict:
    """Heuristic parser for raw OCR text."""
    result = {}
    lines = [l.strip() for l in text.split("\n") if l.strip()]

    # Amount: find largest dollar amount (likely total)
    amounts = []
    for line in lines:
        matches = re.findall(r'\$?\s*(\d{1,6}[.,]\d{2})', line)
        for m in matches:
            try:
                amounts.append(float(m.replace(",", ".")))
            except ValueError:
                pass
    if amounts:
        result["amount"] = max(amounts)  # Total is usually the largest amount

    # Merchant: first non-empty line is often the store name
    if lines:
        result["merchant"] = lines[0][:100]

    # Date: look for date patterns
    date_pattern = re.compile(r'\b(\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}|\w+ \d{1,2},?\s*\d{4})\b')
    for line in lines:
        m = date_pattern.search(line)
        if m:
            result["date"] = m.group(1)
            break

    # Currency detection
    if "$" in text or "USD" in text:
        result["currency"] = "USD"
    elif "€" in text or "EUR" in text:
        result["currency"] = "EUR"
    elif "£" in text or "GBP" in text:
        result["currency"] = "GBP"
    elif "₹" in text or "INR" in text:
        result["currency"] = "INR"

    return result


def _extract_amount(s: str) -> Optional[float]:
    match = re.search(r'[\d,]+\.?\d*', s.replace(",", ""))
    if match:
        try:
            return float(match.group())
        except ValueError:
            pass
    return None