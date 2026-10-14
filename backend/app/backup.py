"""Export and restore of everything a user owns.

Restore *replaces* the user's data. Every record gets a fresh id and all references
(garment lists, slot keys, history rows) are remapped, so a backup can be restored
into any account without colliding with existing rows.
"""

import base64
import mimetypes
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import inspect, select
from sqlalchemy.orm import Session

from . import storage
from .models import (
    AiUsage,
    BasketItem,
    Event,
    Garment,
    GarmentEvent,
    LaundryBasket,
    OutfitFeedback,
    Pair,
    PairItem,
    PlanEntry,
    Routine,
    UserSettings,
    WeatherReport,
)

FORMAT = "closetiq-backup"
VERSION = 1

# Export order matters for restore: parents before children.
TABLES = [
    ("garments", Garment),
    ("pairs", Pair),
    ("pair_items", PairItem),
    ("laundry_baskets", LaundryBasket),
    ("basket_items", BasketItem),
    ("garment_events", GarmentEvent),
    ("routines", Routine),
    ("events", Event),
    ("plan_entries", PlanEntry),
    ("weather_reports", WeatherReport),
    ("outfit_feedback", OutfitFeedback),
]


class BackupError(ValueError):
    pass


def _value(v):
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return str(v)
    if hasattr(v, "value"):  # enums
        return v.value
    return v


def _row(obj) -> dict:
    return {c.key: _value(getattr(obj, c.key)) for c in inspect(obj).mapper.column_attrs}


def _owned(db: Session, model, user: str):
    if model is PairItem:
        return db.scalars(select(PairItem).join(Pair).where(Pair.user_id == user)).all()
    return db.scalars(select(model).where(model.user_id == user)).all()


def export(db: Session, user: str, include_photos: bool) -> dict:
    data: dict = {"format": FORMAT, "version": VERSION, "exported_at": datetime.utcnow().isoformat()}
    for name, model in TABLES:
        data[name] = [_row(o) for o in _owned(db, model, user)]
    s = db.get(UserSettings, user)
    data["settings"] = _row(s) if s else None
    if include_photos:
        photos = {}
        for g in data["garments"]:
            if g["image_path"] and (blob := storage.load(g["image_path"])) is not None:
                photos[g["image_path"]] = base64.b64encode(blob).decode()
        data["photos"] = photos
    return data


def _parse(model, row: dict) -> dict:
    """Convert JSON values back to column types, ignoring unknown keys."""
    out = {}
    for col in inspect(model).columns:
        if col.key not in row:
            continue
        v = row[col.key]
        enum_class = getattr(col.type, "enum_class", None)
        try:
            py = col.type.python_type
        except NotImplementedError:  # e.g. JSON
            py = None
        try:
            if v is not None and enum_class is not None:
                v = enum_class(v)  # members, not strings: enums hash differently
            elif v is not None and py is datetime:
                v = datetime.fromisoformat(v)
            elif v is not None and py is date:
                v = date.fromisoformat(v)
            elif v is not None and py is Decimal:
                v = Decimal(str(v))
        except (TypeError, ValueError):
            raise BackupError(f"Bad value for {model.__tablename__}.{col.key}")
        out[col.key] = v
    return out


def wipe(db: Session, user: str) -> list[str]:
    """Delete all of a user's wardrobe data (children first). Returns photo paths to remove."""
    photos = [p for p in db.scalars(select(Garment.image_path).where(Garment.user_id == user)) if p]
    for _name, model in reversed(TABLES):
        for obj in _owned(db, model, user):
            db.delete(obj)
    db.flush()
    return photos


def delete_account_data(db: Session, user: str) -> list[str]:
    """Everything, including settings and usage counters. Returns photo paths to remove."""
    photos = wipe(db, user)
    for model in (UserSettings, AiUsage):
        for obj in db.scalars(select(model).where(model.user_id == user)):
            db.delete(obj)
    db.flush()
    return photos


def restore(db: Session, user: str, data: dict) -> dict:
    if data.get("format") != FORMAT or data.get("version") != VERSION:
        raise BackupError("This file isn't a ClosetIQ backup (or is from an unsupported version).")

    old_photos = wipe(db, user)
    ids: dict[str, str] = {}

    def remap(old: str | None) -> str | None:
        if old is None:
            return None
        return ids.setdefault(old, str(uuid.uuid4()))

    def remap_list(values) -> list[str]:
        return [ids[v] for v in values or [] if v in ids]

    photos: dict[str, str] = data.get("photos") or {}
    counts = {}
    for name, model in TABLES:
        rows = data.get(name) or []
        if not isinstance(rows, list):
            raise BackupError(f"'{name}' should be a list")
        for row in rows:
            r = _parse(model, row)
            r["id"] = remap(r.get("id"))
            if "user_id" in r:
                r["user_id"] = user
            for fk in ("garment_id", "pair_id", "basket_id"):
                if fk in r and r[fk] is not None:
                    r[fk] = ids.get(r[fk])
            if model is Garment:
                r["image_path"] = _restore_photo(user, r["id"], r.get("image_path"), photos)
            if model in (Event, PlanEntry, OutfitFeedback):
                r["garment_ids"] = remap_list(r.get("garment_ids"))
            if model is PlanEntry:
                kind, _, ref = (r.get("slot_key") or "").partition(":")
                if ref not in ids:
                    continue  # slot for a routine/event that wasn't in the backup
                r["slot_key"] = f"{kind}:{ids[ref]}"
            if model in (PairItem, BasketItem) and r.get("garment_id") is None:
                continue  # dangling reference
            db.add(model(**r))
        db.flush()
        counts[name] = len(rows)

    s = data.get("settings")
    if isinstance(s, dict):
        existing = db.get(UserSettings, user)
        if existing:
            db.delete(existing)
            db.flush()
        db.add(UserSettings(**{**_parse(UserSettings, s), "user_id": user}))
    for path in old_photos:
        if path:
            storage.delete(path)
    return counts


def _restore_photo(user: str, garment_id: str, old_path: str | None, photos: dict[str, str]) -> str | None:
    if not old_path or old_path not in photos:
        return None
    try:
        blob = base64.b64decode(photos[old_path], validate=True)
    except ValueError:
        return None
    content_type = mimetypes.guess_type(old_path)[0] or "image/jpeg"
    if content_type not in storage.ALLOWED_TYPES or len(blob) > storage.MAX_BYTES:
        return None
    path = storage.new_path(user, garment_id, content_type)
    storage.save(path, blob, content_type)
    return path
