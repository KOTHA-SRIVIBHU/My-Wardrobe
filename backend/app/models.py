import enum
import uuid
from datetime import date, datetime, timezone

# Alias for fields named `date`: with lazy annotations (PEP 649) the field name
# would otherwise shadow the type inside its own class.
DateType = date
from decimal import Decimal

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    # Stored as naive UTC so SQLite and Postgres behave the same.
    return datetime.now(timezone.utc).replace(tzinfo=None)


class GarmentState(str, enum.Enum):
    READY = "ready"
    WORN_REUSABLE = "worn_reusable"
    NEEDS_LAUNDRY = "needs_laundry"
    IN_BASKET = "in_basket"
    IN_LAUNDRY = "in_laundry"
    DRYING = "drying"
    NEEDS_IRONING = "needs_ironing"
    RESERVED = "reserved"
    UNAVAILABLE = "unavailable"


class IroningPolicy(str, enum.Enum):
    NOT_REQUIRED = "not_required"
    REQUIRED = "required"
    OPTIONAL = "optional"
    USER_DECIDES = "user_decides"


class BasketStatus(str, enum.Enum):
    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"


class BasketItemOutcome(str, enum.Enum):
    WASHED = "washed"
    NOT_PROCESSED = "not_processed"
    REMOVED = "removed"
    IRONED = "ironed"  # left the ironing basket by being ironed


def _enum(e: type[enum.Enum]) -> Enum:
    return Enum(e, native_enum=False, length=32, values_callable=lambda cls: [m.value for m in cls])


class Garment(Base):
    __tablename__ = "garments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(64), index=True)

    name: Mapped[str] = mapped_column(String(120))
    category: Mapped[str] = mapped_column(String(40))
    subcategory: Mapped[str | None] = mapped_column(String(60))
    color: Mapped[str | None] = mapped_column(String(40))
    pattern: Mapped[str | None] = mapped_column(String(40))
    labels: Mapped[list[str]] = mapped_column(JSON, default=list)
    occasions: Mapped[list[str]] = mapped_column(JSON, default=list)
    formality: Mapped[int | None] = mapped_column(Integer)  # 1 = very casual .. 5 = very formal
    seasons: Mapped[list[str]] = mapped_column(JSON, default=list)
    weather: Mapped[list[str]] = mapped_column(JSON, default=list)
    fabric: Mapped[str | None] = mapped_column(String(60))
    comfort_notes: Mapped[str | None] = mapped_column(Text)
    # None means wearing never makes it need laundry (e.g. shoes).
    # No column default: SQLAlchemy would substitute it for an explicit None.
    max_wears_before_wash: Mapped[int | None] = mapped_column(Integer)
    ironing_policy: Mapped[IroningPolicy] = mapped_column(
        _enum(IroningPolicy), default=IroningPolicy.NOT_REQUIRED
    )
    purchase_date: Mapped[date | None] = mapped_column(Date)
    purchase_price: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    notes: Mapped[str | None] = mapped_column(Text)
    image_path: Mapped[str | None] = mapped_column(String(300))

    state: Mapped[GarmentState] = mapped_column(_enum(GarmentState), default=GarmentState.READY)
    # Set while DRYING when the garment must be ironed once dry.
    iron_after_drying: Mapped[bool] = mapped_column(Boolean, default=False)
    total_wears: Mapped[int] = mapped_column(Integer, default=0)
    wears_since_wash: Mapped[int] = mapped_column(Integer, default=0)
    last_worn_on: Mapped[date | None] = mapped_column(Date)
    last_washed_at: Mapped[datetime | None] = mapped_column(DateTime)

    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    archived_reason: Mapped[str | None] = mapped_column(String(40))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class GarmentEvent(Base):
    """Append-only lifecycle history: wears, washes, ironing and every state change."""

    __tablename__ = "garment_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    garment_id: Mapped[str] = mapped_column(
        ForeignKey("garments.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(32))
    from_state: Mapped[GarmentState | None] = mapped_column(_enum(GarmentState))
    to_state: Mapped[GarmentState | None] = mapped_column(_enum(GarmentState))
    basket_id: Mapped[str | None] = mapped_column(
        ForeignKey("laundry_baskets.id", ondelete="SET NULL")
    )
    pair_id: Mapped[str | None] = mapped_column(ForeignKey("pairs.id", ondelete="SET NULL"))
    worn_on: Mapped[date | None] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(Text)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)


class Pair(Base):
    __tablename__ = "pairs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(120))
    description: Mapped[str | None] = mapped_column(Text)
    labels: Mapped[list[str]] = mapped_column(JSON, default=list)
    occasion: Mapped[str | None] = mapped_column(String(60))
    favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    items: Mapped[list["PairItem"]] = relationship(
        back_populates="pair",
        cascade="all, delete-orphan",
        order_by="PairItem.position",
        lazy="selectin",
    )


