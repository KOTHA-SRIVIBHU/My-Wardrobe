from datetime import date

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlalchemy.orm import Session

from .. import ai, outfits
from ..auth import current_user
from ..config import settings
from ..limits import ai_allowance, ai_used_today
from ..db import get_db
from ..schemas import (
    ClassificationOut,
    ExplainIn,
    ExplainOut,
    OutfitFeedbackIn,
    OutfitOut,
    OutfitRequestIn,
    OutfitsOut,
)
from ..serialize import garments_out, get_owned_garments

router = APIRouter(prefix="/api", tags=["outfits"])

# Groq caps base64 image requests; the frontend downsizes photos well below this.
MAX_CLASSIFY_BYTES = 4 * 1024 * 1024
CLASSIFY_TYPES = {"image/jpeg", "image/png", "image/webp"}


@router.get("/ai/status")
def ai_status(user: str = Depends(current_user), db: Session = Depends(get_db)):
    return {**ai.status(), "daily_limit": settings.ai_daily_limit, "used_today": ai_used_today(db, user)}


@router.post("/ai/classify", response_model=ClassificationOut)
async def classify(file: UploadFile, user: str = Depends(current_user), db: Session = Depends(get_db)):
    """Suggests garment details from a photo. Nothing is saved; the user reviews first."""
    if file.content_type not in CLASSIFY_TYPES:
        raise HTTPException(415, "Photos must be JPEG, PNG or WebP")
    data = await file.read(MAX_CLASSIFY_BYTES + 1)
    if len(data) > MAX_CLASSIFY_BYTES:
        raise HTTPException(413, "Photo is too large for AI suggestions (max 4 MB)")
    try:
        with ai_allowance(db, user):
            return ai.classify_image(data, file.content_type)
    except ai.NotClothing:
        raise HTTPException(422, "That photo doesn't seem to show a garment.")


@router.post("/outfits/generate", response_model=OutfitsOut)
def generate(
    body: OutfitRequestIn, user: str = Depends(current_user), db: Session = Depends(get_db)
):
    req = outfits.OutfitRequest(
        occasion=body.occasion,
        formality=body.formality,
        weather=body.weather,
        count=body.count,
        today=body.today or date.today(),
    )
    suggestions, notes = outfits.generate(db, user, req)
    serialized = {g.id: g for g in garments_out(db, {g for s in suggestions for g in s.garments})}
    return OutfitsOut(
        outfits=[
            OutfitOut(
                garments=[serialized[g.id] for g in s.garments],
                score=s.score,
                breakdown={k: round(v, 2) for k, v in s.breakdown.items()},
                reasons=s.reasons,
                cautions=s.cautions,
            )
            for s in suggestions
        ],
        notes=notes,
    )


@router.post("/outfits/feedback", status_code=204)
def feedback(
    body: OutfitFeedbackIn, user: str = Depends(current_user), db: Session = Depends(get_db)
):
    get_owned_garments(db, body.garment_ids, user)
    outfits.record_feedback(db, user, body.garment_ids, body.rating)
    db.commit()


@router.post("/outfits/explain", response_model=ExplainOut)
def explain(body: ExplainIn, user: str = Depends(current_user), db: Session = Depends(get_db)):
    garments = get_owned_garments(db, body.garment_ids, user)
    described = [
        {
            k: v
            for k, v in {
                "category": g.category,
                "subcategory": g.subcategory,
                "color": g.color,
                "pattern": g.pattern,
                "fabric": g.fabric,
                "formality": g.formality,
            }.items()
            if v is not None
        }
        for g in garments
    ]
    context = {"occasion": body.occasion, "weather": body.weather}
    with ai_allowance(db, user):
        return ai.explain_outfit(described, {k: v for k, v in context.items() if v})
