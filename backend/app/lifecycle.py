"""Deterministic garment lifecycle rules.

Every change to a garment's state goes through this module so that availability,
wear counts and history stay consistent. Functions mutate ORM objects and add
history rows but never commit; the calling route commits the whole operation.
"""

from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import (
    BasketItem,
    BasketItemOutcome,
    BasketStatus,
    Garment,
    GarmentEvent,
    GarmentState,
    IroningPolicy,
    LaundryBasket,
    utcnow,
)

S = GarmentState

# Clean, prepared and free to be put into a new outfit right now.
WEARABLE_STATES = frozenset({S.READY, S.WORN_REUSABLE})
# States owned by laundry baskets; only basket operations may enter or leave them.
BASKET_STATES = frozenset({S.IN_BASKET, S.IN_LAUNDRY})

STATE_LABELS = {
    S.READY: "Ready to Wear",
    S.WORN_REUSABLE: "Worn — Reusable",
    S.NEEDS_LAUNDRY: "Needs Laundry",
    S.IN_BASKET: "In Laundry Basket",
    S.IN_LAUNDRY: "In Laundry",
    S.DRYING: "Drying",
    S.NEEDS_IRONING: "Needs Ironing",
    S.RESERVED: "Reserved",
    S.UNAVAILABLE: "Unavailable",
}

# category -> (wears before it needs washing, ironing policy). None = never by wear count.
CATEGORY_DEFAULTS: dict[str, tuple[int | None, IroningPolicy]] = {
    "shirt": (1, IroningPolicy.REQUIRED),
    "t-shirt": (1, IroningPolicy.NOT_REQUIRED),
    "trousers": (3, IroningPolicy.OPTIONAL),
    "jeans": (5, IroningPolicy.NOT_REQUIRED),
    "shorts": (2, IroningPolicy.NOT_REQUIRED),
    "skirt": (3, IroningPolicy.OPTIONAL),
    "dress": (1, IroningPolicy.OPTIONAL),
    "vest": (1, IroningPolicy.NOT_REQUIRED),
    "underwear": (1, IroningPolicy.NOT_REQUIRED),
    "socks": (1, IroningPolicy.NOT_REQUIRED),
    "nightwear": (3, IroningPolicy.NOT_REQUIRED),
    "sweater": (4, IroningPolicy.NOT_REQUIRED),
    "jacket": (10, IroningPolicy.NOT_REQUIRED),
    "suit": (5, IroningPolicy.OPTIONAL),
    "activewear": (1, IroningPolicy.NOT_REQUIRED),
    "shoes": (None, IroningPolicy.NOT_REQUIRED),
    "accessories": (None, IroningPolicy.NOT_REQUIRED),
    "other": (1, IroningPolicy.NOT_REQUIRED),
}


class LifecycleError(Exception):
    """A business-rule violation, reported to the client as HTTP 409."""

    def __init__(self, message: str, code: str = "conflict"):
        super().__init__(message)
        self.message = message
        self.code = code


def label(state: GarmentState) -> str:
    return STATE_LABELS[state]


def is_wearable(g: Garment) -> bool:
    return not g.archived and g.state in WEARABLE_STATES


def blocker_reason(g: Garment) -> str | None:
    """Why this garment can't go into an outfit right now, or None if it can."""
    if g.archived:
        return "archived"
    if g.state in WEARABLE_STATES:
        return None
    return label(g.state)


def _record(
    db: Session,
    g: Garment,
    kind: str,
    *,
    from_state: GarmentState | None = None,
    to_state: GarmentState | None = None,
    basket_id: str | None = None,
    pair_id: str | None = None,
    worn_on: date | None = None,
    note: str | None = None,
    at: datetime | None = None,
) -> None:
    db.add(
        GarmentEvent(
            user_id=g.user_id,
            garment_id=g.id,
            kind=kind,
            from_state=from_state,
            to_state=to_state,
            basket_id=basket_id,
            pair_id=pair_id,
            worn_on=worn_on,
            note=note,
            at=at or utcnow(),
        )
    )


