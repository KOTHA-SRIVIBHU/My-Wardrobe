"""Turns ORM rows into API responses, batching the lookups lists need."""

from collections.abc import Iterable

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import lifecycle, storage
from .models import BasketItem, BasketItemOutcome, Garment, LaundryBasket, Pair
from .schemas import BasketItemOut, BasketOut, BasketRef, Blocker, GarmentOut, PairOut


def get_owned(db: Session, model, obj_id: str, user_id: str):
    obj = db.get(model, obj_id)
    if obj is None or obj.user_id != user_id:
        raise HTTPException(404, f"{model.__name__} not found")
    return obj


def get_owned_garments(db: Session, ids: list[str], user_id: str) -> list[Garment]:
    """Fetch garments in the requested order; 404 if any is missing or not the caller's."""
    unique = list(dict.fromkeys(ids))
    rows = db.scalars(
        select(Garment).where(Garment.id.in_(unique), Garment.user_id == user_id)
    ).all()
    by_id = {g.id: g for g in rows}
    missing = [i for i in unique if i not in by_id]
    if missing:
        raise HTTPException(404, f"Garment not found: {missing[0]}")
    return [by_id[i] for i in unique]


def garments_out(db: Session, garments: Iterable[Garment]) -> list[GarmentOut]:
    garments = list(garments)
    if not garments:
        return []
    ids = [g.id for g in garments]
    active = db.execute(
        select(BasketItem.garment_id, LaundryBasket.id, LaundryBasket.name, LaundryBasket.status, LaundryBasket.kind)
        .join(LaundryBasket, BasketItem.basket_id == LaundryBasket.id)
        .where(BasketItem.garment_id.in_(ids), BasketItem.active.is_(True))
    ).all()
    basket_by_garment = {
        gid: BasketRef(id=bid, name=name, status=status, kind=kind or "laundry")
        for gid, bid, name, status, kind in active
    }
    urls = storage.urls_for([g.image_path for g in garments if g.image_path])
    out = []
    for g in garments:
        item = GarmentOut.model_validate(g)
        item.image_url = urls.get(g.image_path) if g.image_path else None
        item.wearable = lifecycle.is_wearable(g)
        item.active_basket = basket_by_garment.get(g.id)
        out.append(item)
    return out


def garment_out(db: Session, g: Garment) -> GarmentOut:
    return garments_out(db, [g])[0]


def pairs_out(db: Session, pairs: Iterable[Pair]) -> list[PairOut]:
    pairs = list(pairs)
    all_garments = {i.garment.id: i.garment for p in pairs for i in p.items}
    serialized = {g.id: g for g in garments_out(db, all_garments.values())}
    out = []
    for p in pairs:
        blockers = [
            Blocker(garment_id=i.garment.id, garment_name=i.garment.name, reason=reason)
            for i in p.items
            if (reason := lifecycle.blocker_reason(i.garment)) is not None
        ]
        out.append(
            PairOut(
                id=p.id,
                name=p.name,
                description=p.description,
                labels=p.labels,
                occasion=p.occasion,
                favorite=p.favorite,
                notes=p.notes,
                created_at=p.created_at,
                updated_at=p.updated_at,
                garments=[serialized[i.garment_id] for i in p.items],
                wearable=bool(p.items) and not blockers,
                blockers=blockers,
            )
        )
    return out


def baskets_out(
    db: Session, baskets: Iterable[LaundryBasket], *, with_items: bool = False
) -> list[BasketOut]:
    baskets = list(baskets)
    serialized: dict[str, GarmentOut] = {}
    if with_items:
        garments = {i.garment.id: i.garment for b in baskets for i in b.items}
        serialized = {g.id: g for g in garments_out(db, garments.values())}
    out = []
    for b in baskets:
        out.append(
            BasketOut(
                id=b.id,
                kind=b.kind or "laundry",
                name=b.name,
                description=b.description,
                scheduled_for=b.scheduled_for,
                expected_completion_at=b.expected_completion_at,
                notes=b.notes,
                status=b.status,
                created_at=b.created_at,
                started_at=b.started_at,
                completed_at=b.completed_at,
                # A completed basket counts what it processed; open baskets count current contents.
                garment_count=len(
                    [i for i in b.items if i.outcome not in (None, BasketItemOutcome.REMOVED)]
                    if b.completed_at
                    else b.active_items
                ),
                items=[
                    BasketItemOut(
                        id=i.id,
                        garment=serialized[i.garment_id],
                        added_at=i.added_at,
                        previous_state=i.previous_state,
                        active=i.active,
                        outcome=i.outcome,
                        resolved_at=i.resolved_at,
                    )
                    for i in b.items
                ]
                if with_items
                else [],
            )
        )
    return out
