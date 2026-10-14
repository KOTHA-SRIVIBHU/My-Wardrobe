"""Laundry-aware planning.

A deterministic, day-by-day simulation of which garments are clean and available.
It starts from every garment's real current state and accounts for:

- baskets coming back on their scheduled / expected completion dates, plus drying time;
- assumed laundry days (user setting) that wash everything dirty;
- wear limits (a shirt worn Monday needs washing before it can be planned again);
- ironing (planned garments that need ironing get a "prep" note, not a rejection);
- reserved event outfits and locked plan entries, which are honoured first.

Nothing here calls AI, and nothing invents availability: when requirements can't be
met the result says so ("5 shirts needed, only 3 can be planned").
"""

from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from . import outfits, weather
from .lifecycle import BASKET_STATES, WEARABLE_STATES
from .models import (
    BasketItem,
    BasketStatus,
    Event,
    Garment,
    GarmentState,
    IroningPolicy,
    LaundryBasket,
    PlanEntry,
    Routine,
    UserSettings,
    WeatherReport,
)

S = GarmentState
# Alias for fields named `date`: a default value (`date: date | None = None`) would
# otherwise shadow the type while its own annotation is evaluated (Python 3.12).
DateType = date
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
MAX_DAYS = 28


def _d(d: date) -> str:
    return f"{d:%a} {d.day} {d:%b}"


def _cat_title(category: str, n: int) -> str:
    if n == 1 or category in {"trousers", "jeans", "shorts", "socks", "shoes", "underwear",
                              "nightwear", "accessories", "activewear"}:
        return category
    return category + ("es" if category.endswith(("s", "sh", "ch", "x")) else "s")


@dataclass
class Issue:
    kind: str  # shortage | conflict | unscheduled | info
    severity: str  # error | warning | info
    message: str
    date: DateType | None = None
    slot_key: str | None = None
    # For shortages: which routine requirement, and by how many items it falls short.
    ref: str | None = None
    shortfall: int = 0

    def public(self) -> dict:
        return {"kind": self.kind, "severity": self.severity, "message": self.message,
                "date": self.date, "slot_key": self.slot_key}


@dataclass
class Slot:
    key: str
    title: str
    source: str  # routine | event
    routine: Routine | None = None
    event: Event | None = None


@dataclass
class PlannedSlot:
    slot: Slot
    garment_ids: list[str]
    entry: PlanEntry | None  # the stored entry this slot came from, if any
    problems: list[str] = field(default_factory=list)
    prep: list[str] = field(default_factory=list)
    # A stored entry that no longer works (garment unavailable, slot gone): re-planning helps.
    # Plain shortages are problems too, but re-planning can't fix those.
    stale: bool = False


@dataclass
class PlanDay:
    date: date
    forecast: weather.DayWeather | None
    reported: list[str]
    effective_weather: list[str]
    events: list[Event]
    slots: list[PlannedSlot]
    issues: list[Issue]


@dataclass
class _Sim:
    g: Garment
    available_from: date | None  # None = not within the simulation (dirty / unavailable)
    dirty: bool
    wears: int
    needs_ironing: bool
    via: str | None = None  # how it comes back, e.g. "after 'Monday Laundry'"
    reserved_state: bool = False
    last_used: date | None = None


@dataclass
class _Need:
    """Running total for one routine requirement, for the feasibility summary."""

    routine: Routine
    category: str
    required: int = 0
    satisfied: int = 0
    first_short: date | None = None

    def count(self, d: date, wanted: int, got: int) -> None:
        self.required += wanted
        self.satisfied += got
        if got < wanted and (self.first_short is None or d < self.first_short):
            self.first_short = d


@dataclass
class PlanResult:
    days: list[PlanDay]
    issues: list[Issue]  # horizon-level summary (shortages, unscheduled baskets)
    weather_error: str | None
    location: str | None
    sims_at_start: dict[str, "_Sim"]