def _transition(
    db: Session,
    g: Garment,
    new_state: GarmentState,
    *,
    kind: str = "state_change",
    basket_id: str | None = None,
    note: str | None = None,
    at: datetime | None = None,
) -> None:
    old = g.state
    if old == new_state:
        return
    # The ironing basket follows the Needs Ironing state automatically.
    if old == S.NEEDS_IRONING:
        _leave_ironing(db, g, ironed=kind == "ironed")
    g.state = new_state
    _record(db, g, kind, from_state=old, to_state=new_state, basket_id=basket_id, note=note, at=at)
    if new_state == S.NEEDS_IRONING:
        _join_ironing(db, g, previous=old)


def active_basket_item(db: Session, garment_id: str) -> BasketItem | None:
    """The garment's current basket assignment of either kind (laundry or ironing)."""
    return db.scalars(
        select(BasketItem).where(BasketItem.garment_id == garment_id, BasketItem.active.is_(True))
    ).first()


def active_laundry_item(db: Session, garment_id: str) -> BasketItem | None:
    item = active_basket_item(db, garment_id)
    return item if item is not None and not item.basket.is_ironing else None


# --- Ironing basket -----------------------------------------------------------------

IRONING = "ironing"
IRONING_BASKET_NAME = "Ironing basket"


def ironing_basket(db: Session, user_id: str) -> LaundryBasket | None:
    """The user's single, permanent ironing basket (None until first needed)."""
    return db.scalars(
        select(LaundryBasket).where(LaundryBasket.user_id == user_id, LaundryBasket.kind == IRONING)
    ).first()


def ensure_ironing_basket(db: Session, user_id: str) -> LaundryBasket:
    basket = ironing_basket(db, user_id)
    if basket is None:
        basket = LaundryBasket(
            user_id=user_id, name=IRONING_BASKET_NAME, kind=IRONING, status=BasketStatus.PENDING,
            description="Clean clothes waiting to be ironed. Filled automatically after laundry.",
        )
        db.add(basket)
        db.flush()
    return basket


def _join_ironing(db: Session, g: Garment, previous: GarmentState) -> None:
    item = active_basket_item(db, g.id)
    if item is not None and item.basket.is_ironing:
        return
    basket = ensure_ironing_basket(db, g.user_id)
    # Flush first so a laundry assignment released in this same operation is saved
    # before the new one (a garment may only have one active basket at a time).
    db.flush()
    new = BasketItem(user_id=g.user_id, garment=g, previous_state=previous)
    basket.items.append(new)
    db.add(new)


def _leave_ironing(db: Session, g: Garment, *, ironed: bool) -> None:
    """The ironing basket itself stays, even when empty: there is only ever one."""
    item = active_basket_item(db, g.id)
    if item is None or not item.basket.is_ironing:
        return
    item.active = False
    item.outcome = BasketItemOutcome.IRONED if ironed else BasketItemOutcome.REMOVED
    item.resolved_at = utcnow()
    db.flush()


def consolidate_ironing_baskets(db: Session) -> int:
    """Merge any duplicate ironing baskets (from older versions) into one per user.

    Keeps each user's oldest ironing basket, moves every item (and its history) into
    it and reopens it. Returns the number of duplicates removed.
    """
    baskets = db.scalars(
        select(LaundryBasket).where(LaundryBasket.kind == IRONING).order_by(LaundryBasket.created_at)
    ).all()
    keep: dict[str, LaundryBasket] = {}
    removed = 0
    for b in baskets:
        if b.user_id not in keep:
            keep[b.user_id] = b
            continue
        target = keep[b.user_id]
        for item in list(b.items):
            item.basket = target
        db.flush()
        db.delete(b)
        removed += 1
    for b in keep.values():
        b.status = BasketStatus.PENDING
        b.completed_at = None
    db.flush()
    return removed


# --- Wear limits --------------------------------------------------------------------


def apply_wear_limit(db: Session, g: Garment) -> None:
    """Re-check a garment against its wear limit (after the limit was edited).

    Worn up to (or past) the limit -> Needs Laundry. A garment that was only "dirty"
    because of a lower limit becomes reusable again when the limit is raised.
    """
    if g.archived or active_basket_item(db, g.id) is not None:
        return
    limit = g.max_wears_before_wash
    if g.state in WEARABLE_STATES and limit is not None and g.wears_since_wash >= limit:
        _transition(db, g, S.NEEDS_LAUNDRY, kind="worn_limit",
                    note=f"Worn {g.wears_since_wash} times; limit is {limit}")
    elif g.state == S.NEEDS_LAUNDRY and g.wears_since_wash > 0 and (limit is None or g.wears_since_wash < limit):
        # Only undo it if wearing (not the user) made it dirty, e.g. not after a stain.
        last = db.scalars(
            select(GarmentEvent.kind)
            .where(GarmentEvent.garment_id == g.id, GarmentEvent.to_state == S.NEEDS_LAUNDRY)
            .order_by(GarmentEvent.at.desc())
        ).first()
        if last in ("worn", "worn_limit"):
            _transition(db, g, S.WORN_REUSABLE, note="Wear limit raised")


