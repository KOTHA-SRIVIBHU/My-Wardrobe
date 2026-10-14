import json
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from .. import backup, storage
from ..auth import current_user, delete_login
from ..db import get_db

router = APIRouter(prefix="/api", tags=["backup"])

MAX_BACKUP_BYTES = 100 * 1024 * 1024


@router.get("/export")
def export(photos: bool = True, user: str = Depends(current_user), db: Session = Depends(get_db)):
    data = backup.export(db, user, photos)
    filename = f"closetiq-backup-{date.today().isoformat()}.json"
    return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.delete("/account")
def delete_account(confirm: bool = False, user: str = Depends(current_user), db: Session = Depends(get_db)):
    """Permanently delete everything this user has stored, and their login."""
    if not confirm:
        raise HTTPException(409, "This permanently deletes your wardrobe and account. Confirm to continue.")
    photos = backup.delete_account_data(db, user)
    db.commit()
    for path in photos:
        storage.delete(path)
    return {"deleted": True, "login_removed": delete_login(user)}


@router.post("/import")
async def restore(
    file: UploadFile,
    confirm: bool = False,
    user: str = Depends(current_user),
    db: Session = Depends(get_db),
):
    """Replaces all of the user's data with the backup. Requires confirm=true."""
    if not confirm:
        raise HTTPException(409, "Restoring replaces everything you have now. Confirm to continue.")
    raw = await file.read(MAX_BACKUP_BYTES + 1)
    if len(raw) > MAX_BACKUP_BYTES:
        raise HTTPException(413, "Backup file is too large (max 100 MB).")
    try:
        data = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise HTTPException(422, "That file isn't valid JSON.")
    if not isinstance(data, dict):
        raise HTTPException(422, "That file isn't a ClosetIQ backup.")
    try:
        counts = backup.restore(db, user, data)
    except (backup.BackupError, TypeError) as e:
        db.rollback()
        raise HTTPException(422, str(e) or "That backup couldn't be restored.")
    db.commit()
    return {"restored": counts}
