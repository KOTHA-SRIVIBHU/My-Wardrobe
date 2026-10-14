"""Abuse protection and account lifecycle for an open-sign-up deployment."""

import json

import pytest
from fastapi import HTTPException

from app import ai
from app.config import settings
from app.limits import RateLimiter

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32


def test_rate_limiter():
    rl = RateLimiter()
    for _ in range(3):
        rl.check("u", 3)
    with pytest.raises(HTTPException) as e:
        rl.check("u", 3)
    assert e.value.status_code == 429 and "Retry-After" in e.value.headers
    rl.check("other-user", 3)  # limits are per user
    rl.check("u", 0)  # 0 = disabled


@pytest.fixture
def groq_ok(monkeypatch):
    monkeypatch.setattr(ai, "enabled", lambda: True)
    reply = json.dumps({"summary": "Nice.", "tips": []})
    monkeypatch.setattr(ai, "_post", lambda payload: ai.httpx.Response(200, json={"choices": [{"message": {"content": reply}}]}))


def test_daily_ai_allowance(client, make_garment, groq_ok, monkeypatch):
    monkeypatch.setattr(type(settings), "ai_daily_limit", property(lambda self: 2), raising=False)
    g = make_garment()
    body = {"garment_ids": [g["id"]]}
    assert client.post("/api/outfits/explain", json=body).status_code == 200
    assert client.post("/api/outfits/explain", json=body).status_code == 200
    r = client.post("/api/outfits/explain", json=body)
    assert r.status_code == 429 and r.json()["code"] == "ai_user_limit"
    status = client.get("/api/ai/status").json()
    assert status["used_today"] == 2 and status["daily_limit"] == 2


def test_failed_ai_calls_dont_count(client, monkeypatch):
    monkeypatch.setattr(ai, "enabled", lambda: True)
    monkeypatch.setattr(ai, "_post", lambda payload: ai.httpx.Response(200, json={"choices": [{"message": {"content": '{"error": "not_clothing"}'}}]}))
    r = client.post("/api/ai/classify", files={"file": ("x.png", PNG, "image/png")})
    assert r.status_code == 422
    assert client.get("/api/ai/status").json()["used_today"] == 0


def test_garment_cap(client, make_garment, monkeypatch):
    monkeypatch.setattr(type(settings), "max_garments_per_user", property(lambda self: 2), raising=False)
    make_garment("A")
    make_garment("B")
    r = client.post("/api/garments", json={"name": "C", "category": "shirt"})
    assert r.status_code == 409 and "limit of 2" in r.json()["detail"]


def test_delete_account(client, make_garment, make_basket):
    g = make_garment()
    client.post(f"/api/garments/{g['id']}/image", files={"file": ("s.png", PNG, "image/png")})
    image_url = client.get(f"/api/garments/{g['id']}").json()["image_url"]
    make_basket("Wash", [g["id"]])
    client.post("/api/routines", json={"name": "R", "weekdays": [0], "requirements": [{"category": "shirt"}]})
    client.put("/api/settings", json={"drying_days": 3})
    assert client.delete("/api/account").status_code == 409  # needs confirmation
    r = client.delete("/api/account?confirm=true")
    assert r.status_code == 200 and r.json()["deleted"] is True
    assert r.json()["login_removed"] is False  # dev mode has no Supabase login
    assert client.get("/api/garments").json() == []
    assert client.get("/api/baskets").json() == []
    assert client.get("/api/routines").json() == []
    assert client.get("/api/settings").json()["drying_days"] == 1
    assert client.get(image_url).status_code == 404  # photo removed from storage


def test_security_headers_and_health(client):
    r = client.get("/api/health?deep=true")
    assert r.json()["database"] == "ok"
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"


def test_production_refuses_dev_auth(monkeypatch):
    from app.config import load_settings

    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.setenv("AUTH_MODE", "dev")
    with pytest.raises(RuntimeError):
        load_settings()