class Planner:
    def __init__(
        self,
        db: Session,
        user: str,
        start: date,
        days: int,
        *,
        today: date | None = None,
        regenerate: set[date] | None = None,
        routines: list[Routine] | None = None,
        wash_overrides: dict[str, date] | None = None,
    ):
        """
        regenerate: dates whose unlocked, planned entries are ignored and re-planned.
        routines: use these instead of the stored active routines (feasibility checks).
        wash_overrides: garment_id -> date it gets washed (laundry simulation).
        """
        self.db, self.user = db, user
        self.today = today or date.today()
        self.start = start
        self.end = start + timedelta(days=min(MAX_DAYS, max(1, days)) - 1)
        self.regenerate = regenerate or set()
        self.wash_overrides = wash_overrides or {}

        self.settings = db.get(UserSettings, user) or UserSettings(
            user_id=user, laundry_weekdays=[], drying_days=1
        )
        self.drying = max(0, self.settings.drying_days or 0)
        self.routines = (
            routines
            if routines is not None
            else list(db.scalars(select(Routine).where(Routine.user_id == user, Routine.active.is_(True))))
        )
        self.events = list(
            db.scalars(
                select(Event).where(Event.user_id == user, Event.date >= min(self.today, start), Event.date <= self.end)
            )
        )
        self.entries = {
            (e.date, e.slot_key): e
            for e in db.scalars(
                select(PlanEntry).where(
                    PlanEntry.user_id == user, PlanEntry.date >= start, PlanEntry.date <= self.end
                )
            )
        }
        # Entries between today and the requested start still consume clothes.
        if start > self.today:
            for e in db.scalars(
                select(PlanEntry).where(
                    PlanEntry.user_id == user, PlanEntry.date >= self.today, PlanEntry.date < start
                )
            ):
                self.entries[(e.date, e.slot_key)] = e
        self.reports = {
            r.date: r.tags
            for r in db.scalars(
                select(WeatherReport).where(
                    WeatherReport.user_id == user,
                    WeatherReport.date >= min(self.today, start),
                    WeatherReport.date <= self.end,
                )
            )
        }
        self.forecast, self.weather_error = weather.safe_forecast(
            self.settings.latitude, self.settings.longitude
        )
        self.outfit_ctx = outfits.load_context(db, user, outfits.OutfitRequest(today=self.today))
        self.issues: list[Issue] = []
        self.needs: dict[tuple[str, int], _Need] = {}
        self.fixed_choice: dict[tuple[str, int], list[str]] = {}
        self.sims = self._initial_state()
        self.reserved_for: dict[str, list[date]] = defaultdict(list)
        for e in self.events:
            for gid in e.garment_ids or []:
                self.reserved_for[gid].append(e.date)

    # --- initial state ---------------------------------------------------------

    def basket_return(self, b: LaundryBasket) -> date | None:
        """When a laundry basket's clothes are expected back and dry (None = unscheduled)."""
        return self._basket_return(b)

    def _basket_return(self, b: LaundryBasket) -> date | None:
        if b.status == BasketStatus.IN_PROGRESS:
            done = b.expected_completion_at.date() if b.expected_completion_at else self.today
        elif b.scheduled_for is None:
            return None
        else:
            wash = max(b.scheduled_for, self.today)
            done = max(b.expected_completion_at.date(), wash) if b.expected_completion_at else wash
        return max(done, self.today) + timedelta(days=self.drying)

    def _initial_state(self) -> dict[str, _Sim]:
        garments = self.db.scalars(
            select(Garment).where(Garment.user_id == self.user, Garment.archived.is_(False))
        ).all()
        basket_of: dict[str, LaundryBasket] = {
            i.garment_id: i.basket
            for i in self.db.scalars(
                select(BasketItem).where(BasketItem.user_id == self.user, BasketItem.active.is_(True))
            )
        }
        flagged_baskets: set[str] = set()
        sims: dict[str, _Sim] = {}
        for g in garments:
            st = g.state
            iron_policy = g.ironing_policy == IroningPolicy.REQUIRED
            if st == S.UNAVAILABLE:
                continue
            if st in WEARABLE_STATES or st == S.RESERVED:
                s = _Sim(g, self.today, False, g.wears_since_wash, False, reserved_state=st == S.RESERVED)
            elif st == S.NEEDS_IRONING:
                s = _Sim(g, self.today, False, g.wears_since_wash, True)
            elif st == S.DRYING:
                s = _Sim(g, self.today + timedelta(days=1), False, 0, g.iron_after_drying, via="once dry")
            elif st == S.NEEDS_LAUNDRY:
                s = _Sim(g, None, True, g.wears_since_wash, False)
            elif st in BASKET_STATES:
                b = basket_of.get(g.id)
                if b is not None and b.is_ironing:
                    b = None
                back = self._basket_return(b) if b else None
                if back is None:
                    s = _Sim(g, None, True, g.wears_since_wash, False)
                    if b and b.id not in flagged_baskets:
                        flagged_baskets.add(b.id)
                        self.issues.append(Issue(
                            "unscheduled", "warning",
                            f"'{b.name}' has no laundry date, so its clothes aren't counted as coming back.",
                        ))
                else:
                    s = _Sim(g, back, False, 0, iron_policy, via=f"after '{b.name}'")
            else:
                continue
            if g.id in self.wash_overrides:
                back = max(self.wash_overrides[g.id], self.today) + timedelta(days=self.drying)
                s = _Sim(g, back, False, 0, iron_policy, via=f"after washing on {_d(self.wash_overrides[g.id])}")
            sims[g.id] = s
        return sims

    # --- simulation helpers --------------------------------------------------------

    def _available(self, s: _Sim, d: date) -> bool:
        return not s.dirty and s.available_from is not None and s.available_from <= d

    def _why_unavailable(self, s: _Sim | None, name: str, d: date) -> str:
        if s is None:
            return f"{name} is no longer available"
        if s.dirty:
            return f"{name} will need washing first"
        if s.available_from and s.available_from > d:
            back = f" {s.via}" if s.via else ""
            return f"{name} isn't back until {_d(s.available_from)}{back}"
        return f"{name} isn't available"

    def _wash_day(self, d: date) -> None:
        if d.weekday() not in (self.settings.laundry_weekdays or []):
            return
        for s in self.sims.values():
            if s.dirty:
                s.dirty = False
                s.wears = 0
                s.available_from = d + timedelta(days=self.drying)
                s.needs_ironing = s.g.ironing_policy == IroningPolicy.REQUIRED
                s.via = f"after your {WEEKDAYS[d.weekday()]} laundry"

    def _consume(self, s: _Sim, d: date) -> None:
        s.wears += 1
        s.last_used = d
        s.needs_ironing = False
        limit = s.g.max_wears_before_wash
        if limit is not None and s.wears >= limit:
            s.dirty = True
            s.available_from = None

    def _prep_for(self, s: _Sim, d: date) -> list[str]:
        notes = []
        if s.needs_ironing:
            notes.append(f"Iron {s.g.name} before {_d(d)}")
        if s.via and s.available_from and s.available_from > self.today:
            notes.append(f"{s.g.name} comes back {s.via} ({_d(s.available_from)})")
        return notes

    def _blocked_by_reservation(self, s: _Sim, d: date, slot: Slot) -> bool:
        """Don't use a garment reserved for a later event if that would dirty it first."""
        if s.reserved_state:
            return not (slot.event and s.g.id in (slot.event.garment_ids or []))
        upcoming = [e for e in self.reserved_for.get(s.g.id, []) if e > d]
        if not upcoming or (slot.event and s.g.id in (slot.event.garment_ids or [])):
            return False
        limit = s.g.max_wears_before_wash
        return limit is not None and s.wears + 1 >= limit

    def _weather_for(self, d: date) -> tuple[weather.DayWeather | None, list[str], list[str]]:
        fc = self.forecast.get(d)
        reported = self.reports.get(d, [])
        effective = reported or (fc.tags if fc else [])
        return fc, reported, effective

    def _slots_for(self, d: date) -> tuple[list[Event], list[Slot]]:
        events = sorted((e for e in self.events if e.date == d), key=lambda e: e.start_time or "")
        skip_day = any(e.skip_day_routines for e in events)
        slots = [Slot(f"event:{e.id}", e.title, "event", event=e) for e in events]
        routines = [
            r for r in self.routines
            if d.weekday() in (r.weekdays or [])
            and (r.start_date is None or r.start_date <= d)
            and (r.end_date is None or d <= r.end_date)
            and not (skip_day and r.kind == "day")
        ]
        # Mandatory day routines first, flexible next, night routines last.
        routines.sort(key=lambda r: (r.kind == "night", not r.mandatory, r.name.lower()))
        slots += [Slot(f"routine:{r.id}", r.name, "routine", routine=r) for r in routines]
        return events, slots

    # --- choosing garments ---------------------------------------------------------

    def _pref(self, s: _Sim, r: Routine, weather_tags: list[str]) -> float:
        g = s.g
        tags = {t.lower() for t in [*g.labels, *g.occasions]}
        score = 0.0
        if r.occasion and r.occasion.lower() in tags:
            score += 1
        if r.formality and g.formality:
            score += 1 - abs(g.formality - r.formality) / 4
        if weather_tags and g.weather:
            score += 1 if set(g.weather) & set(weather_tags) else -0.5
        if s.needs_ironing:
            score -= 0.25
        return score

    def _pick_routine(self, d: date, slot: Slot, used: set[str], weather_tags: list[str]) -> PlannedSlot:
        r = slot.routine
        assert r is not None
        planned = PlannedSlot(slot, [], None)
        for idx, req in enumerate(r.requirements or []):
            category = req.get("category", "")
            qty = max(1, int(req.get("quantity") or 1))
            labels = {x.lower() for x in req.get("labels") or []}
            min_formality = req.get("min_formality")
            need = self.needs.setdefault((r.id, idx), _Need(r, category))

            def eligible(s: _Sim) -> bool:
                g = s.g
                return (
                    g.category == category
                    and g.id not in used
                    and self._available(s, d)
                    and not self._blocked_by_reservation(s, d, slot)
                    and (not labels or labels & {t.lower() for t in [*g.labels, *g.occasions]})
                    and (min_formality is None or g.formality is None or g.formality >= min_formality)
                )

            candidates = [s for s in self.sims.values() if eligible(s)]
            if req.get("no_consecutive"):
                fresh = [s for s in candidates if s.last_used != d - timedelta(days=1)]
                if len(fresh) >= qty or not candidates:
                    candidates = fresh
                else:
                    planned.problems.append(f"Repeats a {category} from yesterday (not enough alternatives)")
            preferred = self.fixed_choice.get((r.id, idx), []) if req.get("reuse") == "fixed" else []
            candidates.sort(key=lambda s: (
                s.g.id not in preferred,
                -round(self._pref(s, r, weather_tags) * 2) / 2,
                s.last_used or date.min,
                s.wears,
            ))
            chosen = candidates[:qty]
            if req.get("reuse") == "fixed" and chosen:
                self.fixed_choice[(r.id, idx)] = [s.g.id for s in chosen]
            if self.start <= d <= self.end:
                need.count(d, qty, len(chosen))
            if len(chosen) < qty:
                missing = qty - len(chosen)
                planned.problems.append(f"Missing {missing} {_cat_title(category, missing)}")
            for s in chosen:
                used.add(s.g.id)
                planned.garment_ids.append(s.g.id)
                planned.prep += self._prep_for(s, d)
                self._consume(s, d)
        return planned

    def _pick_event(self, d: date, slot: Slot, used: set[str], weather_tags: list[str]) -> PlannedSlot | None:
        e = slot.event
        assert e is not None
        if e.garment_ids:
            return self._apply(d, slot, list(e.garment_ids), None, used, reserved=True)
        if not (e.occasion or e.formality):
            return None  # no dress code: nothing to plan
        pool = [
            s.g for s in self.sims.values()
            if s.g.id not in used and self._available(s, d) and not self._blocked_by_reservation(s, d, slot)
        ]
        ctx = outfits.with_request(
            self.outfit_ctx,
            outfits.OutfitRequest(occasion=e.occasion, formality=e.formality, weather=weather_tags, today=d),
        )
        ranked = outfits.rank(pool, ctx)
        if not ranked:
            planned = PlannedSlot(slot, [], None, problems=["No complete outfit is available"])
            return planned
        planned = PlannedSlot(slot, [], None)
        for g in ranked[0].garments:
            s = self.sims[g.id]
            used.add(g.id)
            planned.garment_ids.append(g.id)
            planned.prep += self._prep_for(s, d)
            self._consume(s, d)
        return planned

    def _apply(
        self, d: date, slot: Slot, garment_ids: list[str], entry: PlanEntry | None,
        used: set[str], *, reserved: bool = False,
    ) -> PlannedSlot:
        """Apply a fixed list of garments (stored entry or reserved outfit), checking each."""
        planned = PlannedSlot(slot, list(garment_ids), entry)
        if entry is not None and entry.status != "planned":
            return planned  # already worn or skipped: real states already reflect it
        applied: list[str] = []
        for gid in garment_ids:
            s = self.sims.get(gid)
            name = s.g.name if s else "A garment"
            if s is None or not self._available(s, d) or gid in used:
                reason = f"{name} is already used in another outfit that day" if gid in used else self._why_unavailable(s, name, d)
                planned.problems.append(reason)
                planned.stale = True
                continue
            used.add(gid)
            applied.append(gid)
            planned.prep += self._prep_for(s, d)
            self._consume(s, d)
        if planned.problems and reserved:
            planned.problems.insert(0, "Reserved outfit has a problem")
        if slot.routine is not None:
            self._check_coverage(d, slot.routine, applied, planned)
        return planned

    def _check_coverage(self, d: date, r: Routine, garment_ids: list[str], planned: PlannedSlot) -> None:
        """A stored routine entry still has to meet the routine's requirements."""
        remaining = [self.sims[g].g.category for g in garment_ids if g in self.sims]
        for idx, req in enumerate(r.requirements or []):
            category = req.get("category", "")
            qty = max(1, int(req.get("quantity") or 1))
            have = 0
            while have < qty and category in remaining:
                remaining.remove(category)
                have += 1
            need = self.needs.setdefault((r.id, idx), _Need(r, category))
            if self.start <= d <= self.end:
                need.count(d, qty, have)
            if have < qty:
                planned.problems.append(f"Missing {qty - have} {_cat_title(category, qty - have)}")

    # --- main loop --------------------------------------------------------------

    def run(self) -> PlanResult:
        sims_at_start = {k: _Sim(**vars(v)) for k, v in self.sims.items()}
        self.sims_initial = sims_at_start
        days: list[PlanDay] = []
        d = self.today
        last = self.end
        while d <= last:
            self._wash_day(d)
            events, slots = self._slots_for(d)
            fc, reported, effective = self._weather_for(d)
            used: set[str] = set()
            planned_slots: list[PlannedSlot] = []
            day_issues: list[Issue] = []
            for slot in slots:
                entry = self.entries.get((d, slot.key))
                if entry and not (d in self.regenerate and not entry.locked and entry.status == "planned"):
                    planned = self._apply(d, slot, entry.garment_ids, entry, used)
                elif slot.source == "event":
                    planned = self._pick_event(d, slot, used, effective)
                else:
                    planned = self._pick_routine(d, slot, used, effective)
                if planned is None:
                    continue
                planned_slots.append(planned)
                severity = "error" if (planned.slot.routine is None or planned.slot.routine.mandatory) else "warning"
                for p in planned.problems:
                    day_issues.append(Issue("conflict" if planned.entry else "shortage", severity,
                                            f"{slot.title}: {p}", d, slot.key))
            # Stored entries whose routine/event no longer applies to this date.
            keys = {s.key for s in slots}
            for (ed, key), entry in self.entries.items():
                if ed == d and key not in keys and entry.status == "planned":
                    orphan = PlannedSlot(Slot(key, entry.title, key.split(":")[0]), entry.garment_ids, entry,
                                         problems=["No longer needed: its routine or event changed"], stale=True)
                    planned_slots.append(orphan)
                    day_issues.append(Issue("conflict", "warning", f"{entry.title}: no longer needed", d, key))
            if d >= self.start:
                days.append(PlanDay(d, fc, reported, effective, events, planned_slots, day_issues))
            d += timedelta(days=1)

        summary = list(self.issues)
        n_days = (self.end - self.start).days + 1
        for (routine_id, idx), need in self.needs.items():
            if need.satisfied < need.required:
                summary.append(Issue(
                    "shortage", "error" if need.routine.mandatory else "warning",
                    f"{need.routine.name}: {need.required} clean {_cat_title(need.category, need.required)} "
                    f"needed over these {n_days} days, but only {need.satisfied} can be planned.",
                    ref=f"{routine_id}:{idx}", shortfall=need.required - need.satisfied,
                ))
        if any(i.kind == "shortage" for i in summary) and not self.settings.laundry_weekdays:
            summary.append(Issue(
                "info", "info",
                "Tip: set your usual laundry days in plan settings so the planner can count on clothes coming back.",
            ))
        return PlanResult(days, summary, self.weather_error, self.settings.location_name, sims_at_start)