class PairItem(Base):
    __tablename__ = "pair_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    pair_id: Mapped[str] = mapped_column(ForeignKey("pairs.id", ondelete="CASCADE"), index=True)
    garment_id: Mapped[str] = mapped_column(
        ForeignKey("garments.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer, default=0)

    pair: Mapped[Pair] = relationship(back_populates="items")
    garment: Mapped[Garment] = relationship(lazy="joined")


class OutfitFeedback(Base):
    """A thumbs up/down on a combination; the outfit engine learns from these."""

    __tablename__ = "outfit_feedback"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    garment_ids: Mapped[list[str]] = mapped_column(JSON)  # sorted
    rating: Mapped[int] = mapped_column(Integer)  # +1 liked, -1 disliked
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class LaundryBasket(Base):
    __tablename__ = "laundry_baskets"
    __table_args__ = (
        # Each user has exactly one (permanent) ironing basket.
        Index(
            "uq_laundry_baskets_one_ironing",
            "user_id",
            unique=True,
            sqlite_where=text("kind = 'ironing'"),
            postgresql_where=text("kind = 'ironing'"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(120))
    # "laundry" or "ironing". Older databases may hold NULL, which means laundry.
    # The ironing basket is created automatically, holds clean clothes awaiting ironing,
    # and is never completed: it simply empties.
    kind: Mapped[str | None] = mapped_column(String(10), default="laundry")
    description: Mapped[str | None] = mapped_column(Text)
    scheduled_for: Mapped[date | None] = mapped_column(Date)
    expected_completion_at: Mapped[datetime | None] = mapped_column(DateTime)
    status: Mapped[BasketStatus] = mapped_column(_enum(BasketStatus), default=BasketStatus.PENDING)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)

    items: Mapped[list["BasketItem"]] = relationship(
        back_populates="basket",
        cascade="all, delete-orphan",
        order_by="BasketItem.added_at",
        lazy="selectin",
    )

    @property
    def active_items(self) -> list["BasketItem"]:
        return [i for i in self.items if i.active]

    @property
    def is_ironing(self) -> bool:
        return self.kind == "ironing"


class BasketItem(Base):
    __tablename__ = "basket_items"
    __table_args__ = (
        # The database itself guarantees a garment is in at most one active basket.
        Index(
            "uq_basket_items_active_garment",
            "garment_id",
            unique=True,
            sqlite_where=text("active = 1"),
            postgresql_where=text("active"),
        ),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    basket_id: Mapped[str] = mapped_column(
        ForeignKey("laundry_baskets.id", ondelete="CASCADE"), index=True
    )
    garment_id: Mapped[str] = mapped_column(ForeignKey("garments.id", ondelete="CASCADE"))
    added_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    previous_state: Mapped[GarmentState] = mapped_column(_enum(GarmentState))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    outcome: Mapped[BasketItemOutcome | None] = mapped_column(_enum(BasketItemOutcome))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime)

    basket: Mapped[LaundryBasket] = relationship(back_populates="items")
    garment: Mapped[Garment] = relationship(lazy="joined")


# --- Planning: settings, routines, events, weather, plan ------------------------


class UserSettings(Base):
    __tablename__ = "user_settings"

    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    location_name: Mapped[str | None] = mapped_column(String(120))
    latitude: Mapped[float | None] = mapped_column(Float)
    longitude: Mapped[float | None] = mapped_column(Float)
    # Weekdays (0 = Monday) on which the planner may assume a laundry run happens.
    laundry_weekdays: Mapped[list[int]] = mapped_column(JSON, default=list)
    # Days between washing and a garment being dry and wearable again.
    drying_days: Mapped[int] = mapped_column(Integer, default=1)
    # Which reminder groups to show: {"laundry": bool, "ironing": bool, "plan": bool, "events": bool}
    notification_prefs: Mapped[dict] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Routine(Base):
    """A recurring clothing requirement, e.g. office days or nightwear.

    requirements: [{category, quantity, labels, min_formality, reuse: rotate|fixed,
                    no_consecutive}]
    """

    __tablename__ = "routines"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(10), default="day")  # day | night
    weekdays: Mapped[list[int]] = mapped_column(JSON, default=list)
    start_date: Mapped[date | None] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    occasion: Mapped[str | None] = mapped_column(String(60))
    formality: Mapped[int | None] = mapped_column(Integer)
    requirements: Mapped[list[dict]] = mapped_column(JSON, default=list)
    mandatory: Mapped[bool] = mapped_column(Boolean, default=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    source_text: Mapped[str | None] = mapped_column(Text)
    notes: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class Event(Base):
    __tablename__ = "events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(30), default="custom")
    date: Mapped[DateType] = mapped_column(Date, index=True)
    start_time: Mapped[str | None] = mapped_column(String(5))  # "HH:MM"
    end_time: Mapped[str | None] = mapped_column(String(5))
    occasion: Mapped[str | None] = mapped_column(String(60))
    formality: Mapped[int | None] = mapped_column(Integer)
    labels: Mapped[list[str]] = mapped_column(JSON, default=list)
    notes: Mapped[str | None] = mapped_column(Text)
    # Holidays, travel etc. replace the usual daytime routines for that date.
    skip_day_routines: Mapped[bool] = mapped_column(Boolean, default=False)
    # Optional reserved outfit for the event.
    garment_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class WeatherReport(Base):
    """The user's own report of conditions; it complements, never overwrites, the forecast."""

    __tablename__ = "weather_reports"
    __table_args__ = (Index("uq_weather_reports_user_date", "user_id", "date", unique=True),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(64))
    date: Mapped[DateType] = mapped_column(Date)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class PlanEntry(Base):
    """One planned outfit for one slot (a routine or an event) on one date."""

    __tablename__ = "plan_entries"
    __table_args__ = (
        Index("uq_plan_entries_slot", "user_id", "date", "slot_key", unique=True),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(64))
    date: Mapped[DateType] = mapped_column(Date, index=True)
    slot_key: Mapped[str] = mapped_column(String(60))  # "routine:<id>" | "event:<id>"
    title: Mapped[str] = mapped_column(String(120))
    garment_ids: Mapped[list[str]] = mapped_column(JSON, default=list)
    locked: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(10), default="planned")  # planned | worn | skipped
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class AiUsage(Base):
    """AI calls per user per day, to keep one account from using up the shared free quota."""

    __tablename__ = "ai_usage"
    __table_args__ = (Index("uq_ai_usage_user_day", "user_id", "day", unique=True),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(String(64))
    day: Mapped[DateType] = mapped_column(Date)
    count: Mapped[int] = mapped_column(Integer, default=0)
