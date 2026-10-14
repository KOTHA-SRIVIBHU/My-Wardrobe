import json
from datetime import date, timedelta

from app import ai

MON = date(2030, 1, 7)


def iso(d: date) -> str:
    return d.isoformat()


def coverage(client):
    r = client.get("/api/plan/coverage", params={"today": iso(MON)})
    assert r.status_code == 200, r.text
    return r.json()


def office(client, weekdays=(0, 1, 2, 3, 4), **req):
    body = {"name": "Office", "weekdays": list(weekdays), "requirements": [{"category": "shirt", "quantity": 1, **req}]}
    assert client.post("/api/routines", json=body).status_code == 201


def test_no_routines(client):
    assert coverage(client)["status"] == "none"


def test_covered_for_a_week(client, make_garment):
    for i in range(5):
        make_garment(f"Shirt {i}", "shirt")
    office(client)
    c = coverage(client)
    assert c["status"] == "ok" and c["days"] == 7
    assert c["headline"] == "You're covered: your clean clothes meet every routine for the next 7 days."
    assert c["shortages"] == [] and c["suggestions"] == []


def test_alert_with_first_short_day_and_wash_suggestion(client, make_garment):
    shirts = [make_garment(f"Shirt {i}", "shirt") for i in range(5)]
    # Two shirts are dirty and not in any basket.
    client.post("/api/garments/actions/wear", json={"garment_ids": [shirts[0]["id"], shirts[1]["id"]], "worn_on": iso(MON - timedelta(days=3))})
    office(client)
    c = coverage(client)
    assert c["status"] == "alert"
    assert c["headline"] == "Not enough clean shirts: you'll run short from Thu 10 Jan."
    assert c["shortages"] == [{
        "routine": "Office", "category": "shirt", "required": 5, "available": 3, "missing": 2,
        "first_short": "2030-01-10", "mandatory": True,
    }]
    wash = next(s for s in c["suggestions"] if s["kind"] == "wash")
    assert wash["title"] == "Wash 2 shirts on Wed 9 Jan"
    assert sorted(wash["garment_ids"]) == sorted([shirts[0]["id"], shirts[1]["id"]])
    assert "fixes 2 of 2" in wash["detail"]

    # Acting on it: a basket on that date covers the week.
    client.post("/api/baskets", json={"name": "Fix", "garment_ids": wash["garment_ids"], "scheduled_for": wash["wash_on"]})
    c = coverage(client)
    assert c["status"] == "ok"
    # Horizon stays a week: the basket is back sooner than that.
    assert c["days"] == 7 and c["next_laundry"] == "2030-01-10"


def test_horizon_extends_to_next_laundry(client, make_garment, make_basket):
    for i in range(12):
        make_garment(f"Shirt {i}", "shirt")
    office(client, weekdays=range(7))
    dirty = make_garment("Dirty", "shirt")
    client.post("/api/garments/actions/wear", json={"garment_ids": [dirty["id"]], "worn_on": iso(MON)})
    make_basket("Big wash", [dirty["id"]], scheduled_for=iso(MON + timedelta(days=10)))
    c = coverage(client)
    assert c["days"] == 12  # washed Thu 17, dry Fri 18: 12 days inclusive
    assert c["horizon"] == "until 'Big wash' is back (Fri 18 Jan)"
    assert c["status"] == "ok"


def test_unscheduled_basket_and_stock_suggestions(client, make_garment, make_basket):
    a = make_garment("Shirt A", "shirt")
    make_garment("Shirt B", "shirt")
    client.post("/api/garments/actions/wear", json={"garment_ids": [a["id"]], "worn_on": iso(MON - timedelta(days=1))})
    basket = make_basket("Someday", [a["id"]])
    office(client)
    c = coverage(client)
    kinds = [s["kind"] for s in c["suggestions"]]
    assert kinds == ["schedule", "stock"]
    assert c["suggestions"][0]["basket_id"] == basket["id"]
    stock = c["stock"][0]
    assert stock == {"routine": "Office", "category": "shirt", "needed": 6, "owned": 2, "ok": False, "cycle_days": 8}


def test_stock_uses_laundry_days(client, make_garment):
    for i in range(3):
        make_garment(f"Shirt {i}", "shirt")
    make_garment("Shoes", "shoes")
    client.put("/api/settings", json={"laundry_weekdays": [2, 5], "drying_days": 1})
    client.post("/api/routines", json={"name": "Office", "weekdays": [0, 1, 2, 3, 4], "requirements": [
        {"category": "shirt", "quantity": 1}, {"category": "shoes", "quantity": 1, "reuse": "fixed"}]})
    stock = {s["category"]: s for s in coverage(client)["stock"]}
    # Laundry Wed+Sat: longest gap is 4 days (Sat->Wed), plus 1 drying day.
    assert stock["shirt"]["cycle_days"] == 5 and stock["shirt"]["needed"] == 4
    assert stock["shoes"]["needed"] == 1 and stock["shoes"]["ok"]


def test_coverage_alert_reaches_reminders(client, make_garment):
    make_garment("Only shirt", "shirt")
    office(client)
    notes = client.get("/api/notifications", params={"today": iso(MON)}).json()
    assert notes[0]["message"].startswith("Clothes alert: Not enough clean shirts")
    assert notes[0]["link"] == "/plan"


def test_brief_uses_only_planner_facts(client, make_garment, monkeypatch):
    make_garment("Dad's lucky shirt", "shirt", color="white")
    office(client)
    sent = []
    monkeypatch.setattr(ai, "enabled", lambda: True)

    def fake_post(payload):
        sent.append(payload)
        content = json.dumps({"summary": "Short on shirts this week.", "bullets": ["Mon: white shirt"], "tips": ["Wash on Wed", ""]})
        return ai.httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    monkeypatch.setattr(ai, "_post", fake_post)
    r = client.post("/api/plan/brief", params={"today": iso(MON)})
    assert r.status_code == 200, r.text
    assert r.json() == {"summary": "Short on shirts this week.", "bullets": ["Mon: white shirt"], "tips": ["Wash on Wed"], "status": "alert"}
    facts = sent[0]["messages"][1]["content"]
    assert "lucky" not in facts and "white shirt" in facts and "Not enough clean shirts" in facts


def test_declutter(client, make_garment):
    from app.db import SessionLocal
    from app.models import Garment

    old = make_garment("Old jumper", "sweater")
    make_garment("New tee", "t-shirt")
    with SessionLocal() as db:
        g = db.get(Garment, old["id"])
        g.created_at = g.created_at - timedelta(days=200)
        db.commit()
    d = client.get("/api/analytics").json()["declutter"]
    assert [x["name"] for x in d] == ["Old jumper"] and d[0]["never_worn"] is True
