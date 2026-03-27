"""
Rate limiter - simple in-memory decorator.
Used by auth endpoints to prevent brute force attacks.
"""
import time
import functools
from collections import defaultdict
from typing import Optional

from fastapi import HTTPException, Request, status

_call_log: dict = defaultdict(list)


def rate_limit(max_calls: int = 10, period: int = 60):
    """Simple decorator-based rate limiter. Use Redis-based in production."""
    def decorator(func):
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            request: Optional[Request] = kwargs.get("request") or next(
                (a for a in args if isinstance(a, Request)), None
            )
            if request:
                ip = request.client.host if request.client else "unknown"
                key = f"{func.__name__}:{ip}"
                now = time.time()
                _call_log[key] = [t for t in _call_log[key] if now - t < period]
                if len(_call_log[key]) >= max_calls:
                    raise HTTPException(
                        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                        detail="Rate limit exceeded. Please wait before trying again."
                    )
                _call_log[key].append(now)
            return await func(*args, **kwargs)
        return wrapper
    return decorator