# --- persistence ----------------------------------------------------------------


def save_generated(db: Session, user: str, result: PlanResult, dates: set[date]) -> None:
    """Replace unlocked, planned entries on `dates` with the freshly generated slots."""
    if not dates:
        return
    db.execute(
        delete(PlanEntry).where(
            PlanEntry.user_id == user,
            PlanEntry.date.in_(dates),
            PlanEntry.locked.is_(False),
            PlanEntry.status == "planned",
        )
    )
    db.flush()
    for day in result.days:
        if day.date not in dates:
            continue
        for ps in day.slots:
            if ps.entry is not None or not ps.garment_ids:
                continue  # kept (locked/worn) entries stay; empty slots aren't stored
            db.add(PlanEntry(
                user_id=user, date=day.date, slot_key=ps.slot.key,
                title=ps.slot.title, garment_ids=ps.garment_ids,
            ))


def affected_dates(result: PlanResult, today: date) -> list[date]:
    """Dates with stored, unlocked entries that no longer work, or slots never planned."""
    out = []
    for day in result.days:
        if day.date < today:
            continue
        stored = [s for s in day.slots if s.entry is not None]
        broken = any(s.stale and not s.entry.locked and s.entry.status == "planned" for s in stored)
        # Unsaved slots with garments = something new (e.g. an event) since the plan was saved.
        missing = stored and any(s.entry is None and s.garment_ids for s in day.slots)
        if broken or missing:
            out.append(day.date)
    return out


def regenerate(db: Session, user: str, start: date, days: int, dates: set[date] | None = None,
               today: date | None = None) -> PlanResult:
    today = today or date.today()
    end = start + timedelta(days=min(MAX_DAYS, days) - 1)
    targets = {d for d in (dates or _dates(start, end)) if today <= d <= end}
    result = Planner(db, user, start, days, today=today, regenerate=targets).run()
    save_generated(db, user, result, targets)
    return result


def _dates(start: date, end: date) -> set[date]:
    return {start + timedelta(days=i) for i in range((end - start).days + 1)}


def replan_if_planned(db: Session, user: str, dates: list[date]) -> None:
    """After a calendar change, refresh unlocked entries on dates the user has planned."""
    today = date.today()
    targets = {d for d in dates if d >= today}
    if not targets:
        return
    has_plan = db.scalars(
        select(PlanEntry.id).where(PlanEntry.user_id == user, PlanEntry.date.in_(targets)).limit(1)
    ).first()
    if has_plan:
        first, last = min(targets), max(targets)
        regenerate(db, user, first, (last - first).days + 1, targets, today)
