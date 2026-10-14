"""Phase 8 features: wardrobe analytics, trip packing, purchase analysis, reminders.

All deterministic. Packing and purchase analysis reuse the planner's availability
simulation and the outfit engine, so they never count clothes that won't be clean.
"""

import math
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import coverage, lifecycle, outfits, planner, weather
from .models import (
    BasketItemOutcome,
    BasketStatus,
    Garment,
    GarmentEvent,
    GarmentState,
    IroningPolicy,
    LaundryBasket,
    UserSettings,
)

# --- Analytics ------------------------------------------------------------------


def analytics(db: Session, user: str, today: date, days: int = 90) -> dict:
    garments = db.scalars(select(Garment).where(Garment.user_id == user, Garment.archived.is_(False))).all()
    by_id = {g.id: g for g in garments}
    since = today - timedelta(days=days - 1)
    worn = db.execute(
        select(GarmentEvent.garment_id, GarmentEvent.worn_on).where(
            GarmentEvent.user_id == user, GarmentEvent.kind == "worn",
            GarmentEvent.worn_on >= since, GarmentEvent.worn_on <= today,
        )
    ).all()
    per_garment = Counter(gid for gid, _ in worn if gid in by_id)

    # Weekly wear counts for the last 12 weeks (weeks start on Monday).
    this_week = today - timedelta(days=today.weekday())
    weeks = [this_week - timedelta(weeks=i) for i in range(11, -1, -1)]
    weekly = Counter((d - timedelta(days=d.weekday())) for _, d in worn)

    # Outfit repetition: the same set of 2+ garments worn on different days.
    per_day: dict[date, set[str]] = defaultdict(set)
    for gid, d in worn:
        per_day[d].add(gid)
    combos = Counter(frozenset(ids) for ids in per_day.values() if len(ids) >= 2)
    repeated = [
        {"garments": sorted(by_id[g].name for g in combo if g in by_id), "times": n}
        for combo, n in combos.most_common(5) if n >= 2
    ]

    def ref(g: Garment, value) -> dict:
        return {"id": g.id, "name": g.name, "category": g.category, "value": value}

    ranked = sorted(garments, key=lambda g: (per_garment[g.id], g.total_wears))
    baskets = db.scalars(
        select(LaundryBasket).where(LaundryBasket.user_id == user, LaundryBasket.status == BasketStatus.COMPLETED)
    ).all()
    baskets = [b for b in baskets if not b.is_ironing]
    recent = [b for b in baskets if b.completed_at and b.completed_at.date() >= since]
    washed = sum(1 for b in recent for i in b.items if i.outcome == BasketItemOutcome.WASHED)

    priced = [g for g in garments if g.purchase_price is not None]
    cpw = sorted(
        (ref(g, round(float(g.purchase_price) / max(1, g.total_wears), 2)) for g in priced),
        key=lambda r: r["value"], reverse=True,
    )

    categories: dict[str, dict] = defaultdict(lambda: {"total": 0, "ready": 0, "wears": 0})
    for g in garments:
        c = categories[g.category]
        c["total"] += 1
        c["ready"] += lifecycle.is_wearable(g)
        c["wears"] += per_garment[g.id]

    # Declutter candidates: owned for 2+ months but not worn in the last 3 (or ever).
    idle_cutoff = today - timedelta(days=90)
    declutter = sorted(
        (
            {
                "id": g.id, "name": g.name, "category": g.category,
                "last_worn_on": g.last_worn_on,
                "idle_days": (today - (g.last_worn_on or g.created_at.date())).days,
                "never_worn": g.last_worn_on is None,
            }
            for g in garments
            if g.created_at.date() <= today - timedelta(days=60)
            and (g.last_worn_on is None or g.last_worn_on < idle_cutoff)
        ),
        key=lambda r: -r["idle_days"],
    )[:12]

    return {
        "declutter": declutter,
        "period_days": days,
        "garments_total": len(garments),
        "garments_ready": sum(lifecycle.is_wearable(g) for g in garments),
        "wears_in_period": len(worn),
        "never_worn": sum(1 for g in garments if g.total_wears == 0),
        "most_worn": [ref(g, per_garment[g.id]) for g in reversed(ranked[-5:]) if per_garment[g.id]],
        "least_worn": [ref(g, per_garment[g.id]) for g in ranked[:5]],
        "weekly_wears": [{"week": w, "wears": weekly.get(w, 0)} for w in weeks],
        "repeated_outfits": repeated,
        "laundry_runs": len(recent),
        "garments_washed": washed,
        "last_laundry": max((b.completed_at for b in baskets if b.completed_at), default=None),
        "awaiting_ironing": sum(1 for g in garments if g.state == GarmentState.NEEDS_IRONING),
        "cost_per_wear": cpw[:5],
        "average_cost_per_wear": round(sum(r["value"] for r in cpw) / len(cpw), 2) if cpw else None,
        "categories": dict(sorted(categories.items())),
        "shortages": [c for c, v in sorted(categories.items()) if v["total"] >= 2 and v["ready"] == 0],
    }


