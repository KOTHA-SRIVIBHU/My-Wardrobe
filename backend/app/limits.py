"""Abuse protection for an open-sign-up deployment.

- A per-user request rate limit (in memory: the free hosting runs a single instance).
- A per-user daily AI allowance stored in the database, so one account can't use up
  the shared free Groq quota. It only counts successful AI calls.
"""

import threading
import time
from collections import defaultdict, deque
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import date

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .ai import AIUnavailable
from .config import settings
from .models import AiUsage


class RateLimiter:
    """Sliding-window limit per key."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str, limit: int, window: float = 60.0) -> None:
        if limit <= 0:  # 0 disables (tests, local use)
            return
        now = time.monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] > window:
                hits.popleft()
            if len(hits) >= limit:
                retry = int(window - (now - hits[0])) + 1
                raise HTTPException(
                    429, f"Too many requests. Please wait {retry} s and try again.",
                    headers={"Retry-After": str(retry)},
                )
            hits.append(now)


limiter = RateLimiter()


def check_rate(user_id: str) -> None:
    limiter.check(f"user:{user_id}", settings.rate_limit_per_minute)


def ai_used_today(db: Session, user_id: str) -> int:
    row = db.scalars(select(AiUsage).where(AiUsage.user_id == user_id, AiUsage.day == date.today())).first()
    return row.count if row else 0


@contextmanager
def ai_allowance(db: Session, user_id: str) -> Iterator[None]:
    """Wrap one AI call: refuse when today's allowance is used up, count it on success."""
    limit = settings.ai_daily_limit
    today = date.today()
    row = db.scalars(select(AiUsage).where(AiUsage.user_id == user_id, AiUsage.day == today)).first()
    if limit > 0 and row is not None and row.count >= limit:
        raise AIUnavailable(
            f"You've used today's {limit} AI requests. They reset tomorrow; everything else keeps working.",
            "ai_user_limit",
        )
    yield
    if row is None:
        row = AiUsage(user_id=user_id, day=today, count=0)
        db.add(row)
    row.count += 1
    db.commit()
