from datetime import date

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import insights
from ..auth import current_user
from ..db import get_db
from ..schemas import GarmentOut, Tags
from ..serialize import garments_out
from .dashboard import dashboard

router = APIRouter(prefix="/api", tags=["insights"])


@router.get("/analytics")
def analytics(
    days: int = Query(90, ge=7, le=365),
    today: date | None = None,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    return insights.analytics(db, user, today or date.today(), days)


class PackingIn(BaseModel):
    start: date
    nights: int = Field(ge=0, le=30)
    activities: Tags = []
    laundry_available: bool = False
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)


class PackingSection(BaseModel):
    title: str
    needed: int
    garments: list[GarmentOut]
    shortfall: str | None


class PackingOut(BaseModel):
    days: int
    weather: list[str]
    sections: list[PackingSection]
    notes: list[str]


@router.post("/packing", response_model=PackingOut)
def packing(
    body: PackingIn,
    today: date | None = None,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    today = today or date.today()
    req = insights.PackingRequest(
        start=max(body.start, today), nights=body.nights, activities=body.activities,
        laundry_available=body.laundry_available, latitude=body.latitude, longitude=body.longitude,
    )
    result = insights.packing_list(db, user, req, today)
    for section in result["sections"]:
        section["garments"] = garments_out(db, section["garments"])
    return result


class PurchaseIn(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    category: str = Field(min_length=1, max_length=40)
    color: str | None = Field(default=None, max_length=40)
    pattern: str | None = Field(default=None, max_length=40)
    formality: int | None = Field(default=None, ge=1, le=5)
    occasions: Tags = []
    weather: Tags = []


@router.post("/analysis/purchase")
def purchase(
    body: PurchaseIn,
    today: date | None = None,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    item = body.model_dump()
    item["category"] = item["category"].strip().lower()
    return insights.purchase_analysis(db, user, item, today or date.today())


@router.get("/notifications")
def notifications(
    today: date | None = None,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    today = today or date.today()
    warnings = dashboard(today=today, user=user, db=db).warnings
    return insights.reminders(db, user, today, warnings)
