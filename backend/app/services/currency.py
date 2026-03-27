"""
Currency conversion service with caching.
"""
import json
from decimal import Decimal
from typing import Optional

import httpx
import structlog

from app.core.config import settings

logger = structlog.get_logger(__name__)
_rate_cache: dict = {}  # {base_currency: {rates: {...}, updated_at: timestamp}}


async def get_exchange_rates(base: str) -> dict:
    """Get exchange rates from cache or API."""
    import time
    cache = _rate_cache.get(base)
    if cache and time.time() - cache["ts"] < settings.EXCHANGE_RATE_CACHE_TTL:
        return cache["rates"]

    try:
        url = f"{settings.EXCHANGE_RATE_API_URL}/{base}"
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(url)
            r.raise_for_status()
            data = r.json()
            rates = data.get("rates", {})
            _rate_cache[base] = {"rates": rates, "ts": time.time()}
            return rates
    except Exception as e:
        logger.warning("Exchange rate fetch failed", error=str(e))
        return _rate_cache.get(base, {}).get("rates", {})


async def convert_currency(amount: Decimal, from_currency: str, to_currency: str) -> tuple[Decimal, Decimal]:
    """Returns (converted_amount, exchange_rate)."""
    if from_currency == to_currency:
        return amount, Decimal("1")

    rates = await get_exchange_rates(from_currency)
    rate = rates.get(to_currency)
    if not rate:
        logger.warning("Exchange rate not found, using 1:1", from_currency=from_currency, to_currency=to_currency)
        return amount, Decimal("1")

    rate_dec = Decimal(str(rate))
    return (amount * rate_dec).quantize(Decimal("0.0001")), rate_dec


async def refresh_exchange_rates():
    """Called by scheduler to pre-warm cache for common currencies."""
    major_currencies = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "INR", "SGD", "CHF", "CNY"]
    for currency in major_currencies:
        try:
            await get_exchange_rates(currency)
        except Exception as e:
            logger.warning("Cache refresh failed", currency=currency, error=str(e))