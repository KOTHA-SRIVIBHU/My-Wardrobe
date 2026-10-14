from collections import defaultdict
from datetime import date, timedelta

# Alias for fields named `date`: with lazy annotations (PEP 649) the field name
# would otherwise shadow the type inside its own class.
DateType = date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import ai, coverage, lifecycle, planner
from ..auth import current_user
from ..limits import ai_allowance
from ..db import get_db
from ..models import Garment, LaundryBasket, Pair, PlanEntry
from ..schemas import (
    DayWeatherOut,
    EntryUpdate,
    EventOut,
    GarmentOut,
    GenerateIn,
    IssueOut,
    NamedRef,
    PlanDayOut,
    PlanOut,
    PlanSlotOut,
    SimulateIn,
    SimulateOut,
)
from ..serialize import garments_out, get_owned, get_owned_garments

router = APIRouter(prefix="/api/plan", tags=["plan"])


def _issue(i: planner.Issue) -> IssueOut:
    return IssueOut(**i.public())


def _plan_out(db: Session, user: str, result: planner.PlanResult, start: date, today: date) -> PlanOut:
    ids = {gid for day in result.days for s in day.slots for gid in s.garment_ids}
    garments = db.scalars(select(Garment).where(Garment.user_id == user, Garment.id.in_(ids))).all()
    by_id = {g.id: g for g in garments_out(db, garments)}
    days = []
    for day in result.days:
        slots = []
        for s in day.slots:
            source, _, ref = s.slot.key.partition(":")
            slots.append(PlanSlotOut(
                key=s.slot.key,
                title=s.slot.title,
                source=source,
                routine_id=ref if source == "routine" else None,
                event_id=ref if source == "event" else None,
                entry_id=s.entry.id if s.entry else None,
                saved=s.entry is not None,
                locked=bool(s.entry and s.entry.locked),
                status=s.entry.status if s.entry else "planned",
                garments=[by_id[g] for g in s.garment_ids if g in by_id],
                problems=s.problems,
                prep=list(dict.fromkeys(s.prep)),
            ))
        fc = day.forecast
        days.append(PlanDayOut(
            date=day.date,
            forecast=DayWeatherOut(**{k: v for k, v in vars(fc).items() if k != "date"}) if fc else None,
            reported=day.reported,
            weather=day.effective_weather,
            events=[EventOut.model_validate(e) for e in day.events],
            slots=slots,
            issues=[_issue(i) for i in day.issues],
        ))
    has_plan = any(s.saved for d in days for s in d.slots)
    return PlanOut(
        start=start,
        days=days,
        issues=[_issue(i) for i in result.issues],
        affected_dates=planner.affected_dates(result, today),
        has_plan=has_plan,
        location=result.location,
        weather_error=result.weather_error,
    )


def _window(start: date | None, today: date | None) -> tuple[date, date]:
    today = today or date.today()
    return max(start or today, today), today


