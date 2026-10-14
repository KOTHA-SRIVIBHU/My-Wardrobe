import os
import tempfile
from pathlib import Path

from dotenv import load_dotenv

# backend/.env.test (git-ignored) may hold TEST_DATABASE_URL.
load_dotenv(Path(__file__).resolve().parents[1] / ".env.test")

# Must be set before the app is imported. Tests never use backend/.env's real services.
# TEST_DATABASE_URL (optional) runs the suite on Postgres, in an isolated schema that is
# wiped between tests; the app's own tables in "public" are never touched.
if os.getenv("TEST_DATABASE_URL"):
    os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
    os.environ["DB_SCHEMA"] = "closetiq_test"
else:
    os.environ["DATABASE_URL"] = "sqlite://"
    os.environ["DB_SCHEMA"] = ""
os.environ["ENVIRONMENT"] = "development"
os.environ["AUTH_MODE"] = "dev"
os.environ["RATE_LIMIT_PER_MINUTE"] = "0"
os.environ["AI_DAILY_LIMIT_PER_USER"] = "40"
os.environ["MAX_GARMENTS_PER_USER"] = "1500"
os.environ["STORAGE_MODE"] = "local"
os.environ["UPLOAD_DIR"] = tempfile.mkdtemp(prefix="closetiq-test-")
# Never call the real Groq API from tests, whatever backend/.env contains.
os.environ["GROQ_API_KEY"] = ""
os.environ["GROQ_VISION_MODEL"] = "qwen/qwen3.8-27b"
os.environ["GROQ_TEXT_MODEL"] = "openai/gpt-oss-120b"

import pytest
from fastapi.testclient import TestClient

from app.db import Base, engine
from app.main import app


@pytest.fixture
def client():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with TestClient(app) as c:
        yield c


@pytest.fixture
def make_garment(client):
    def _make(name="White shirt", category="shirt", **extra):
        r = client.post("/api/garments", json={"name": name, "category": category, **extra})
        assert r.status_code == 201, r.text
        return r.json()

    return _make


@pytest.fixture
def make_basket(client):
    def _make(name="Monday Laundry", garment_ids=(), **extra):
        r = client.post(
            "/api/baskets", json={"name": name, "garment_ids": list(garment_ids), **extra}
        )
        assert r.status_code == 201, r.text
        return r.json()["basket"]

    return _make


def state_of(client, garment_id: str) -> str:
    return client.get(f"/api/garments/{garment_id}").json()["state"]