def _require_not_archived(g: Garment) -> None:
    if g.archived:
        raise LifecycleError(f"'{g.name}' is archived.", "archived")


# --- Creation & manual control ---------------------------------------------


def record_created(db: Session, g: Garment) -> None:
    _record(db, g, "created", to_state=g.state)


def override_state(db: Session, g: Garment, new_state: GarmentState, note: str | None) -> None:
    """User correction when the real world differs from the expected lifecycle."""
    _require_not_archived(g)
    if new_state in BASKET_STATES:
        raise LifecycleError(
            "Add the garment to a laundry basket instead of setting this state directly.",
            "basket_state",
        )
    item = active_laundry_item(db, g.id)
    if item is not None:
        raise LifecycleError(
            f"'{g.name}' is in the basket '{item.basket.name}'. Remove it from the basket first.",
            "in_basket",
        )
    if new_state != S.DRYING:
        g.iron_after_drying = False
    if new_state == S.READY and g.wears_since_wash:
        # "Ready to Wear" means clean and fresh; "Worn — Reusable" keeps the count.
        g.wears_since_wash = 0
    _transition(db, g, new_state, note=note or "Manual override")


def archive(db: Session, g: Garment, reason: str) -> None:
    if active_laundry_item(db, g.id) is not None:
        raise LifecycleError(
            f"'{g.name}' is in a laundry basket. Remove it before archiving.", "in_basket"
        )
    _leave_ironing(db, g, ironed=False)
    g.archived = True
    g.archived_reason = reason
    _record(db, g, "archived", note=reason)


def prepare_delete(db: Session, g: Garment) -> None:
    """Checks before permanently deleting a garment; tidies the ironing basket."""
    if active_laundry_item(db, g.id) is not None:
        raise LifecycleError(f"'{g.name}' is in a laundry basket. Remove it before deleting.", "in_basket")
    _leave_ironing(db, g, ironed=False)


def unarchive(db: Session, g: Garment) -> None:
    g.archived = False
    g.archived_reason = None
    _record(db, g, "unarchived")


# --- Wearing ------------------------------------------------------------------


def mark_worn(db: Session, g: Garment, worn_on: date, pair_id: str | None = None) -> None:
    _require_not_archived(g)
    if g.state not in WEARABLE_STATES and g.state != S.RESERVED:
        raise LifecycleError(f"'{g.name}' is {label(g.state)} and can't be worn.", "not_wearable")
    old = g.state
    g.total_wears += 1
    g.wears_since_wash += 1
    if g.last_worn_on is None or worn_on > g.last_worn_on:
        g.last_worn_on = worn_on
    limit = g.max_wears_before_wash
    g.state = S.NEEDS_LAUNDRY if limit is not None and g.wears_since_wash >= limit else S.WORN_REUSABLE
    _record(db, g, "worn", from_state=old, to_state=g.state, pair_id=pair_id, worn_on=worn_on)


# --- Washing, drying, ironing -------------------------------------------------


def _wants_ironing(g: Garment, choice: bool | None) -> bool:
    if choice is not None:
        return choice
    return g.ironing_policy == IroningPolicy.REQUIRED


def apply_wash(
    db: Session,
    g: Garment,
    *,
    dry: bool,
    needs_ironing: bool | None = None,
    basket_id: str | None = None,
    at: datetime | None = None,
) -> None:
    """Washing is the only operation that resets wears-since-wash."""
    at = at or utcnow()
    g.wears_since_wash = 0
    g.last_washed_at = at
    _record(db, g, "washed", basket_id=basket_id, at=at)
    iron = _wants_ironing(g, needs_ironing)
    if dry:
        g.iron_after_drying = False
        target = S.NEEDS_IRONING if iron else S.READY
    else:
        g.iron_after_drying = iron
        target = S.DRYING
    _transition(db, g, target, basket_id=basket_id, at=at)


