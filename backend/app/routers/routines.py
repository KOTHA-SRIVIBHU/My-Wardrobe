from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import ai
from ..auth import current_user
from ..limits import ai_allowance
from ..db import get_db
from ..lifecycle import CATEGORY_DEFAULTS
from ..models import Garment, Routine
from ..planner import Planner
from ..schemas import (
    FeasibilityIn,
    FeasibilityOut,
    InterpretIn,
    InterpretOut,
    IssueOut,
    RoutineIn,
    RoutineOut,
)
from ..serialize import get_owned

router = APIRouter(prefix="/api/routines", tags=["routines"])


def _dump(body: RoutineIn) -> dict:
    return body.model_dump()


@router.get("", response_model=list[RoutineOut])
def list_routines(user: str = Depends(current_user), db: Session = Depends(get_db)):
    return db.scalars(
        select(Routine).where(Routine.user_id == user).order_by(Routine.kind, Routine.name)
    ).all()


@router.post("", response_model=RoutineOut, status_code=201)
def create_routine(body: RoutineIn, user: str = Depends(current_user), db: Session = Depends(get_db)):
    r = Routine(user_id=user, **_dump(body))
    db.add(r)
    db.commit()
    return r


@router.put("/{routine_id}", response_model=RoutineOut)
def replace_routine(
    routine_id: str, body: RoutineIn, user: str = Depends(current_user), db: Session = Depends(get_db)
):
    r = get_owned(db, Routine, routine_id, user)
    for k, v in _dump(body).items():
        setattr(r, k, v)
    db.commit()
    return r


@router.delete("/{routine_id}", status_code=204)
def delete_routine(routine_id: str, user: str = Depends(current_user), db: Session = Depends(get_db)):
    db.delete(get_owned(db, Routine, routine_id, user))
    db.commit()


@router.post("/interpret", response_model=InterpretOut)
def interpret(body: InterpretIn, user: str = Depends(current_user), db: Session = Depends(get_db)):
    """AI turns a description into draft routines. Nothing is saved until the user confirms."""
    owned = db.scalars(select(Garment.category).where(Garment.user_id == user).distinct()).all()
    categories = list(dict.fromkeys([*CATEGORY_DEFAULTS, *owned]))
    with ai_allowance(db, user):
        return ai.interpret_routines(body.text, categories)


@router.post("/check", response_model=FeasibilityOut)
def check_feasibility(
    body: FeasibilityIn, user: str = Depends(current_user), db: Session = Depends(get_db)
):
    """Can the wardrobe cover the active routines (plus an optional draft) over the period?"""
    routines = list(db.scalars(select(Routine).where(Routine.user_id == user, Routine.active.is_(True))))
    if body.routine is not None:
        draft = Routine(id=body.routine_id or "draft", user_id=user, **_dump(body.routine))
        routines = [r for r in routines if r.id != draft.id] + [draft]
    today = date.today()
    start = max(body.start or today, today)
    dates = {start + timedelta(days=i) for i in range(body.days)}
    result = Planner(db, user, start, body.days, today=today, routines=routines, regenerate=dates).run()
    issues = [IssueOut(**i.public()) for i in result.issues]
    # The draft Routine is transient (never added to the session) and nothing is committed.
    return FeasibilityOut(
        ok=not any(i.severity == "error" for i in issues),
        days=body.days,
        issues=issues,
    )