@router.get("", response_model=PlanOut)
def get_plan(
    start: date | None = None,
    days: int = Query(7, ge=1, le=28),
    today: date | None = None,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    """The plan from `start` (never before today). Unsaved slots are live suggestions."""
    start, today = _window(start, today)
    result = planner.Planner(db, user, start, days, today=today).run()
    return _plan_out(db, user, result, start, today)


@router.post("/generate", response_model=PlanOut)
def generate(
    body: GenerateIn,
    today: date | None = None,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Save a fresh plan for the range (or just `dates`). Locked and worn entries are kept."""
    start, today = _window(body.start, today)
    planner.regenerate(db, user, start, body.days, set(body.dates) if body.dates else None, today)
    db.commit()
    result = planner.Planner(db, user, start, body.days, today=today).run()
    return _plan_out(db, user, result, start, today)


class EntryCreate(BaseModel):
    date: DateType
    slot_key: str = Field(min_length=3, max_length=60)
    title: str = Field(min_length=1, max_length=120)
    garment_ids: list[str] = Field(min_length=1, max_length=20)
    locked: bool = True


@router.post("/entries", status_code=201)
def save_entry(body: EntryCreate, user: str = Depends(current_user), db: Session = Depends(get_db)):
    """Save (and by default lock) a suggested slot, replacing any stored one."""
    get_owned_garments(db, body.garment_ids, user)
    entry = db.scalars(
        select(PlanEntry).where(
            PlanEntry.user_id == user, PlanEntry.date == body.date, PlanEntry.slot_key == body.slot_key
        )
    ).first()
    if entry is None:
        entry = PlanEntry(user_id=user, date=body.date, slot_key=body.slot_key)
        db.add(entry)
    entry.title = body.title
    entry.garment_ids = list(dict.fromkeys(body.garment_ids))
    entry.locked = body.locked
    entry.status = "planned"
    db.commit()
    return {"id": entry.id}


@router.patch("/entries/{entry_id}", status_code=204)
def update_entry(
    entry_id: str, body: EntryUpdate, user: str = Depends(current_user), db: Session = Depends(get_db)
):
    entry = get_owned(db, PlanEntry, entry_id, user)
    if body.garment_ids is not None:
        get_owned_garments(db, body.garment_ids, user)
        entry.garment_ids = list(dict.fromkeys(body.garment_ids))
        entry.locked = True  # a hand-picked outfit shouldn't be replaced automatically
    if body.locked is not None:
        entry.locked = body.locked
    if body.status is not None:
        entry.status = body.status
    db.commit()


@router.delete("/entries/{entry_id}", status_code=204)
def delete_entry(entry_id: str, user: str = Depends(current_user), db: Session = Depends(get_db)):
    db.delete(get_owned(db, PlanEntry, entry_id, user))
    db.commit()


@router.post("/entries/{entry_id}/wear", response_model=list[GarmentOut])
def wear_entry(
    entry_id: str,
    today: date | None = None,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    entry = get_owned(db, PlanEntry, entry_id, user)
    if entry.date > (today or date.today()):
        raise HTTPException(409, "You can only mark today's or past outfits as worn.")
    if entry.status == "worn":
        raise HTTPException(409, "Already marked as worn.")
    garments = get_owned_garments(db, entry.garment_ids, user)
    for g in garments:
        lifecycle.mark_worn(db, g, entry.date)
    entry.status = "worn"
    db.commit()
    return garments_out(db, garments)


# --- Coverage & brief ----------------------------------------------------------------


@router.get("/coverage")
def get_coverage(today: date | None = None, user: str = Depends(current_user), db: Session = Depends(get_db)):
    """Will my clean clothes last until the next laundry? With shortages and fixes."""
    return coverage.coverage(db, user, today or date.today())


@router.post("/brief")
def brief(today: date | None = None, user: str = Depends(current_user), db: Session = Depends(get_db)):
    """AI-written briefing of the coming days, built only from the planner's facts."""
    today = today or date.today()
    cov = coverage.coverage(db, user, today)
    result = planner.Planner(db, user, today, min(7, cov["days"]), today=today).run()

    def describe(gid: str, sims) -> str | None:
        s = sims.get(gid)
        # Colour + category only: no personal garment names leave the app.
        return " ".join(x for x in (s.g.color, s.g.category) if x) if s else None

    days = [
        {
            "date": f"{d.date:%a %d %b}",
            "weather": d.effective_weather,
            "events": [e.title for e in d.events],
            "outfits": [
                {"for": s.slot.title, "wear": [w for w in (describe(g, result.sims_at_start) for g in s.garment_ids) if w],
                 "problems": s.problems, "prep": [p for p in s.prep if p.startswith("Iron")]}
                for s in d.slots
            ],
        }
        for d in result.days
    ]
    facts = {
        "coverage": cov["headline"],
        "checked": cov["horizon"],
        "shortages": [{k: s[k] for k in ("routine", "category", "missing", "first_short")} for s in cov["shortages"]],
        "suggested_fixes": [s["title"] for s in cov["suggestions"]],
        "days": days,
    }
    with ai_allowance(db, user):
        written = ai.weekly_brief(facts)
    return {**written, "status": cov["status"]}


# --- Laundry simulation ------------------------------------------------------------


@router.post("/simulate", response_model=SimulateOut)
def simulate(
    body: SimulateIn,
    today: date | None = None,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    """What happens to the coming days if these garments (or a basket) are washed on a date?"""
    today = today or date.today()
    if body.basket_id:
        basket = get_owned(db, LaundryBasket, body.basket_id, user)
        if basket.is_ironing:
            raise HTTPException(422, "Simulation is for laundry baskets.")
        ids = [i.garment_id for i in basket.active_items]
        wash_on = body.wash_on or basket.scheduled_for or today
    else:
        ids = [g.id for g in get_owned_garments(db, body.garment_ids, user)] if body.garment_ids else []
        wash_on = body.wash_on or today
    if not ids:
        raise HTTPException(422, "Choose some garments (or a basket with garments) to simulate.")
    wash_on = max(wash_on, today)
    dates = {today + timedelta(days=i) for i in range(body.days)}

    baseline = planner.Planner(db, user, today, body.days, today=today, regenerate=dates).run()
    sim = planner.Planner(db, user, today, body.days, today=today, regenerate=dates,
                          wash_overrides={gid: wash_on for gid in ids})
    scenario = sim.run()
    returns_on = wash_on + timedelta(days=sim.drying)

    garments = get_owned_garments(db, ids, user)
    unavailable = [g for g in garments if lifecycle.is_wearable(g)]

    start_state = scenario.sims_at_start
    def ready_now(gid: str) -> bool:
        s = start_state.get(gid)
        return bool(s and not s.dirty and s.available_from and s.available_from <= today)

    pairs = db.scalars(select(Pair).where(Pair.user_id == user)).all()
    possible = [NamedRef(id=p.id, name=p.name) for p in pairs if p.items and all(ready_now(i.garment_id) for i in p.items)]
    blocked = [NamedRef(id=p.id, name=p.name) for p in pairs
               if any(i.garment_id in ids for i in p.items) and not all(ready_now(i.garment_id) for i in p.items)]

    owned: dict[str, int] = defaultdict(int)
    ready: dict[str, int] = defaultdict(int)
    for gid, s in start_state.items():
        owned[s.g.category] += 1
        ready[s.g.category] += ready_now(gid)
    touched = {g.category for g in garments}
    scarce = [
        f"Only {ready[c]} of your {owned[c]} {c} will be ready while this washes"
        for c in sorted(touched) if owned[c] >= 2 and ready[c] <= 1
    ]

    def shortages(r: planner.PlanResult) -> dict[str, planner.Issue]:
        return {i.ref or i.message: i for i in r.issues if i.kind == "shortage"}

    base_s, scen_s = shortages(baseline), shortages(scenario)
    # Compare per routine requirement: worse in the scenario = new, better = resolved.
    worse = [i for k, i in scen_s.items() if i.shortfall > (base_s[k].shortfall if k in base_s else 0)]
    better = [i for k, i in base_s.items() if i.shortfall > (scen_s[k].shortfall if k in scen_s else 0)]
    affected = []
    for day in scenario.days:
        for e in day.events:
            hit = [g.name for g in garments if g.id in (e.garment_ids or [])]
            if hit and e.date < returns_on:
                affected.append(f"{e.title} ({e.date:%a %d %b}) needs {', '.join(hit)}, back {returns_on:%a %d %b}")
    to_iron = [g for g in garments if g.ironing_policy.value == "required"]
    prep = [f"{len(to_iron)} of these will need ironing after washing"] if to_iron else []
    if sim.drying:
        prep.append(f"Allowing {sim.drying} day(s) to dry")

    return SimulateOut(
        wash_on=wash_on,
        returns_on=returns_on,
        unavailable=garments_out(db, unavailable),
        pairs_possible=possible,
        pairs_blocked=blocked,
        scarce=scarce,
        new_issues=[_issue(i) for i in worse],
        resolved_issues=[_issue(i) for i in better],
        affected_events=affected,
        preparation=prep,
        covered=not any(i.severity == "error" for i in scen_s.values()),
    )
