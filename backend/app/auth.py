from functools import lru_cache

import httpx
import jwt
from fastapi import Header, HTTPException, status

from .config import settings
from .limits import check_rate


@lru_cache(maxsize=1)
def _jwks_client() -> jwt.PyJWKClient:
    return jwt.PyJWKClient(f"{settings.supabase_url}/auth/v1/.well-known/jwks.json")


def _decode(token: str) -> dict:
    alg = jwt.get_unverified_header(token).get("alg")
    if alg == "HS256":
        # Legacy Supabase projects sign with a shared secret.
        if not settings.supabase_jwt_secret:
            raise jwt.InvalidTokenError("HS256 token but SUPABASE_JWT_SECRET is not set")
        return jwt.decode(
            token, settings.supabase_jwt_secret, algorithms=["HS256"], audience="authenticated"
        )
    key = _jwks_client().get_signing_key_from_jwt(token).key
    return jwt.decode(token, key, algorithms=["RS256", "ES256"], audience="authenticated")


def delete_login(user_id: str) -> bool:
    """Remove the Supabase Auth user (needs the service key). True if it's gone."""
    if settings.auth_mode != "supabase" or not settings.supabase_service_key:
        return False
    key = settings.supabase_service_key
    try:
        r = httpx.delete(
            f"{settings.supabase_url}/auth/v1/admin/users/{user_id}",
            headers={"Authorization": f"Bearer {key}", "apikey": key},
            timeout=15,
        )
    except httpx.HTTPError:
        return False
    return r.status_code in (200, 204, 404)


def current_user(authorization: str | None = Header(default=None)) -> str:
    """Returns the caller's user id. Every query is scoped by this value.

    Also applies the per-user request rate limit, since every route depends on this.
    """
    if settings.auth_mode == "dev":
        user = settings.dev_user_id
    else:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing bearer token")
        try:
            claims = _decode(authorization.split(" ", 1)[1])
        except jwt.PyJWTError:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
        user = claims.get("sub")
        if not user:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token has no subject")
    check_rate(user)
    return user
