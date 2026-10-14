from datetime import date, datetime, timezone

# Alias for fields named `date`: with lazy annotations (PEP 649) the field name
# would otherwise shadow the type inside its own class.
DateType = date
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, field_validator

from .models import BasketItemOutcome, BasketStatus, GarmentState, IroningPolicy


def _to_naive_utc(v: datetime | None) -> datetime | None:
    if v is not None and v.tzinfo is not None:
        return v.astimezone(timezone.utc).replace(tzinfo=None)
    return v


UtcDateTime = Annotated[datetime, AfterValidator(_to_naive_utc)]


def _clean_tags(v: list[str]) -> list[str]:
    seen: dict[str, str] = {}
    for tag in v:
        tag = tag.strip()
        if tag and tag.lower() not in seen:
            seen[tag.lower()] = tag
    return list(seen.values())


Tags = Annotated[list[str], AfterValidator(_clean_tags)]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# --- Garments -----------------------------------------------------------------


class GarmentFields(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    category: str = Field(min_length=1, max_length=40)
    subcategory: str | None = Field(default=None, max_length=60)
    color: str | None = Field(default=None, max_length=40)
    pattern: str | None = Field(default=None, max_length=40)
    labels: Tags = []
    occasions: Tags = []
    formality: int | None = Field(default=None, ge=1, le=5)
    seasons: Tags = []
    weather: Tags = []
    fabric: str | None = Field(default=None, max_length=60)
    comfort_notes: str | None = None
    max_wears_before_wash: int | None = Field(default=None, ge=1, le=100)
    ironing_policy: IroningPolicy | None = None
    purchase_date: date | None = None
    purchase_price: Decimal | None = Field(default=None, ge=0, max_digits=10, decimal_places=2)
    notes: str | None = None

    @field_validator("category")
    @classmethod
    def _lower_category(cls, v: str) -> str:
        return v.strip().lower()


class GarmentCreate(GarmentFields):
    # When omitted, max_wears_before_wash / ironing_policy come from category defaults.
    use_category_defaults: bool = True
    state: GarmentState = GarmentState.READY

    @field_validator("state")
    @classmethod
    def _not_basket_state(cls, v: GarmentState) -> GarmentState:
        if v in (GarmentState.IN_BASKET, GarmentState.IN_LAUNDRY):
            raise ValueError("new garments can't start in a laundry basket")
        return v


class GarmentUpdate(BaseModel):
    """Partial update. Send null for max_wears_before_wash to mean 'never by wear count'."""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    category: str | None = Field(default=None, min_length=1, max_length=40)
    subcategory: str | None = None
    color: str | None = None
    pattern: str | None = None
    labels: Tags | None = None
    occasions: Tags | None = None
    formality: int | None = Field(default=None, ge=1, le=5)
    seasons: Tags | None = None
    weather: Tags | None = None
    fabric: str | None = None
    comfort_notes: str | None = None
    max_wears_before_wash: int | None = Field(default=None, ge=1, le=100)
    ironing_policy: IroningPolicy | None = None
    purchase_date: date | None = None
    purchase_price: Decimal | None = Field(default=None, ge=0, max_digits=10, decimal_places=2)
    notes: str | None = None

    @field_validator("category")
    @classmethod
    def _lower_category(cls, v: str | None) -> str | None:
        return v.strip().lower() if v else v


class BasketRef(BaseModel):
    id: str
    name: str
    status: BasketStatus
    kind: str = "laundry"


class GarmentOut(ORM):
    id: str
    name: str
    category: str
    subcategory: str | None
    color: str | None
    pattern: str | None
    labels: list[str]
    occasions: list[str]
    formality: int | None
    seasons: list[str]
    weather: list[str]
    fabric: str | None
    comfort_notes: str | None
    max_wears_before_wash: int | None
    ironing_policy: IroningPolicy
    purchase_date: date | None
    purchase_price: Decimal | None
    notes: str | None
    image_url: str | None = None
    state: GarmentState
    iron_after_drying: bool
    total_wears: int
    wears_since_wash: int
    last_worn_on: date | None
    last_washed_at: datetime | None
    archived: bool
    archived_reason: str | None
    created_at: datetime
    updated_at: datetime
    wearable: bool = False
    active_basket: BasketRef | None = None


class GarmentEventOut(ORM):
    id: str
    kind: str
    from_state: GarmentState | None
    to_state: GarmentState | None
    basket_id: str | None
    pair_id: str | None
    worn_on: date | None
    note: str | None
    at: datetime


class StateOverride(BaseModel):
    state: GarmentState
    note: str | None = Field(default=None, max_length=500)


class ArchiveRequest(BaseModel):
    reason: Literal["archived", "no_longer_owned", "damaged", "donated", "sold"] = "archived"


class GarmentIds(BaseModel):
    garment_ids: list[str] = Field(min_length=1, max_length=200)


class WearRequest(GarmentIds):
    worn_on: date | None = None


class WashRequest(GarmentIds):
    dry: bool = True
    needs_ironing: bool | None = None


# --- Pairs --------------------------------------------------------------------


class PairFields(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None
    labels: Tags = []
    occasion: str | None = Field(default=None, max_length=60)
    favorite: bool = False
    notes: str | None = None


class PairCreate(PairFields):
    garment_ids: list[str] = Field(min_length=1, max_length=20)


class PairUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    labels: Tags | None = None
    occasion: str | None = None
    favorite: bool | None = None
    notes: str | None = None
    garment_ids: list[str] | None = Field(default=None, min_length=1, max_length=20)


class Blocker(BaseModel):
    garment_id: str
    garment_name: str
    reason: str


class PairOut(PairFields):
    id: str
    created_at: datetime
    updated_at: datetime
    garments: list[GarmentOut]
    wearable: bool
    blockers: list[Blocker]


class PairWearRequest(BaseModel):
    worn_on: date | None = None


# --- Laundry baskets ----------------------------------------------------------


class BasketFields(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = None
    scheduled_for: date | None = None
    expected_completion_at: UtcDateTime | None = None
    notes: str | None = None


class BasketCreate(BasketFields):
    garment_ids: list[str] = Field(default=[], max_length=200)


class BasketUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = None
    scheduled_for: date | None = None
    expected_completion_at: UtcDateTime | None = None
    notes: str | None = None


class BasketItemOut(ORM):
    id: str
    garment: GarmentOut
    added_at: datetime
    previous_state: GarmentState
    active: bool
    outcome: BasketItemOutcome | None
    resolved_at: datetime | None


class BasketOut(BasketFields):
    id: str
    kind: str = "laundry"
    status: BasketStatus
    created_at: datetime
    started_at: datetime | None
    completed_at: datetime | None
    garment_count: int
    items: list[BasketItemOut] = []


class BasketMutationOut(BaseModel):
    basket: BasketOut
    warnings: list[str] = []


class RemoveFromBasket(BaseModel):
    confirm: bool = False
    restore_to: GarmentState | None = None


class GarmentOutcome(BaseModel):
    garment_id: str
    result: Literal["dry", "drying", "unavailable", "not_processed"]
    needs_ironing: bool | None = None


class CompleteBasket(BaseModel):
    default_result: Literal["dry", "drying"] = "dry"
    outcomes: list[GarmentOutcome] = []


# --- AI & outfits ---------------------------------------------------------------


class ClassificationOut(BaseModel):
    name: str | None
    category: str
    subcategory: str | None
    color: str | None
    pattern: str | None
    fabric: str | None
    formality: int | None
    occasions: list[str]
    labels: list[str]
    seasons: list[str]
    weather: list[str]


class OutfitRequestIn(BaseModel):
    occasion: str | None = Field(default=None, max_length=60)
    formality: int | None = Field(default=None, ge=1, le=5)
    weather: Tags = []
    count: int = Field(default=5, ge=1, le=10)
    today: date | None = None


class OutfitOut(BaseModel):
    garments: list[GarmentOut]
    score: int
    breakdown: dict[str, float]
    reasons: list[str]
    cautions: list[str]


class OutfitsOut(BaseModel):
    outfits: list[OutfitOut]
    notes: list[str]


class OutfitFeedbackIn(BaseModel):
    garment_ids: list[str] = Field(min_length=2, max_length=20)
    rating: Literal[1, -1]


class ExplainIn(BaseModel):
    garment_ids: list[str] = Field(min_length=1, max_length=20)
    occasion: str | None = Field(default=None, max_length=60)
    weather: Tags = []


class ExplainOut(BaseModel):
    summary: str
    tips: list[str]


# --- Routines -------------------------------------------------------------------


class Requirement(BaseModel):
    category: str = Field(min_length=1, max_length=40)
    quantity: int = Field(default=1, ge=1, le=10)
    labels: Tags = []
    min_formality: int | None = Field(default=None, ge=1, le=5)
    reuse: Literal["rotate", "fixed"] = "rotate"
    no_consecutive: bool = False

    @field_validator("category")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.strip().lower()


def _clean_weekdays(v: list[int]) -> list[int]:
    if any(d < 0 or d > 6 for d in v):
        raise ValueError("weekdays are 0 (Monday) to 6 (Sunday)")
    return sorted(set(v))


Weekdays = Annotated[list[int], AfterValidator(_clean_weekdays)]


class RoutineIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    kind: Literal["day", "night"] = "day"
    weekdays: Weekdays = Field(min_length=1)
    start_date: date | None = None
    end_date: date | None = None
    occasion: str | None = Field(default=None, max_length=60)
    formality: int | None = Field(default=None, ge=1, le=5)
    requirements: list[Requirement] = Field(min_length=1, max_length=15)
    mandatory: bool = True
    active: bool = True
    notes: str | None = None
    source_text: str | None = None

    @field_validator("end_date")
    @classmethod
    def _end_after_start(cls, v: date | None, info) -> date | None:
        start = info.data.get("start_date")
        if v and start and v < start:
            raise ValueError("end_date must be on or after start_date")
        return v


class RoutineOut(RoutineIn, ORM):
    id: str
    created_at: datetime
    updated_at: datetime


class RoutineDraft(BaseModel):
    """AI interpretation output: like RoutineIn but may be incomplete until the user edits it."""

    name: str
    kind: Literal["day", "night"]
    weekdays: list[int]
    occasion: str | None
    formality: int | None
    mandatory: bool
    requirements: list[Requirement]


class InterpretIn(BaseModel):
    text: str = Field(min_length=3, max_length=2000)


class InterpretOut(BaseModel):
    routines: list[RoutineDraft]
    questions: list[str]


class IssueOut(BaseModel):
    kind: str
    severity: str
    message: str
    date: DateType | None = None
    slot_key: str | None = None


class FeasibilityIn(BaseModel):
    routine: RoutineIn | None = None  # an unsaved draft to include
    routine_id: str | None = None  # the stored routine the draft replaces
    start: date | None = None
    days: int = Field(default=14, ge=1, le=28)


class FeasibilityOut(BaseModel):
    ok: bool
    days: int
    issues: list[IssueOut]


# --- Calendar, settings, weather ---------------------------------------------------

EventKind = Literal["office", "college", "holiday", "party", "interview", "wedding", "travel", "gym", "custom"]
TimeStr = Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]


class EventIn(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    kind: EventKind = "custom"
    date: DateType
    start_time: TimeStr | None = None
    end_time: TimeStr | None = None
    occasion: str | None = Field(default=None, max_length=60)
    formality: int | None = Field(default=None, ge=1, le=5)
    labels: Tags = []
    notes: str | None = None
    # None = decide from kind (holidays and travel replace daytime routines).
    skip_day_routines: bool | None = None
    garment_ids: list[str] = Field(default=[], max_length=20)


class EventOut(ORM):
    id: str
    title: str
    kind: str
    date: DateType
    start_time: str | None
    end_time: str | None
    occasion: str | None
    formality: int | None
    labels: list[str]
    notes: str | None
    skip_day_routines: bool
    garment_ids: list[str]


class SettingsIn(BaseModel):
    location_name: str | None = Field(default=None, max_length=120)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    laundry_weekdays: Weekdays = []
    drying_days: int = Field(default=1, ge=0, le=7)
    notification_prefs: dict[Literal["laundry", "ironing", "plan", "events"], bool] = {}


class SettingsOut(SettingsIn):
    pass


class WeatherReportIn(BaseModel):
    date: DateType
    tags: list[str] = Field(max_length=7)


class DayWeatherOut(BaseModel):
    temp_max: float | None
    temp_min: float | None
    feels_max: float | None
    precip_probability: int | None
    wind_max: float | None
    humidity: float | None
    tags: list[str]


# --- Plan -------------------------------------------------------------------------


class PlanSlotOut(BaseModel):
    key: str
    title: str
    source: str
    routine_id: str | None
    event_id: str | None
    entry_id: str | None
    saved: bool
    locked: bool
    status: str
    garments: list[GarmentOut]
    problems: list[str]
    prep: list[str]


class PlanDayOut(BaseModel):
    date: DateType
    forecast: DayWeatherOut | None
    reported: list[str]
    weather: list[str]
    events: list[EventOut]
    slots: list[PlanSlotOut]
    issues: list[IssueOut]


class PlanOut(BaseModel):
    start: date
    days: list[PlanDayOut]
    issues: list[IssueOut]
    affected_dates: list[date]
    has_plan: bool
    location: str | None
    weather_error: str | None


class GenerateIn(BaseModel):
    start: date | None = None
    days: int = Field(default=7, ge=1, le=28)
    dates: list[date] | None = None  # only these dates; default = whole range


class EntryUpdate(BaseModel):
    locked: bool | None = None
    garment_ids: list[str] | None = Field(default=None, max_length=20)
    status: Literal["planned", "worn", "skipped"] | None = None


class SimulateIn(BaseModel):
    basket_id: str | None = None
    garment_ids: list[str] = Field(default=[], max_length=200)
    wash_on: date | None = None
    days: int = Field(default=7, ge=1, le=28)


class NamedRef(BaseModel):
    id: str
    name: str


class SimulateOut(BaseModel):
    wash_on: date
    returns_on: date
    unavailable: list[GarmentOut]
    pairs_possible: list[NamedRef]
    pairs_blocked: list[NamedRef]
    scarce: list[str]
    new_issues: list[IssueOut]
    resolved_issues: list[IssueOut]
    affected_events: list[str]
    preparation: list[str]
    covered: bool


# --- Dashboard ----------------------------------------------------------------


class Warning_(BaseModel):
    kind: str
    message: str
    basket_id: str | None = None
    garment_id: str | None = None


class Dashboard(BaseModel):
    today: date
    garments_total: int
    garments_wearable: int
    state_counts: dict[str, int]
    category_counts: dict[str, dict[str, int]]
    baskets_pending: list[BasketOut]
    baskets_due_today: list[BasketOut]
    baskets_in_progress: list[BasketOut]
    baskets_recently_completed: list[BasketOut]
    ironing_basket: BasketOut | None = None
    drying: list[GarmentOut]
    needs_ironing: list[GarmentOut]
    needs_laundry: list[GarmentOut]
    warnings: list[Warning_]
