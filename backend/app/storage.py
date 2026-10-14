"""Garment photo storage: local disk for development, Supabase Storage in the cloud."""

import uuid

import httpx

from .config import settings

ALLOWED_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
MAX_BYTES = 8 * 1024 * 1024
SIGNED_URL_TTL = 60 * 60


class StorageError(Exception):
    pass


def new_path(user_id: str, garment_id: str, content_type: str) -> str:
    return f"{user_id}/{garment_id}/{uuid.uuid4().hex}.{ALLOWED_TYPES[content_type]}"


def _sb_headers() -> dict[str, str]:
    key = settings.supabase_service_key or ""
    return {"Authorization": f"Bearer {key}", "apikey": key}


def save(path: str, data: bytes, content_type: str) -> None:
    if settings.storage_mode == "supabase":
        r = httpx.post(
            f"{settings.supabase_url}/storage/v1/object/{settings.storage_bucket}/{path}",
            content=data,
            headers={**_sb_headers(), "Content-Type": content_type, "x-upsert": "true"},
            timeout=30,
        )
        if r.status_code >= 300:
            raise StorageError(f"Upload failed ({r.status_code})")
        return
    target = settings.upload_dir / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


def load(path: str) -> bytes | None:
    """Read a stored photo (for backups). None if it can't be read."""
    try:
        if settings.storage_mode == "supabase":
            r = httpx.get(
                f"{settings.supabase_url}/storage/v1/object/{settings.storage_bucket}/{path}",
                headers=_sb_headers(),
                timeout=30,
            )
            return r.content if r.status_code == 200 else None
        return (settings.upload_dir / path).read_bytes()
    except (OSError, httpx.HTTPError):
        return None


def delete(path: str) -> None:
    """Best effort: a leftover file must never block a wardrobe change."""
    try:
        if settings.storage_mode == "supabase":
            httpx.request(
                "DELETE",
                f"{settings.supabase_url}/storage/v1/object/{settings.storage_bucket}",
                json={"prefixes": [path]},
                headers=_sb_headers(),
                timeout=15,
            )
        else:
            (settings.upload_dir / path).unlink(missing_ok=True)
    except (OSError, httpx.HTTPError):
        pass


def urls_for(paths: list[str]) -> dict[str, str]:
    """Viewable URLs for stored photos. Supabase URLs are short-lived signed links."""
    paths = sorted({p for p in paths if p})
    if not paths:
        return {}
    if settings.storage_mode != "supabase":
        return {p: f"/media/{p}" for p in paths}
    try:
        r = httpx.post(
            f"{settings.supabase_url}/storage/v1/object/sign/{settings.storage_bucket}",
            json={"expiresIn": SIGNED_URL_TTL, "paths": paths},
            headers=_sb_headers(),
            timeout=15,
        )
        r.raise_for_status()
    except httpx.HTTPError:
        return {}  # photos are optional; the wardrobe still works without them
    return {
        row["path"]: f"{settings.supabase_url}/storage/v1{row['signedURL']}"
        for row in r.json()
        if row.get("signedURL")
    }
