"""Will my clean clothes last? A forward check of every routine until the next laundry.

The check covers a week, or until the next laundry is back and dry if that is later
(capped at three weeks). That is the window in which clothes can't be replenished, so
it's the one that matters. Everything is deterministic: the planner's simulation finds
the first day each routine requirement runs short, and suggested fixes are re-simulated
before they're offered, so a suggestion never promises more than it delivers.
"""

import math
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .lifecycle import CATEGORY_DEFAULTS
from .models import BasketStatus, Garment, GarmentState, LaundryBasket
from .planner import WEEKDAYS, Planner, _cat_title, _d

MIN_DAYS = 7
MAX_DAYS = 21


def next_laundry(probe: Planner, db: Session, user: str, today: date) -> tuple[date | None, str | None]:
    """The earliest date clean clothes come back, and why."""
    options: list[tuple[date, str]] = []
    baskets = db.scalars(
        select(LaundryBasket).where(
            LaundryBasket.user_id == user, LaundryBasket.status != BasketStatus.COMPLETED
        )
    ).all()
    for b in baskets:
        if b.is_ironing or not b.active_items:
            continue
        back = probe.basket_return(b)
        if back is not None:
            options.append((back, f"'{b.name}' is back"))
    for i in range(7):
        d = today + timedelta(days=i)
        if d.weekday() in (probe.settings.laundry_weekdays or []):
            options.append((d + timedelta(days=probe.drying), f"your {WEEKDAYS[d.weekday()]} laundry is dry"))
            break
    return min(options) if options else (None, None)


def _shortages(planner: Planner) -> list[dict]:
    out = []
    for need in planner.needs.values():
        if need.satisfied < need.required:
            out.append({
                "routine": need.routine.name,
                "category": need.category,
                "required": need.required,
                "available": need.satisfied,
                "missing": need.required - need.satisfied,
                "first_short": need.first_short,
                "mandatory": need.routine.mandatory,
            })
    out.sort(key=lambda s: (s["first_short"] or date.max, s["routine"]))
    return out


def recommended_stock(db: Session, user: str, probe: Planner) -> list[dict]:
    """How many of each item a routine needs to get through one laundry cycle."""
    laundry_days = sorted(probe.settings.laundry_weekdays or [])
    if laundry_days:
        gaps = [(laundry_days[(i + 1) % len(laundry_days)] - d) % 7 or 7 for i, d in enumerate(laundry_days)]
        cycle = max(gaps)
    else:
        cycle = 7
    cycle += probe.drying
    garments = db.scalars(select(Garment).where(Garment.user_id == user, Garment.archived.is_(False))).all()
    out = []
    for r in probe.routines:
        for req in r.requirements or []:
            category = req.get("category", "")
            qty = max(1, int(req.get("quantity") or 1))
            min_f = req.get("min_formality")
            owned = [g for g in garments if g.category == category and (min_f is None or g.formality is None or g.formality >= min_f)]
            limits = [g.max_wears_before_wash for g in owned if g.max_wears_before_wash]
            default_limit = CATEGORY_DEFAULTS.get(category, CATEGORY_DEFAULTS["other"])[0]
            if req.get("reuse") == "fixed" or (owned and not limits) or (not owned and default_limit is None):
                needed = qty  # never needs washing by wear count (e.g. shoes)
            else:
                limit = (sum(limits) / len(limits)) if limits else (default_limit or 1)
                uses = qty * len(r.weekdays or []) * cycle / 7
                needed = max(qty, math.ceil(uses / limit))
            out.append({
                "routine": r.name,
                "category": category,
                "needed": needed,
                "owned": len(owned),
                "ok": len(owned) >= needed,
                "cycle_days": cycle,
            })
    return out


