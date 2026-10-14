from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import lifecycle, storage, vocab
from ..auth import current_user
from ..config import settings
from ..db import get_db
from ..lifecycle import CATEGORY_DEFAULTS
from ..models import Garment, GarmentEvent, GarmentState, IroningPolicy
from ..schemas import (
    ArchiveRequest,
    GarmentCreate,
    GarmentEventOut,
    GarmentIds,
    GarmentOut,
    GarmentUpdate,
    StateOverride,
    WashRequest,
    WearRequest,
)
from ..serialize import garment_out, garments_out, get_owned, get_owned_garments

router = APIRouter(prefix="/api", tags=["garments"])

# Columns that may not be cleared to null through PATCH.
_NON_NULLABLE = {"name", "category", "ironing_policy", "labels", "occasions", "seasons", "weather"}


@router.get("/garments", response_model=list[GarmentOut])
def list_garments(
    state: GarmentState | None = None,
    category: str | None = None,
    label: str | None = None,
    q: str | None = None,
    wearable: bool | None = None,
    include_archived: bool = False,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Garment).where(Garment.user_id == user)
    if not include_archived:
        stmt = stmt.where(Garment.archived.is_(False))
    if state:
        stmt = stmt.where(Garment.state == state)
    if category:
        stmt = stmt.where(Garment.category == category.lower())
    garments = db.scalars(stmt.order_by(Garment.category, Garment.name)).all()
    # Wardrobes are small, so tag and text filtering is done in Python for portability.
    if label:
        garments = [g for g in garments if label.lower() in (t.lower() for t in g.labels)]
    if q:
        needle = q.lower()
        garments = [
            g
            for g in garments
            if needle in " ".join(
                filter(None, [g.name, g.category, g.subcategory, g.color, g.pattern, *g.labels])
            ).lower()
        ]
    if wearable is not None:
        garments = [g for g in garments if lifecycle.is_wearable(g) == wearable]
    return garments_out(db, garments)


@router.post("/garments", response_model=GarmentOut, status_code=201)
def create_garment(
    body: GarmentCreate, user: str = Depends(current_user), db: Session = Depends(get_db)
):
    owned = db.scalar(select(func.count()).select_from(Garment).where(Garment.user_id == user))
    if owned >= settings.max_garments_per_user:
        raise HTTPException(409, f"You've reached the limit of {settings.max_garments_per_user} garments. Archive or delete some first.")
    data = body.model_dump(exclude={"use_category_defaults"})
    default_wears, default_iron = CATEGORY_DEFAULTS.get(data["category"], CATEGORY_DEFAULTS["other"])
    if "max_wears_before_wash" not in body.model_fields_set:
        data["max_wears_before_wash"] = default_wears if body.use_category_defaults else 1
    if data["ironing_policy"] is None:
        data["ironing_policy"] = default_iron if body.use_category_defaults else IroningPolicy.NOT_REQUIRED
    g = Garment(user_id=user, **data)
    db.add(g)
    db.flush()
    lifecycle.record_created(db, g)
    db.commit()
    return garment_out(db, g)


@router.get("/garments/{garment_id}", response_model=GarmentOut)
def get_garment(garment_id: str, user: str = Depends(current_user), db: Session = Depends(get_db)):
    return garment_out(db, get_owned(db, Garment, garment_id, user))


