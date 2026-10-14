from typing import Literal

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import lifecycle
from ..auth import current_user
from ..db import get_db
from ..models import BasketStatus, LaundryBasket
from ..schemas import (
    BasketCreate,
    BasketMutationOut,
    BasketOut,
    BasketUpdate,
    CompleteBasket,
    GarmentIds,
    RemoveFromBasket,
)
from ..serialize import baskets_out, get_owned, get_owned_garments

router = APIRouter(prefix="/api/baskets", tags=["laundry"])


def _detail(db: Session, basket: LaundryBasket) -> BasketOut:
    return baskets_out(db, [basket], with_items=True)[0]


@router.get("", response_model=list[BasketOut])
def list_baskets(
    status: BasketStatus | None = None,
    sort: Literal["scheduled", "name", "created"] = "scheduled",
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    stmt = select(LaundryBasket).where(LaundryBasket.user_id == user)
    if status:
        stmt = stmt.where(LaundryBasket.status == status)
    baskets = list(db.scalars(stmt).all())
    if sort == "name":
        baskets.sort(key=lambda b: b.name.lower())
    elif sort == "created":
        baskets.sort(key=lambda b: b.created_at, reverse=True)
    else:  # unscheduled baskets last
        baskets.sort(key=lambda b: (b.scheduled_for is None, b.scheduled_for or b.created_at.date()))
    # The open ironing basket always comes first.
    baskets.sort(key=lambda b: not (b.is_ironing and b.status != BasketStatus.COMPLETED))
    return baskets_out(db, baskets)


@router.post("", response_model=BasketMutationOut, status_code=201)
def create_basket(
    body: BasketCreate, user: str = Depends(current_user), db: Session = Depends(get_db)
):
    basket = LaundryBasket(user_id=user, **body.model_dump(exclude={"garment_ids"}))
    db.add(basket)
    db.flush()
    warnings: list[str] = []
    for g in get_owned_garments(db, body.garment_ids, user) if body.garment_ids else []:
        warnings += lifecycle.add_to_basket(db, basket, g)
    db.commit()
    return BasketMutationOut(basket=_detail(db, basket), warnings=warnings)


@router.get("/{basket_id}", response_model=BasketOut)
def get_basket(basket_id: str, user: str = Depends(current_user), db: Session = Depends(get_db)):
    return _detail(db, get_owned(db, LaundryBasket, basket_id, user))


@router.patch("/{basket_id}", response_model=BasketOut)
def update_basket(
    basket_id: str,
    body: BasketUpdate,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    basket = get_owned(db, LaundryBasket, basket_id, user)
    for key, value in body.model_dump(exclude_unset=True).items():
        if key == "name" and value is None:
            continue
        setattr(basket, key, value)
    db.commit()
    return _detail(db, basket)


@router.delete("/{basket_id}", status_code=204)
def delete_basket(basket_id: str, user: str = Depends(current_user), db: Session = Depends(get_db)):
    basket = get_owned(db, LaundryBasket, basket_id, user)
    lifecycle.release_pending_basket(db, basket)
    db.delete(basket)
    db.commit()


@router.post("/{basket_id}/items", response_model=BasketMutationOut)
def add_items(
    basket_id: str,
    body: GarmentIds,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    basket = get_owned(db, LaundryBasket, basket_id, user)
    warnings: list[str] = []
    for g in get_owned_garments(db, body.garment_ids, user):
        warnings += lifecycle.add_to_basket(db, basket, g)
    db.commit()
    return BasketMutationOut(basket=_detail(db, basket), warnings=warnings)


@router.post("/{basket_id}/items/{garment_id}/remove", response_model=BasketOut)
def remove_item(
    basket_id: str,
    garment_id: str,
    body: RemoveFromBasket,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    basket = get_owned(db, LaundryBasket, basket_id, user)
    lifecycle.remove_from_basket(
        db, basket, garment_id, confirm=body.confirm, restore_to=body.restore_to
    )
    db.commit()
    return _detail(db, basket)


@router.post("/{basket_id}/start", response_model=BasketOut)
def start_basket(basket_id: str, user: str = Depends(current_user), db: Session = Depends(get_db)):
    basket = get_owned(db, LaundryBasket, basket_id, user)
    lifecycle.start_basket(db, basket)
    db.commit()
    return _detail(db, basket)


@router.post("/{basket_id}/complete", response_model=BasketOut)
def complete_basket(
    basket_id: str,
    body: CompleteBasket,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    basket = get_owned(db, LaundryBasket, basket_id, user)
    lifecycle.complete_basket(
        db,
        basket,
        default_result=body.default_result,
        outcomes={o.garment_id: (o.result, o.needs_ironing) for o in body.outcomes},
    )
    db.commit()
    return _detail(db, basket)