def manual_wash(db: Session, g: Garment, *, dry: bool, needs_ironing: bool | None) -> None:
    """Washed outside a basket (e.g. hand wash)."""
    _require_not_archived(g)
    if active_laundry_item(db, g.id) is not None:
        raise LifecycleError(
            f"'{g.name}' is in a laundry basket; complete or remove it there.", "in_basket"
        )
    apply_wash(db, g, dry=dry, needs_ironing=needs_ironing)


def finish_drying(db: Session, g: Garment) -> None:
    if g.state != S.DRYING:
        raise LifecycleError(f"'{g.name}' is not drying.", "invalid_state")
    target = S.NEEDS_IRONING if g.iron_after_drying else S.READY
    g.iron_after_drying = False
    _transition(db, g, target, note="Finished drying")


def mark_needs_ironing(db: Session, g: Garment) -> None:
    _require_not_archived(g)
    if g.state == S.DRYING:
        g.iron_after_drying = True
        _record(db, g, "state_change", note="Will need ironing once dry")
        return
    if g.state not in WEARABLE_STATES and g.state != S.RESERVED:
        raise LifecycleError(
            f"'{g.name}' is {label(g.state)}; only clean garments can be queued for ironing.",
            "invalid_state",
        )
    _transition(db, g, S.NEEDS_IRONING)


def mark_ironed(db: Session, g: Garment) -> None:
    """Ironing never touches wear counts or the last washed date."""
    if g.state != S.NEEDS_IRONING:
        raise LifecycleError(f"'{g.name}' doesn't need ironing.", "invalid_state")
    _transition(db, g, S.READY, kind="ironed")


# --- Laundry baskets ------------------------------------------------------------


def add_to_basket(db: Session, basket: LaundryBasket, g: Garment) -> list[str]:
    """Assign a garment to a basket. Returns non-blocking warnings."""
    if basket.status == BasketStatus.COMPLETED:
        raise LifecycleError(f"'{basket.name}' is already completed.", "basket_completed")
    _require_not_archived(g)
    existing = active_basket_item(db, g.id)
    if basket.is_ironing:
        if existing is not None and existing.basket_id == basket.id:
            raise LifecycleError(f"'{g.name}' is already in this basket.", "duplicate")
        mark_needs_ironing(db, g)  # joins this (the open) ironing basket
        return []
    if existing is not None and existing.basket.is_ironing:
        # Going back into the wash: it no longer waits for ironing.
        _leave_ironing(db, g, ironed=False)
        existing = None
    if existing is not None:
        if existing.basket_id == basket.id:
            raise LifecycleError(f"'{g.name}' is already in this basket.", "duplicate")
        raise LifecycleError(
            f"'{g.name}' is already in the basket '{existing.basket.name}'. "
            "Remove it from there first.",
            "in_other_basket",
        )
    warnings = []
    if g.state == S.RESERVED:
        warnings.append(f"'{g.name}' is reserved for an upcoming event.")
    item = BasketItem(user_id=g.user_id, garment=g, previous_state=g.state)
    basket.items.append(item)
    db.add(item)
    target = S.IN_BASKET if basket.status == BasketStatus.PENDING else S.IN_LAUNDRY
    _transition(db, g, target, basket_id=basket.id, note=f"Added to '{basket.name}'")
    return warnings


def remove_from_basket(
    db: Session,
    basket: LaundryBasket,
    garment_id: str,
    *,
    confirm: bool = False,
    restore_to: GarmentState | None = None,
) -> Garment:
    item = next((i for i in basket.active_items if i.garment_id == garment_id), None)
    if item is None:
        raise LifecycleError("That garment is not in this basket.", "not_in_basket")
    if basket.is_ironing:
        # "Doesn't need ironing after all": it's clean, so it's ready unless told otherwise.
        if restore_to in BASKET_STATES:
            raise LifecycleError("Can't restore a garment to a basket state.", "basket_state")
        g = item.garment
        _transition(db, g, restore_to or S.READY, note=f"Removed from '{basket.name}'")
        return g
    if basket.status == BasketStatus.IN_PROGRESS and not confirm:
        raise LifecycleError(
            f"'{basket.name}' is already in progress — the garment may already be washing.",
            "confirmation_required",
        )
    if restore_to in BASKET_STATES:
        raise LifecycleError("Can't restore a garment to a basket state.", "basket_state")
    target = restore_to or item.previous_state
    if target in BASKET_STATES:  # defensive: never leave a garment orphaned in a basket state
        target = S.NEEDS_LAUNDRY
    item.active = False
    item.outcome = BasketItemOutcome.REMOVED
    item.resolved_at = utcnow()
    g = item.garment
    if target != S.DRYING:
        g.iron_after_drying = False
    _transition(db, g, target, basket_id=basket.id, note=f"Removed from '{basket.name}'")
    return g


