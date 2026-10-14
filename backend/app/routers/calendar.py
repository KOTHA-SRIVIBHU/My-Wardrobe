from datetime import date, timedelta

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import planner, vocab, weather
from ..auth import current_user
from ..db import get_db
from ..models import Event, UserSettings, WeatherReport
from ..schemas import DayWeatherOut, EventIn, EventOut, SettingsIn, SettingsOut, WeatherReportIn
from ..serialize import get_owned, get_owned_garments

router = APIRouter(prefix="/api", tags=["calendar"])

SKIPS_ROUTINES_BY_DEFAULT = {"holiday", "travel"}


# --- Events -----------------------------------------------------------------------


def _apply_event(e: Event, body: EventIn, db: Session, user: str) -> None:
    if body.garment_ids:
        get_owned_garments(db, body.garment_ids, user)
    data = body.model_dump()
    if data["skip_day_routines"] is None:
        data["skip_day_routines"] = body.kind in SKIPS_ROUTINES_BY_DEFAULT
    data["garment_ids"] = list(dict.fromkeys(body.garment_ids))
    for k, v in data.items():
        setattr(e, k, v)


@router.get("/events", response_model=list[EventOut])
def list_events(
    start: date | None = None,
    end: date | None = None,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    start = start or date.today()
    end = end or start + timedelta(days=90)
    return db.scalars(
        select(Event)
        .where(Event.user_id == user, Event.date >= start, Event.date <= end)
        .order_by(Event.date, Event.start_time)
    ).all()


@router.post("/events", response_model=EventOut, status_code=201)
def create_event(body: EventIn, user: str = Depends(current_user), db: Session = Depends(get_db)):
    e = Event(user_id=user)
    _apply_event(e, body, db, user)
    db.add(e)
    db.flush()
    planner.replan_if_planned(db, user, [e.date])
    db.commit()
    return e


@router.put("/events/{event_id}", response_model=EventOut)
def update_event(
    event_id: str, body: EventIn, user: str = Depends(current_user), db: Session = Depends(get_db)
):
    e = get_owned(db, Event, event_id, user)
    old_date = e.date
    _apply_event(e, body, db, user)
    db.flush()
    # A moved event releases its old date and needs planning on the new one.
    planner.replan_if_planned(db, user, sorted({old_date, e.date}))
    db.commit()
    return e


@router.delete("/events/{event_id}", status_code=204)
def delete_event(event_id: str, user: str = Depends(current_user), db: Session = Depends(get_db)):
    e = get_owned(db, Event, event_id, user)
    d = e.date
    db.delete(e)
    db.flush()
    planner.replan_if_planned(db, user, [d])
    db.commit()


# --- Settings ---------------------------------------------------------------------


def _settings(db: Session, user: str) -> UserSettings:
    s = db.get(UserSettings, user)
    if s is None:
        s = UserSettings(user_id=user, laundry_weekdays=[], drying_days=1, notification_prefs={})
    return s


@router.get("/settings", response_model=SettingsOut)
def get_settings(user: str = Depends(current_user), db: Session = Depends(get_db)):
    s = _settings(db, user)
    return SettingsOut(
        location_name=s.location_name, latitude=s.latitude, longitude=s.longitude,
        laundry_weekdays=s.laundry_weekdays or [], drying_days=s.drying_days,
        notification_prefs=s.notification_prefs or {},
    )


@router.put("/settings", response_model=SettingsOut)
def put_settings(body: SettingsIn, user: str = Depends(current_user), db: Session = Depends(get_db)):
    """Partial update: only fields present in the request change."""
    s = _settings(db, user)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(s, k, v)
    db.merge(s)
    db.commit()
    return get_settings(user, db)


# --- Weather ----------------------------------------------------------------------


@router.get("/weather/geocode")
def geocode(q: str = Query(min_length=2, max_length=80), _user: str = Depends(current_user)):
    try:
        return weather.geocode(q)
    except (httpx.HTTPError, ValueError, KeyError):
        raise HTTPException(503, "Location search is unavailable right now.")


@router.get("/weather")
def get_weather(
    days: int = Query(7, ge=1, le=16),
    today: date | None = None,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Forecast plus the user's own reports. A report wins for planning, but both are shown."""
    s = _settings(db, user)
    today = today or date.today()
    fc, error = weather.safe_forecast(s.latitude, s.longitude)
    reports = {
        r.date: r.tags
        for r in db.scalars(
            select(WeatherReport).where(
                WeatherReport.user_id == user,
                WeatherReport.date >= today,
                WeatherReport.date < today + timedelta(days=days),
            )
        )
    }
    out = []
    for i in range(days):
        d = today + timedelta(days=i)
        f = fc.get(d)
        reported = reports.get(d, [])
        out.append({
            "date": d,
            "forecast": DayWeatherOut(**{k: v for k, v in vars(f).items() if k != "date"}) if f else None,
            "reported": reported,
            "weather": reported or (f.tags if f else []),
        })
    return {"location": s.location_name, "error": error, "days": out}


@router.put("/weather/reports", status_code=204)
def report_weather(body: WeatherReportIn, user: str = Depends(current_user), db: Session = Depends(get_db)):
    tags = vocab.canonical(body.tags, vocab.WEATHER)
    existing = db.scalars(
        select(WeatherReport).where(WeatherReport.user_id == user, WeatherReport.date == body.date)
    ).first()
    if not tags:
        if existing:
            db.delete(existing)
    elif existing:
        existing.tags = tags
    else:
        db.add(WeatherReport(user_id=user, date=body.date, tags=tags))
    db.commit()
