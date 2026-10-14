from collections import Counter, defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import lifecycle
from ..auth import current_user
from ..db import get_db
from ..models import BasketStatus, Garment, GarmentState, LaundryBasket, utcnow
from ..schemas import Dashboard, Warning_
from ..serialize import baskets_out, garments_out

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

S = GarmentState


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'' if n == 1 else 's'}"


@router.get("", response_model=Dashboard)
def dashboard(
    today: date | None = None,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    """`today` should be the user's local date; the server's date is only a fallback."""
    today = today or date.today()
    now = utcnow()
    garments = db.scalars(
        select(Garment).where(Garment.user_id == user, Garment.archived.is_(False))
    ).all()
    all_baskets = db.scalars(select(LaundryBasket).where(LaundryBasket.user_id == user)).all()
    baskets = [b for b in all_baskets if not b.is_ironing]
    ironing_basket = next(
        (b for b in all_baskets if b.is_ironing and b.status != BasketStatus.COMPLETED), None
    )

    state_counts = Counter(g.state.value for g in garments)
    categories: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "wearable": 0})
    for g in garments:
        categories[g.category]["total"] += 1
        categories[g.category]["wearable"] += lifecycle.is_wearable(g)

    pending = sorted(
        (b for b in baskets if b.status == BasketStatus.PENDING),
        key=lambda b: (b.scheduled_for is None, b.scheduled_for or today),
    )
    in_progress = [b for b in baskets if b.status == BasketStatus.IN_PROGRESS]
    due_today = [b for b in pending if b.scheduled_for == today]
    recent_cutoff = now - timedelta(days=14)
    completed = sorted(
        (b for b in baskets if b.status == BasketStatus.COMPLETED and b.completed_at >= recent_cutoff),
        key=lambda b: b.completed_at,
        reverse=True,
    )

    warnings: list[Warning_] = []
    for b in due_today:
        warnings.append(Warning_(kind="basket_due", basket_id=b.id,
                                 message=f"Your {b.name} basket is due today."))
    for b in pending:
        if b.scheduled_for and b.scheduled_for < today:
            warnings.append(Warning_(
                kind="basket_overdue", basket_id=b.id,
                message=f"{b.name} was scheduled for {b.scheduled_for:%a %d %b} and hasn't been started.",
            ))
    for b in in_progress:
        if b.expected_completion_at and b.expected_completion_at < now:
            warnings.append(Warning_(kind="basket_overrun", basket_id=b.id,
                                     message=f"{b.name} is still marked In Progress."))
    for b in pending + in_progress:
        for item in b.active_items:
            if item.previous_state == S.RESERVED:
                warnings.append(Warning_(
                    kind="reserved_in_basket", basket_id=b.id, garment_id=item.garment_id,
                    message=f"'{item.garment.name}' in {b.name} is reserved for an upcoming event.",
                ))
    ironing = [g for g in garments if g.state == S.NEEDS_IRONING]
    if ironing:
        verb = "needs" if len(ironing) == 1 else "need"
        warnings.append(Warning_(kind="ironing", message=(
            f"{_plural(len(ironing), 'washed garment')} still {verb} ironing."
        )))
    for cat, c in sorted(categories.items()):
        # Only flag categories where the user owns several items but none are ready.
        if c["total"] >= 2 and c["wearable"] == 0 and lifecycle.CATEGORY_DEFAULTS.get(cat, (1,))[0] is not None:
            warnings.append(Warning_(kind="shortage",
                                     message=f"No {cat} ready to wear (you own {c['total']})."))

    return Dashboard(
        today=today,
        garments_total=len(garments),
        garments_wearable=sum(c["wearable"] for c in categories.values()),
        state_counts={s.value: state_counts.get(s.value, 0) for s in GarmentState},
        category_counts=dict(sorted(categories.items())),
        baskets_pending=baskets_out(db, pending),
        baskets_due_today=baskets_out(db, due_today),
        baskets_in_progress=baskets_out(db, in_progress),
        baskets_recently_completed=baskets_out(db, completed[:10]),
        ironing_basket=baskets_out(db, [ironing_basket])[0] if ironing_basket else None,
        drying=garments_out(db, [g for g in garments if g.state == S.DRYING]),
        needs_ironing=garments_out(db, ironing),
        needs_laundry=garments_out(db, [g for g in garments if g.state == S.NEEDS_LAUNDRY]),
        warnings=warnings,
    )