def _not_ironing(basket: LaundryBasket) -> None:
    if basket.is_ironing:
        raise LifecycleError(
            "The ironing basket empties as you mark clothes ironed; it isn't started or completed.",
            "ironing_basket",
        )


def start_basket(db: Session, basket: LaundryBasket) -> None:
    _not_ironing(basket)
    if basket.status != BasketStatus.PENDING:
        raise LifecycleError(f"'{basket.name}' has already been started.", "invalid_status")
    if not basket.active_items:
        raise LifecycleError(f"'{basket.name}' is empty.", "empty_basket")
    now = utcnow()
    basket.status = BasketStatus.IN_PROGRESS
    basket.started_at = now
    for item in basket.active_items:
        _transition(db, item.garment, S.IN_LAUNDRY, basket_id=basket.id, at=now)


# Per-garment results the user can report when completing a basket.
RESULT_DRY = "dry"
RESULT_DRYING = "drying"
RESULT_UNAVAILABLE = "unavailable"
RESULT_NOT_PROCESSED = "not_processed"
RESULTS = (RESULT_DRY, RESULT_DRYING, RESULT_UNAVAILABLE, RESULT_NOT_PROCESSED)


def complete_basket(
    db: Session,
    basket: LaundryBasket,
    *,
    default_result: str,
    outcomes: dict[str, tuple[str, bool | None]],
) -> None:
    """outcomes maps garment_id -> (result, needs_ironing override)."""
    _not_ironing(basket)
    if basket.status == BasketStatus.COMPLETED:
        raise LifecycleError(f"'{basket.name}' is already completed.", "invalid_status")
    if not basket.active_items:
        raise LifecycleError(f"'{basket.name}' is empty.", "empty_basket")
    if default_result not in (RESULT_DRY, RESULT_DRYING):
        raise LifecycleError("default_result must be 'dry' or 'drying'.", "invalid_result")
    active_ids = {i.garment_id for i in basket.active_items}
    unknown = set(outcomes) - active_ids
    if unknown:
        raise LifecycleError("Some outcomes refer to garments not in this basket.", "not_in_basket")
    for result, _ in outcomes.values():
        if result not in RESULTS:
            raise LifecycleError(f"Unknown result '{result}'.", "invalid_result")

    now = utcnow()
    if basket.started_at is None:
        basket.started_at = now
    for item in basket.active_items:
        g = item.garment
        result, iron = outcomes.get(g.id, (default_result, None))
        item.active = False
        item.resolved_at = now
        if result == RESULT_NOT_PROCESSED:
            item.outcome = BasketItemOutcome.NOT_PROCESSED
            target = item.previous_state if item.previous_state not in BASKET_STATES else S.NEEDS_LAUNDRY
            _transition(db, g, target, basket_id=basket.id, note="Not processed", at=now)
            continue
        item.outcome = BasketItemOutcome.WASHED
        apply_wash(db, g, dry=result != RESULT_DRYING, needs_ironing=iron, basket_id=basket.id, at=now)
        if result == RESULT_UNAVAILABLE:
            g.iron_after_drying = False
            _transition(db, g, S.UNAVAILABLE, basket_id=basket.id, note="Unavailable after laundry", at=now)
    basket.status = BasketStatus.COMPLETED
    basket.completed_at = now


def release_pending_basket(db: Session, basket: LaundryBasket) -> None:
    """Deleting a pending basket returns its garments to their previous states."""
    if basket.is_ironing and basket.active_items:
        raise LifecycleError(
            "Iron the clothes in this basket (or remove them) before deleting it.", "ironing_basket"
        )
    if basket.status == BasketStatus.IN_PROGRESS:
        raise LifecycleError(
            f"'{basket.name}' is in progress; complete it or remove its garments first.",
            "invalid_status",
        )
    for item in list(basket.active_items):
        remove_from_basket(db, basket, item.garment_id)
