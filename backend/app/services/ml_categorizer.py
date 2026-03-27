"""
ML Auto-Categorization Pipeline
- Edge (offline): TF-Lite model + keyword rules for on-device inference
- Cloud (optional): Remote model for improved accuracy
- Graceful fallback: rules → edge model → cloud
"""
import asyncio
import json
import re
from pathlib import Path
from typing import Optional
from uuid import UUID

import numpy as np
import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.models import Category

logger = structlog.get_logger(__name__)

# ── Default keyword rules (offline, zero-latency) ─────────────────────────────
# Maps merchant keywords/patterns → category names
KEYWORD_RULES: dict[str, list[str]] = {
    "Food & Dining": [
        "restaurant", "cafe", "coffee", "pizza", "burger", "sushi", "mcdonald",
        "starbucks", "subway", "dominos", "kfc", "bakery", "grill", "dining",
        "eat", "food", "lunch", "dinner", "breakfast", "bistro", "deli",
    ],
    "Groceries": [
        "grocery", "supermarket", "walmart", "target", "costco", "kroger",
        "safeway", "whole foods", "trader joe", "aldi", "lidl", "market",
        "mart", "fresh", "produce",
    ],
    "Transportation": [
        "uber", "lyft", "taxi", "cab", "bus", "metro", "subway", "train",
        "amtrak", "airline", "flight", "airport", "fuel", "gas station",
        "shell", "bp", "exxon", "chevron", "parking", "toll",
    ],
    "Shopping": [
        "amazon", "ebay", "etsy", "mall", "store", "shop", "retail",
        "clothing", "fashion", "apparel", "shoes", "electronics", "best buy",
        "apple store", "h&m", "zara", "nike", "adidas",
    ],
    "Healthcare": [
        "pharmacy", "cvs", "walgreens", "hospital", "clinic", "doctor",
        "medical", "dental", "optician", "health", "prescription", "lab",
    ],
    "Entertainment": [
        "netflix", "spotify", "hulu", "disney", "cinema", "movie", "theater",
        "concert", "game", "steam", "playstation", "xbox", "arcade", "museum",
        "theme park", "festival",
    ],
    "Utilities": [
        "electric", "water", "gas", "internet", "broadband", "phone",
        "telecom", "att", "verizon", "t-mobile", "comcast", "spectrum",
    ],
    "Housing": [
        "rent", "mortgage", "lease", "landlord", "property", "real estate",
        "airbnb", "hotel", "accommodation",
    ],
    "Education": [
        "school", "university", "college", "tuition", "course", "udemy",
        "coursera", "book", "textbook", "library", "tutoring",
    ],
    "Financial": [
        "bank", "atm", "fee", "interest", "insurance", "invest", "stock",
        "crypto", "transfer", "payment", "loan", "credit",
    ],
    "Fitness": [
        "gym", "fitness", "yoga", "pilates", "crossfit", "sport", "swimming",
        "running", "peloton", "planet fitness",
    ],
    "Travel": [
        "hotel", "resort", "hostel", "booking.com", "expedia", "kayak",
        "visa", "passport", "tour", "excursion", "cruise",
    ],
    "Subscriptions": [
        "subscription", "membership", "monthly", "annual", "premium",
        "pro plan", "saas", "software",
    ],
}


class KeywordMatcher:
    """Fast O(1) keyword lookup using pre-built reverse index."""

    def __init__(self):
        self._index: dict[str, str] = {}  # keyword → category name
        for category, keywords in KEYWORD_RULES.items():
            for kw in keywords:
                self._index[kw.lower()] = category

    def match(self, text: str) -> Optional[tuple[str, float]]:
        """Returns (category_name, confidence) or None."""
        text_lower = text.lower().strip()
        # Exact keyword match
        for kw, cat in self._index.items():
            if kw in text_lower:
                # Confidence based on match specificity
                confidence = min(0.95, 0.6 + len(kw) / 20)
                return cat, confidence
        return None


# ── TF-Lite Edge Model (optional, loaded lazily) ──────────────────────────────