# --- Packing ------------------------------------------------------------------------

DAILY = {"underwear", "socks", "vest"}
TOPS = {"shirt", "t-shirt"}
BOTTOMS = {"trousers", "jeans", "shorts", "skirt"}
LAYERS = {"jacket", "sweater"}


@dataclass
class PackingRequest:
    start: date
    nights: int
    activities: list[str]
    laundry_available: bool
    latitude: float | None = None
    longitude: float | None = None


def packing_list(db: Session, user: str, req: PackingRequest, today: date) -> dict:
    days = req.nights + 1
    cycle = min(days, 4) if req.laundry_available else days
    trip_dates = [req.start + timedelta(days=i) for i in range(days)]

    # Clothes that will be clean by departure, per the planner's simulation.
    sim = planner.Planner(db, user, today, max(1, (req.start - today).days + 1), today=today)
    ready = [
        s for s in sim.sims.values()
        if not s.dirty and s.available_from is not None and s.available_from <= req.start
        and not s.reserved_state
    ]

    lat = req.latitude if req.latitude is not None else sim.settings.latitude
    lon = req.longitude if req.longitude is not None else sim.settings.longitude
    forecast, weather_error = weather.safe_forecast(lat, lon)
    tags: set[str] = set()
    for d in trip_dates:
        if d in forecast:
            tags.update(forecast[d].tags)
    activities = {a.lower() for a in req.activities}

    def score(s: planner._Sim) -> tuple:
        g = s.g
        g_tags = {t.lower() for t in [*g.labels, *g.occasions]}
        weather_fit = 1 if (tags and set(g.weather) & tags) else (-1 if tags and g.weather else 0)
        return (-len(g_tags & activities), -weather_fit, s.needs_ironing, g.total_wears)

    groups: list[tuple[str, set[str], int]] = [
        ("Underwear, socks & vests", DAILY, cycle),
        ("Tops", TOPS, cycle),
        ("Bottoms", BOTTOMS, max(1, math.ceil(cycle / 3))),
    ]
    if req.nights:
        groups.append(("Nightwear", {"nightwear"}, max(1, math.ceil(min(req.nights, cycle) / 3))))
    if "gym" in activities:
        groups.append(("Activewear", {"activewear"}, max(1, math.ceil(days / 2))))
    formal = activities & {"office", "interview", "wedding", "party"}
    groups.append(("Shoes", {"shoes"}, 2 if (formal or "gym" in activities) and days > 1 else 1))
    if tags & {"Cold", "Rainy", "Windy", "Mild"} or (not tags and days >= 3):
        groups.append(("Layers", LAYERS, 1))
    if formal:
        groups.append(("Formal wear", {"suit", "dress"}, 1))

    sections = []
    owned = Counter(s.g.category for s in sim.sims.values())
    for title, cats, need in groups:
        if not any(owned[c] for c in cats):
            continue
        if cats is DAILY:
            # Each daily category is packed separately (e.g. 4 socks AND 4 underwear).
            for c in sorted(cats):
                if owned[c]:
                    sections.append(_section(c.capitalize(), [s for s in ready if s.g.category == c], need, score))
            continue
        sections.append(_section(title, [s for s in ready if s.g.category in cats], need, score))

    notes = []
    if tags:
        notes.append(f"Forecast for your trip: {', '.join(sorted(tags))}.")
    elif weather_error:
        notes.append(weather_error)
    elif lat is None:
        notes.append("Set a location to pack for the weather.")
    else:
        notes.append("Trip is beyond the 16-day forecast, so weather isn't considered.")
    if req.laundry_available and days > cycle:
        notes.append(f"Packed for {cycle} days, assuming you can do laundry during the trip.")
    to_iron = [s.g.name for sec in sections for s in sec.pop("_sims")]
    if to_iron:
        notes.append(f"Iron before you go: {', '.join(to_iron)}.")
    return {"days": days, "weather": sorted(tags), "sections": sections, "notes": notes}


def _section(title: str, candidates: list, need: int, key) -> dict:
    chosen = sorted(candidates, key=key)[:need]
    missing = need - len(chosen)
    return {
        "title": title,
        "needed": need,
        "garments": [s.g for s in chosen],
        "shortfall": (f"Only {len(chosen)} of {need} will be clean by departure" if missing > 0 else None),
        "_sims": [s for s in chosen if s.needs_ironing],
    }


# --- Before you buy -------------------------------------------------------------------


