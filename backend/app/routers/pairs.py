from datetime import date

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import lifecycle
from ..auth import current_user
from ..db import get_db
from ..models import Pair, PairItem
from ..schemas import GarmentOut, PairCreate, PairOut, PairUpdate, PairWearRequest
from ..serialize import garments_out, get_owned, get_owned_garments, pairs_out

router = APIRouter(prefix="/api/pairs", tags=["pairs"])


def _set_garments(db: Session, pair: Pair, garment_ids: list[str], user: str) -> None:
    garments = get_owned_garments(db, garment_ids, user)
    pair.items.clear()
    db.flush()
    for pos, g in enumerate(garments):
        pair.items.append(PairItem(garment=g, position=pos))


@router.get("", response_model=list[PairOut])
def list_pairs(
    favorite: bool | None = None,
    wearable: bool | None = None,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Pair).where(Pair.user_id == user)
    if favorite is not None:
        stmt = stmt.where(Pair.favorite.is_(favorite))
    out = pairs_out(db, db.scalars(stmt.order_by(Pair.favorite.desc(), Pair.name)).all())
    if wearable is not None:
        out = [p for p in out if p.wearable == wearable]
    return out


@router.post("", response_model=PairOut, status_code=201)
def create_pair(body: PairCreate, user: str = Depends(current_user), db: Session = Depends(get_db)):
    pair = Pair(user_id=user, **body.model_dump(exclude={"garment_ids"}))
    db.add(pair)
    _set_garments(db, pair, body.garment_ids, user)
    db.commit()
    return pairs_out(db, [pair])[0]


@router.get("/{pair_id}", response_model=PairOut)
def get_pair(pair_id: str, user: str = Depends(current_user), db: Session = Depends(get_db)):
    return pairs_out(db, [get_owned(db, Pair, pair_id, user)])[0]


@router.patch("/{pair_id}", response_model=PairOut)
def update_pair(
    pair_id: str, body: PairUpdate, user: str = Depends(current_user), db: Session = Depends(get_db)
):
    pair = get_owned(db, Pair, pair_id, user)
    data = body.model_dump(exclude_unset=True)
    garment_ids = data.pop("garment_ids", None)
    for key, value in data.items():
        if value is None and key in ("name", "labels", "favorite"):
            continue
        setattr(pair, key, value)
    if garment_ids is not None:
        _set_garments(db, pair, garment_ids, user)
    db.commit()
    return pairs_out(db, [pair])[0]


@router.delete("/{pair_id}", status_code=204)
def delete_pair(pair_id: str, user: str = Depends(current_user), db: Session = Depends(get_db)):
    db.delete(get_owned(db, Pair, pair_id, user))
    db.commit()


@router.post("/{pair_id}/duplicate", response_model=PairOut, status_code=201)
def duplicate_pair(pair_id: str, user: str = Depends(current_user), db: Session = Depends(get_db)):
    src = get_owned(db, Pair, pair_id, user)
    copy = Pair(
        user_id=user,
        name=f"{src.name} (copy)"[:120],
        description=src.description,
        labels=list(src.labels),
        occasion=src.occasion,
        favorite=False,
        notes=src.notes,
    )
    db.add(copy)
    for item in src.items:
        copy.items.append(PairItem(garment_id=item.garment_id, position=item.position))
    db.commit()
    db.refresh(copy)
    return pairs_out(db, [copy])[0]


@router.post("/{pair_id}/wear", response_model=list[GarmentOut])
def wear_pair(
    pair_id: str,
    body: PairWearRequest,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Marks every garment in the pair as worn, or none of them if any can't be worn."""
    pair = get_owned(db, Pair, pair_id, user)
    garments = [i.garment for i in pair.items]
    for g in garments:
        lifecycle.mark_worn(db, g, body.worn_on or date.today(), pair_id=pair.id)
    db.commit()
    return garments_out(db, garments)