class EdgeMLModel:
    """
    Thin wrapper around a TF-Lite model for on-device categorization.
    Model file: assets/categorizer.tflite (included in mobile app)
    Server uses same model file for consistency.
    """
    _instance = None
    _interpreter = None
    _labels: list[str] = []
    _vectorizer = None

    @classmethod
    def get(cls) -> "EdgeMLModel":
        if cls._instance is None:
            cls._instance = cls()
            cls._instance._load()
        return cls._instance

    def _load(self):
        model_path = Path(__file__).parent.parent / "assets" / "categorizer.tflite"
        vocab_path = Path(__file__).parent.parent / "assets" / "vocab.json"
        labels_path = Path(__file__).parent.parent / "assets" / "labels.json"

        if not model_path.exists():
            logger.warning("TF-Lite model not found, using keyword fallback only")
            return

        try:
            import tflite_runtime.interpreter as tflite
            self._interpreter = tflite.Interpreter(model_path=str(model_path))
            self._interpreter.allocate_tensors()

            with open(vocab_path) as f:
                self._vocab = json.load(f)
            with open(labels_path) as f:
                self._labels = json.load(f)

            logger.info("TF-Lite edge model loaded", labels=len(self._labels))
        except ImportError:
            logger.warning("tflite_runtime not installed, using keyword fallback")
        except Exception as e:
            logger.error("Failed to load TF-Lite model", error=str(e))

    def _text_to_vector(self, text: str, max_len: int = 32) -> np.ndarray:
        """Simple bag-of-words tokenizer matching mobile app's preprocessing."""
        tokens = re.findall(r'\w+', text.lower())[:max_len]
        vec = np.zeros(max_len, dtype=np.float32)
        for i, tok in enumerate(tokens):
            if tok in self._vocab:
                vec[i] = self._vocab[tok]
        return vec

    def predict(self, text: str) -> Optional[tuple[str, float]]:
        if not self._interpreter or not self._labels:
            return None
        try:
            input_data = self._text_to_vector(text).reshape(1, -1)
            input_details = self._interpreter.get_input_details()
            output_details = self._interpreter.get_output_details()
            self._interpreter.set_tensor(input_details[0]['index'], input_data)
            self._interpreter.invoke()
            output = self._interpreter.get_tensor(output_details[0]['index'])[0]
            best_idx = int(np.argmax(output))
            confidence = float(output[best_idx])
            if confidence < 0.5:
                return None
            return self._labels[best_idx], confidence
        except Exception as e:
            logger.error("Edge model inference failed", error=str(e))
            return None


# ── Cloud ML (optional) ───────────────────────────────────────────────────────

async def _cloud_predict(text: str) -> Optional[tuple[str, float]]:
    if not settings.CLOUD_ML_ENABLED or not settings.CLOUD_ML_ENDPOINT:
        return None
    import httpx
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.post(settings.CLOUD_ML_ENDPOINT, json={"text": text})
            r.raise_for_status()
            data = r.json()
            return data.get("category"), data.get("confidence")
    except Exception as e:
        logger.warning("Cloud ML prediction failed", error=str(e))
        return None


# ── Main entry point ──────────────────────────────────────────────────────────

_keyword_matcher = KeywordMatcher()


async def suggest_category_and_tags(
    merchant: Optional[str],
    notes: Optional[str],
    user_id: UUID,
    db: AsyncSession,
) -> Optional[dict]:
    """
    Returns {category_id, category_name, confidence, tags} or None.
    Pipeline: keywords → edge model → cloud → None
    """
    combined_text = " ".join(filter(None, [merchant, notes])).strip()
    if not combined_text:
        return None

    predicted_name: Optional[str] = None
    confidence: float = 0.0

    # Step 1: Fast keyword matching
    kw_result = _keyword_matcher.match(combined_text)
    if kw_result:
        predicted_name, confidence = kw_result

    # Step 2: Edge model (higher accuracy)
    if not predicted_name or confidence < 0.75:
        edge = EdgeMLModel.get()
        edge_result = edge.predict(combined_text)
        if edge_result and edge_result[1] > confidence:
            predicted_name, confidence = edge_result

    # Step 3: Cloud (async, only if needed)
    if (not predicted_name or confidence < 0.60) and settings.CLOUD_ML_ENABLED:
        cloud_result = await _cloud_predict(combined_text)
        if cloud_result and cloud_result[1] and cloud_result[1] > confidence:
            predicted_name, confidence = cloud_result

    if not predicted_name:
        return None

    # Resolve category_id from name (user categories first, then system)
    result = await db.execute(
        select(Category).where(
            Category.name == predicted_name,
            (Category.user_id == user_id) | (Category.user_id.is_(None))
        ).order_by(Category.user_id.nullslast())
    )
    category = result.scalar_one_or_none()

    if not category:
        return None

    # Suggest tags from KEYWORD_RULES keywords found in text
    suggested_tags = _extract_tag_suggestions(combined_text)

    return {
        "category_id": str(category.id),
        "category_name": category.name,
        "confidence": round(confidence, 4),
        "tags": suggested_tags,
    }


def _extract_tag_suggestions(text: str) -> list[str]:
    """Extract meaningful tags from transaction text."""
    text_lower = text.lower()
    tags = []

    tag_patterns = {
        "work": ["business", "office", "client", "meeting", "conference"],
        "personal": ["personal", "family", "home"],
        "online": ["amazon", "ebay", "online", ".com", "website"],
        "recurring": ["subscription", "monthly", "annual", "membership"],
        "travel": ["hotel", "flight", "trip", "vacation", "airbnb"],
        "health": ["medical", "pharmacy", "doctor", "gym", "fitness"],
    }

    for tag, patterns in tag_patterns.items():
        if any(p in text_lower for p in patterns):
            tags.append(tag)

    return tags[:3]  # Max 3 suggested tags


# ── Training data collection (for cloud model improvement) ────────────────────

async def record_user_correction(
    expense_id: UUID,
    ml_predicted: Optional[str],
    user_chosen: str,
    merchant: Optional[str],
    notes: Optional[str],
):
    """
    Records when a user overrides ML suggestion.
    Used to improve the cloud model (GDPR-safe: no PII, only category labels + text).
    """
    if not settings.CLOUD_ML_ENABLED:
        return
    # In production: publish to a message queue for async training pipeline
    logger.info(
        "ML correction recorded",
        predicted=ml_predicted,
        chosen=user_chosen,
        text_len=len(f"{merchant or ''} {notes or ''}"),
    )