def coverage(db: Session, user: str, today: date) -> dict:
    probe = Planner(db, user, today, 1, today=today)
    back_on, why = next_laundry(probe, db, user, today)
    if back_on and (back_on - today).days + 1 > MIN_DAYS:
        days = min(MAX_DAYS, (back_on - today).days + 1)
        horizon = f"until {why} ({_d(back_on)})"
    else:
        days = MIN_DAYS
        horizon = "for the next 7 days"
    until = today + timedelta(days=days - 1)
    dates = {today + timedelta(days=i) for i in range(days)}

    planner = Planner(db, user, today, days, today=today, regenerate=dates)
    planner.run()
    shortages = _shortages(planner)
    serious = [s for s in shortages if s["mandatory"]]
    stock = recommended_stock(db, user, probe)

    if not planner.routines:
        status, headline = "none", "Add your routines so I can check whether your clothes will last."
    elif not shortages:
        status = "ok"
        headline = f"You're covered: your clean clothes meet every routine {horizon}."
    else:
        status = "alert" if serious else "warning"
        first = min(s["first_short"] for s in shortages if s["first_short"])
        cats = list(dict.fromkeys(_cat_title(s["category"], 2) for s in shortages))
        headline = f"Not enough clean {', '.join(cats)}: you'll run short from {_d(first)}."

    return {
        "today": today,
        "until": until,
        "days": days,
        "horizon": horizon,
        "next_laundry": back_on,
        "next_laundry_reason": why,
        "status": status,
        "headline": headline,
        "shortages": shortages,
        "suggestions": _suggestions(db, user, today, days, planner, shortages, stock) if shortages else [],
        "stock": stock,
    }


def _suggestions(db: Session, user: str, today: date, days: int, planner: Planner,
                 shortages: list[dict], stock: list[dict]) -> list[dict]:
    out: list[dict] = []
    short_cats = {s["category"] for s in shortages}
    first_short = min((s["first_short"] for s in shortages if s["first_short"]), default=today)

    # 1. Unscheduled laundry baskets holding clothes we're short of.
    for b in db.scalars(
        select(LaundryBasket).where(LaundryBasket.user_id == user, LaundryBasket.status == BasketStatus.PENDING)
    ):
        if b.is_ironing or b.scheduled_for is not None:
            continue
        hits = [i.garment for i in b.active_items if i.garment.category in short_cats]
        if hits:
            when = max(today, first_short - timedelta(days=planner.drying + 1))
            out.append({
                "kind": "schedule",
                "title": f"Schedule '{b.name}' for {_d(when)}",
                "detail": f"It holds {len(hits)} of the items you're short of, but has no laundry date yet.",
                "basket_id": b.id,
                "wash_on": when,
                "garment_ids": [],
            })

    # 2. Wash the dirty clothes that are needed, early enough to be dry in time.
    dirty = [
        s.g for s in planner.sims_initial.values()
        if s.g.state == GarmentState.NEEDS_LAUNDRY and s.g.category in short_cats
    ]
    if dirty:
        wash_on = max(today, first_short - timedelta(days=planner.drying))
        trial = Planner(db, user, today, days, today=today, regenerate=planner.regenerate,
                        wash_overrides={g.id: wash_on for g in dirty})
        trial.run()
        before = sum(s["missing"] for s in shortages)
        after = sum(s["missing"] for s in _shortages(trial))
        back = wash_on + timedelta(days=planner.drying)
        counts = {}
        for g in dirty:
            counts[g.category] = counts.get(g.category, 0) + 1
        what = ", ".join(f"{n} {_cat_title(c, n)}" for c, n in counts.items())
        late = " (that's the earliest possible, so a day or two may still be short)" if back > first_short else ""
        if after < before:
            out.append({
                "kind": "wash",
                "title": f"Wash {what} on {_d(wash_on)}",
                "detail": f"Back by {_d(back)}{late}. This fixes {before - after} of {before} missing item(s).",
                "basket_id": None,
                "wash_on": wash_on,
                "garment_ids": [g.id for g in dirty],
            })

    # 3. Not enough owned to get through a laundry cycle at all.
    for s in stock:
        if not s["ok"] and s["category"] in short_cats:
            out.append({
                "kind": "stock",
                "title": f"Own more {_cat_title(s['category'], 2)}",
                "detail": f"{s['routine']} uses about {s['needed']} between laundries ({s['cycle_days']} days); you have {s['owned']}.",
                "basket_id": None,
                "wash_on": None,
                "garment_ids": [],
            })
    return out