@router.patch("/garments/{garment_id}", response_model=GarmentOut)
def update_garment(
    garment_id: str,
    body: GarmentUpdate,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    g = get_owned(db, Garment, garment_id, user)
    changes = body.model_dump(exclude_unset=True)
    for key, value in changes.items():
        if value is None and key in _NON_NULLABLE:
            raise HTTPException(422, f"{key} can't be empty")
        setattr(g, key, value)
    if "max_wears_before_wash" in changes:
        lifecycle.apply_wear_limit(db, g)
    db.commit()
    return garment_out(db, g)


@router.delete("/garments/{garment_id}", status_code=204)
def delete_garment(
    garment_id: str, user: str = Depends(current_user), db: Session = Depends(get_db)
):
    """Permanent delete, for mistakes. Archiving is the normal way to retire a garment."""
    g = get_owned(db, Garment, garment_id, user)
    lifecycle.prepare_delete(db, g)
    image = g.image_path
    db.delete(g)
    db.commit()
    if image:
        storage.delete(image)


@router.post("/garments/{garment_id}/image", response_model=GarmentOut)
async def upload_image(
    garment_id: str,
    file: UploadFile,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    g = get_owned(db, Garment, garment_id, user)
    if file.content_type not in storage.ALLOWED_TYPES:
        raise HTTPException(415, "Photos must be JPEG, PNG or WebP")
    data = await file.read(storage.MAX_BYTES + 1)
    if len(data) > storage.MAX_BYTES:
        raise HTTPException(413, "Photos must be 8 MB or smaller")
    path = storage.new_path(user, g.id, file.content_type)
    try:
        storage.save(path, data, file.content_type)
    except storage.StorageError as e:
        raise HTTPException(502, str(e))
    old = g.image_path
    g.image_path = path
    db.commit()
    if old:
        storage.delete(old)
    return garment_out(db, g)


@router.delete("/garments/{garment_id}/image", response_model=GarmentOut)
def delete_image(garment_id: str, user: str = Depends(current_user), db: Session = Depends(get_db)):
    g = get_owned(db, Garment, garment_id, user)
    old, g.image_path = g.image_path, None
    db.commit()
    if old:
        storage.delete(old)
    return garment_out(db, g)


@router.get("/garments/{garment_id}/history", response_model=list[GarmentEventOut])
def garment_history(
    garment_id: str,
    limit: int = Query(100, ge=1, le=1000),
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    get_owned(db, Garment, garment_id, user)
    return db.scalars(
        select(GarmentEvent)
        .where(GarmentEvent.garment_id == garment_id)
        .order_by(GarmentEvent.at.desc())
        .limit(limit)
    ).all()


@router.post("/garments/{garment_id}/state", response_model=GarmentOut)
def override_state(
    garment_id: str,
    body: StateOverride,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    g = get_owned(db, Garment, garment_id, user)
    lifecycle.override_state(db, g, body.state, body.note)
    db.commit()
    return garment_out(db, g)


@router.post("/garments/{garment_id}/archive", response_model=GarmentOut)
def archive_garment(
    garment_id: str,
    body: ArchiveRequest,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    g = get_owned(db, Garment, garment_id, user)
    lifecycle.archive(db, g, body.reason)
    db.commit()
    return garment_out(db, g)


@router.post("/garments/{garment_id}/unarchive", response_model=GarmentOut)
def unarchive_garment(
    garment_id: str, user: str = Depends(current_user), db: Session = Depends(get_db)
):
    g = get_owned(db, Garment, garment_id, user)
    lifecycle.unarchive(db, g)
    db.commit()
    return garment_out(db, g)


# --- Bulk lifecycle actions. Each is all-or-nothing. ---------------------------


@router.post("/garments/actions/wear", response_model=list[GarmentOut])
def wear(body: WearRequest, user: str = Depends(current_user), db: Session = Depends(get_db)):
    garments = get_owned_garments(db, body.garment_ids, user)
    for g in garments:
        lifecycle.mark_worn(db, g, body.worn_on or date.today())
    db.commit()
    return garments_out(db, garments)


@router.post("/garments/actions/wash", response_model=list[GarmentOut])
def wash(body: WashRequest, user: str = Depends(current_user), db: Session = Depends(get_db)):
    garments = get_owned_garments(db, body.garment_ids, user)
    for g in garments:
        lifecycle.manual_wash(db, g, dry=body.dry, needs_ironing=body.needs_ironing)
    db.commit()
    return garments_out(db, garments)


@router.post("/garments/actions/dried", response_model=list[GarmentOut])
def dried(body: GarmentIds, user: str = Depends(current_user), db: Session = Depends(get_db)):
    garments = get_owned_garments(db, body.garment_ids, user)
    for g in garments:
        lifecycle.finish_drying(db, g)
    db.commit()
    return garments_out(db, garments)


@router.post("/garments/actions/needs-ironing", response_model=list[GarmentOut])
def needs_ironing(body: GarmentIds, user: str = Depends(current_user), db: Session = Depends(get_db)):
    garments = get_owned_garments(db, body.garment_ids, user)
    for g in garments:
        lifecycle.mark_needs_ironing(db, g)
    db.commit()
    return garments_out(db, garments)


@router.post("/garments/actions/ironed", response_model=list[GarmentOut])
def ironed(body: GarmentIds, user: str = Depends(current_user), db: Session = Depends(get_db)):
    garments = get_owned_garments(db, body.garment_ids, user)
    for g in garments:
        lifecycle.mark_ironed(db, g)
    db.commit()
    return garments_out(db, garments)


# --- Reference data -------------------------------------------------------------


@router.get("/labels", response_model=list[str])
def list_labels(user: str = Depends(current_user), db: Session = Depends(get_db)):
    found: dict[str, str] = {}
    for labels in db.scalars(select(Garment.labels).where(Garment.user_id == user)):
        for t in labels or []:
            found.setdefault(t.lower(), t)
    return sorted(found.values(), key=str.lower)


@router.get("/meta")
def meta():
    return {
        "states": [{"value": s.value, "label": lifecycle.label(s)} for s in GarmentState],
        "wearable_states": [s.value for s in lifecycle.WEARABLE_STATES],
        "ironing_policies": [p.value for p in IroningPolicy],
        "categories": [
            {"value": c, "max_wears_before_wash": w, "ironing_policy": i.value}
            for c, (w, i) in CATEGORY_DEFAULTS.items()
        ],
        "suggested_labels": vocab.SUGGESTED_LABELS,
        "occasions": vocab.OCCASIONS,
        "seasons": vocab.SEASONS,
        "weather": vocab.WEATHER,
        "patterns": vocab.PATTERNS,
    }