def purchase_analysis(db: Session, user: str, item: dict, today: date) -> dict:
    pool = list(db.scalars(select(Garment).where(Garment.user_id == user, Garment.archived.is_(False))))
    max_wears, iron = lifecycle.CATEGORY_DEFAULTS.get(item["category"], lifecycle.CATEGORY_DEFAULTS["other"])
    candidate = Garment(
        id="__candidate__", user_id=user, name=item.get("name") or f"New {item['category']}",
        category=item["category"], color=item.get("color"), pattern=item.get("pattern"),
        formality=item.get("formality"), labels=[], occasions=item.get("occasions") or [],
        seasons=[], weather=item.get("weather") or [], state=GarmentState.READY,
        max_wears_before_wash=max_wears, ironing_policy=iron or IroningPolicy.NOT_REQUIRED,
        total_wears=0, wears_since_wash=0, archived=False,
    )
    ctx = outfits.load_context(db, user, outfits.OutfitRequest(today=today))
    # Judged against everything owned (not just what's clean today).
    with_it = outfits.rank([*pool, candidate], ctx)
    new = [s for s in with_it if any(g is candidate for g in s.garments)]
    good = [s for s in new if s.score >= 70]
    key = outfits.color_key(candidate.color)
    similar = [
        g.name for g in pool
        if g.category == candidate.category and key is not None and outfits.color_key(g.color) == key
    ]
    same_category = [g for g in pool if g.category == candidate.category]
    slot = outfits.SLOT_OF.get(candidate.category)

    if slot is None:
        verdict = "This category isn't used in outfit suggestions, so its combinations can't be estimated."
    elif len(similar) >= 2:
        verdict = f"You already own {len(similar)} similar {candidate.color} {candidate.category} items. Consider whether you need another."
    elif not new:
        verdict = "It wouldn't complete any outfit with what you own yet (no matching tops, bottoms or shoes)."
    elif len(good) >= 3:
        verdict = f"Good fit: it creates {len(good)} strong outfits with clothes you already own."
    elif good:
        verdict = f"It creates {len(good)} strong outfit{'s' if len(good) > 1 else ''} with clothes you already own."
    else:
        verdict = f"It creates {len(new)} outfit{'s' if len(new) > 1 else ''}, but none look like strong matches."

    return {
        "new_outfits": len(new),
        "strong_outfits": len(good),
        "examples": [
            {"garments": [g.name for g in s.garments if g is not candidate], "score": s.score}
            for s in new[:3]
        ],
        "similar_owned": similar,
        "category_owned": len(same_category),
        "verdict": verdict,
    }


# --- Reminders -------------------------------------------------------------------------

DEFAULT_PREFS = {"laundry": True, "ironing": True, "plan": True, "events": True}


def reminders(db: Session, user: str, today: date, dashboard_warnings: list) -> list[dict]:
    s = db.get(UserSettings, user)
    prefs = {**DEFAULT_PREFS, **((s.notification_prefs if s else None) or {})}
    out: list[dict] = []
    if prefs["plan"]:
        cov = coverage.coverage(db, user, today)
        if cov["status"] in ("alert", "warning"):
            fix = f" Suggested: {cov['suggestions'][0]['title']}." if cov["suggestions"] else ""
            out.append({"group": "plan", "link": "/plan", "message": f"Clothes alert: {cov['headline']}{fix}"})
    group_of = {
        "basket_due": "laundry", "basket_overdue": "laundry", "basket_overrun": "laundry",
        "reserved_in_basket": "laundry", "ironing": "ironing", "shortage": "plan",
    }
    for w in dashboard_warnings:
        group = group_of.get(w.kind, "plan")
        if prefs[group]:
            link = f"/laundry/{w.basket_id}" if w.basket_id else ("/laundry" if group == "ironing" else "/plan")
            out.append({"group": group, "message": w.message, "link": link})

    result = planner.Planner(db, user, today, 2, today=today).run()
    for i, day in enumerate(result.days):
        when = "today" if i == 0 else "tomorrow"
        for slot in day.slots:
            if slot.entry is not None and slot.entry.status != "planned":
                continue
            if prefs["ironing"]:
                for p in slot.prep:
                    if p.startswith("Iron "):
                        out.append({"group": "ironing", "link": "/plan",
                                    "message": f"{p.split(' before ')[0][5:]} for {when}'s {slot.slot.title} still needs ironing."})
            if prefs["plan"] and slot.problems:
                out.append({"group": "plan", "link": "/plan",
                            "message": f"{when.capitalize()}'s {slot.slot.title}: {slot.problems[0]}"})
        if prefs["events"] and i == 1:
            for e in day.events:
                planned = any(s.slot.event is e and s.garment_ids for s in day.slots)
                needs_outfit = bool(e.garment_ids or e.occasion or e.formality)
                tail = " Your outfit is planned." if planned else (" No outfit is planned yet." if needs_outfit else "")
                out.append({"group": "events", "link": "/calendar", "message": f"Tomorrow: {e.title}.{tail}"})
    # Same message from two sources (e.g. ironing) only once.
    seen: set[str] = set()
    return [r for r in out if not (r["message"] in seen or seen.add(r["message"]))]
