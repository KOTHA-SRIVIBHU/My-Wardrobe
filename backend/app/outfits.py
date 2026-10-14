"""Deterministic outfit generation and scoring.

Only garments that are wearable right now are ever considered, so availability rules
can't be bypassed. Scores are explainable: every outfit carries a per-factor breakdown
and plain-language reasons. AI is used only, optionally, to phrase explanations.
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta
from itertools import combinations

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import lifecycle
from .models import Garment, GarmentEvent, OutfitFeedback

SLOT_OF = {
    "shirt": "top", "t-shirt": "top",
    "trousers": "bottom", "jeans": "bottom", "shorts": "bottom", "skirt": "bottom",
    "dress": "onepiece", "suit": "onepiece",
    "jacket": "layer", "sweater": "layer",
    "shoes": "shoes",
}
LAYER_WEATHER = {"Cold", "Mild", "Windy", "Rainy"}
WARM_WEATHER = {"Hot", "Warm", "Humid"}
PER_SLOT = 12  # best garments per slot kept for combination search
MAX_REUSE = 2  # a garment appears in at most this many suggestions

# --- Colour harmony -------------------------------------------------------------

NEUTRALS = {
    "black", "white", "off-white", "grey", "gray", "charcoal", "navy", "beige", "cream",
    "ivory", "khaki", "tan", "brown", "camel", "stone", "denim", "taupe", "silver",
}
HUES = {
    "red": 0, "burgundy": 345, "maroon": 345, "wine": 345, "coral": 15, "rust": 20,
    "orange": 30, "peach": 25, "mustard": 45, "gold": 48, "yellow": 55, "olive": 75,
    "lime": 90, "green": 120, "mint": 150, "emerald": 140, "teal": 175, "turquoise": 175,
    "aqua": 180, "cyan": 185, "sky blue": 200, "light blue": 205, "blue": 220,
    "royal blue": 225, "indigo": 245, "lavender": 270, "purple": 275, "violet": 280,
    "lilac": 285, "magenta": 310, "pink": 330, "rose": 340,
}
_COLOR_WORDS = sorted([*NEUTRALS, *HUES], key=len, reverse=True)


def color_key(color: str | None) -> str | None:
    if not color:
        return None
    c = color.lower()
    return next((w for w in _COLOR_WORDS if w in c), None)


def color_pair_score(a: str | None, b: str | None) -> float:
    ka, kb = color_key(a), color_key(b)
    if ka is None or kb is None:
        return 0.75  # unknown colour: neither reward nor punish much
    if ka in NEUTRALS or kb in NEUTRALS:
        return 1.0
    d = abs(HUES[ka] - HUES[kb]) % 360
    d = min(d, 360 - d)
    if d <= 20:
        return 0.85  # tonal
    if d <= 60:
        return 0.9  # analogous
    if 150 <= d <= 210:
        return 0.75  # complementary: bold but intentional
    return 0.45


def _is_patterned(g: Garment) -> bool:
    return bool(g.pattern) and g.pattern.lower() not in ("solid", "plain")


# --- Request & result ---------------------------------------------------------


@dataclass
class OutfitRequest:
    occasion: str | None = None
    formality: int | None = None
    weather: list[str] = field(default_factory=list)
    count: int = 5
    today: date = field(default_factory=date.today)


@dataclass
class Suggestion:
    garments: list[Garment]
    score: float
    breakdown: dict[str, float]
    reasons: list[str]
    cautions: list[str]


@dataclass
class _Context:
    req: OutfitRequest
    feedback: list[tuple[frozenset[str], int]]
    worn_together: dict[frozenset[str], date]


def _tags(g: Garment) -> set[str]:
    return {t.lower() for t in [*g.labels, *g.occasions]}


def _garment_fit(g: Garment, ctx: _Context) -> tuple[float, dict[str, float]]:
    """How well one garment fits the request, 0..1, plus the per-factor parts used."""
    req = ctx.req
    parts: dict[str, float] = {}
    if req.occasion:
        parts["occasion"] = 1.0 if req.occasion.lower() in _tags(g) else 0.0
    if req.formality:
        parts["formality"] = 0.5 if g.formality is None else 1 - abs(g.formality - req.formality) / 4
    if req.weather:
        tagged = set(g.weather)
        if not tagged:
            parts["weather"] = 0.5
        elif tagged & set(req.weather):
            parts["weather"] = 1.0
        else:
            parts["weather"] = 0.2
    days = (req.today - g.last_worn_on).days if g.last_worn_on else None
    parts["freshness"] = 1.0 if days is None or days > 3 else (0.4 if days <= 1 else 0.75)
    score = sum(parts.values()) / len(parts)
    if "favorite" in _tags(g):
        score = min(1.0, score + 0.1)
    return score, parts


def _score(items: list[Garment], ctx: _Context) -> Suggestion:
    fits = [_garment_fit(g, ctx) for g in items]
    fit = sum(f for f, _ in fits) / len(fits)

    pairs = list(combinations(items, 2))
    color = sum(color_pair_score(a.color, b.color) for a, b in pairs) / len(pairs) if pairs else 1.0
    patterned = [g for g in items if _is_patterned(g)]
    pattern = 1.0 if len(patterned) <= 1 else 0.5
    formal = [g.formality for g in items if g.formality is not None]
    coherence = 1 - (max(formal) - min(formal)) / 4 if len(formal) >= 2 else 0.75

    ids = frozenset(g.id for g in items)
    signal = 0.0
    for liked_ids, rating in ctx.feedback:
        overlap = len(ids & liked_ids)
        if overlap >= 2:
            signal += rating * overlap / max(len(liked_ids), len(ids))
    feedback = (max(-1.0, min(1.0, signal)) + 1) / 2

    recent = [d for combo, d in ctx.worn_together.items() if len(combo & ids) >= 2]
    repetition = 0.5 if recent else 1.0

    breakdown = {
        "fit": fit, "color": color, "formality": coherence,
        "pattern": pattern, "feedback": feedback, "repetition": repetition,
    }
    weights = {
        "fit": 0.35, "color": 0.2, "formality": 0.15,
        "pattern": 0.05, "feedback": 0.15, "repetition": 0.1,
    }
    total = sum(breakdown[k] * w for k, w in weights.items())

    reasons, cautions = [], []
    req = ctx.req
    colors = [g.color for g in items if g.color]
    if color >= 0.9 and len(colors) >= 2:
        reasons.append(f"Colours work together ({' + '.join(dict.fromkeys(colors))})")
    elif color < 0.6:
        cautions.append("Colours may clash")
    if req.occasion:
        matching = sum(1 for _, p in fits if p.get("occasion") == 1.0)
        if matching == len(items):
            reasons.append(f"Every piece is tagged {req.occasion}")
        elif matching:
            reasons.append(f"{matching} of {len(items)} pieces tagged {req.occasion}")
        else:
            cautions.append(f"Nothing here is tagged {req.occasion}")
    if req.formality and formal:
        avg = sum(formal) / len(formal)
        if abs(avg - req.formality) <= 0.75:
            reasons.append(f"Right formality level ({req.formality}/5)")
    elif coherence >= 0.75 and len(formal) >= 2:
        reasons.append("Pieces sit at a similar formality")
    if req.weather and all(p.get("weather", 0) >= 0.5 for _, p in fits):
        if any(p.get("weather") == 1.0 for _, p in fits):
            reasons.append(f"Suited to {', '.join(req.weather).lower()} weather")
    if len(patterned) > 1:
        cautions.append("More than one patterned piece")
    if feedback > 0.6:
        reasons.append("Similar to outfits you liked")
    elif feedback < 0.4:
        cautions.append("Similar to outfits you disliked")
    if recent:
        cautions.append(f"Worn together recently ({max(recent):%a %d %b})")
    if any(p["freshness"] < 0.5 for _, p in fits):
        cautions.append("Includes something you wore yesterday")

    return Suggestion(items, round(total * 100), breakdown, reasons, cautions)


def _load_context(db: Session, user: str, req: OutfitRequest) -> _Context:
    feedback = [
        (frozenset(f.garment_ids), f.rating)
        for f in db.scalars(select(OutfitFeedback).where(OutfitFeedback.user_id == user))
    ]
    since = req.today - timedelta(days=14)
    by_day: dict[date, set[str]] = defaultdict(set)
    rows = db.execute(
        select(GarmentEvent.worn_on, GarmentEvent.garment_id).where(
            GarmentEvent.user_id == user,
            GarmentEvent.kind == "worn",
            GarmentEvent.worn_on >= since,
        )
    )
    for worn_on, gid in rows:
        by_day[worn_on].add(gid)
    worn_together = {frozenset(ids): day for day, ids in by_day.items() if len(ids) >= 2}
    return _Context(req, feedback, worn_together)


def _wants_layer(req: OutfitRequest) -> bool | None:
    """True = add a layer, False = skip, None = only if it improves the score."""
    w = set(req.weather)
    if w & {"Cold", "Windy", "Rainy"}:
        return True
    if w & WARM_WEATHER:
        return False
    return None if (req.formality or 0) >= 4 or w & LAYER_WEATHER else False


def _slots(available: list[Garment], ctx: _Context) -> dict[str, list[Garment]]:
    slots: dict[str, list[Garment]] = defaultdict(list)
    for g in available:
        if slot := SLOT_OF.get(g.category):
            slots[slot].append(g)
    for items in slots.values():
        items.sort(key=lambda g: _garment_fit(g, ctx)[0], reverse=True)
        del items[PER_SLOT:]
    return slots


def rank(available: list[Garment], ctx: _Context) -> list[Suggestion]:
    """Every base outfit (top+bottom or one-piece) built from `available`, best first.

    The caller decides what "available" means: wearable now, or clean on a future
    date in the planner's simulation.
    """
    slots = _slots(available, ctx)
    bases = [[t, b] for t in slots["top"] for b in slots["bottom"]]
    bases += [[o] for o in slots["onepiece"]]
    wants_layer = _wants_layer(ctx.req)
    shoes = slots["shoes"][:5]
    layers = slots["layer"][:5]
    scored: list[Suggestion] = []
    for base in bases:
        options = [base]
        if shoes:
            options = [[*o, s] for o in options for s in shoes]
        if layers and wants_layer is not False:
            with_layer = [[*o, layer] for o in options for layer in layers]
            options = with_layer if wants_layer else options + with_layer
        scored.append(max((_score(o, ctx) for o in options), key=lambda s: s.score))
    scored.sort(key=lambda s: s.score, reverse=True)
    return scored


def load_context(db: Session, user: str, req: OutfitRequest) -> _Context:
    return _load_context(db, user, req)


def with_request(ctx: _Context, req: OutfitRequest) -> _Context:
    """Same learned history, different request (e.g. another day's weather)."""
    return _Context(req, ctx.feedback, ctx.worn_together)


def generate(db: Session, user: str, req: OutfitRequest) -> tuple[list[Suggestion], list[str]]:
    """Returns (suggestions, notes). Notes explain why few or no outfits were possible."""
    pool = db.scalars(
        select(Garment).where(Garment.user_id == user, Garment.archived.is_(False))
    ).all()
    wearable = [g for g in pool if lifecycle.is_wearable(g)]
    ctx = _load_context(db, user, req)
    slots = _slots(wearable, ctx)

    notes: list[str] = []
    owned = defaultdict(int)
    for g in pool:
        if slot := SLOT_OF.get(g.category):
            owned[slot] += 1
    for slot, label in (("top", "tops"), ("bottom", "bottoms"), ("shoes", "shoes")):
        if owned[slot] and not slots[slot]:
            notes.append(f"None of your {label} are ready to wear right now.")

    if not (slots["top"] and slots["bottom"]) and not slots["onepiece"]:
        if not notes:
            notes.append("Add some tops and bottoms (or dresses/suits) to get outfit suggestions.")
        return [], notes
    if _wants_layer(req) and owned["layer"] and not slots["layer"]:
        notes.append("No jackets or sweaters are ready, so outfits skip a layer.")

    scored = rank(wearable, ctx)
    chosen: list[Suggestion] = []
    uses: dict[str, int] = defaultdict(int)
    for s in scored:
        # Prefer variety: cap how often any single garment is suggested.
        if any(uses[g.id] >= MAX_REUSE for g in s.garments if SLOT_OF.get(g.category) != "shoes"):
            continue
        chosen.append(s)
        for g in s.garments:
            uses[g.id] += 1
        if len(chosen) == req.count:
            break
    return chosen, notes


def record_feedback(db: Session, user: str, garment_ids: list[str], rating: int) -> OutfitFeedback:
    fb = OutfitFeedback(user_id=user, garment_ids=sorted(set(garment_ids)), rating=rating)
    db.add(fb)
    return fb
