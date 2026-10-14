import json
from datetime import date, timedelta

import pytest

from app import ai, weather
from conftest import state_of

MON = date(2030, 1, 7)
assert MON.weekday() == 0
WEEKDAYS = [0, 1, 2, 3, 4]
EVERY_DAY = list(range(7))


def iso(d: date) -> str:
    return d.isoformat()


def day(n: int) -> str:
    return iso(MON + timedelta(days=n))


@pytest.fixture
def routine(client):
    def _make(name="Office", weekdays=WEEKDAYS, requirements=None, **extra):
        body = {
            "name": name,
            "weekdays": weekdays,
            "requirements": requirements or [{"category": "shirt", "quantity": 1}],
            **extra,
        }
        r = client.post("/api/routines", json=body)
        assert r.status_code == 201, r.text
        return r.json()

    return _make


def get_plan(client, days=5, start=MON):
    r = client.get("/api/plan", params={"start": iso(start), "days": days, "today": iso(MON)})
    assert r.status_code == 200, r.text
    return r.json()


def generate(client, days=5, **extra):
    r = client.post(f"/api/plan/generate?today={iso(MON)}", json={"start": iso(MON), "days": days, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def slot(plan, n, title):
    return next(s for s in plan["days"][n]["slots"] if s["title"] == title)


def names(s):
    return [g["name"] for g in s["garments"]]


# --- Routines ----------------------------------------------------------------------


def test_routine_validation(client, routine):
    r = client.post("/api/routines", json={"name": "X", "weekdays": [7], "requirements": [{"category": "shirt"}]})
    assert r.status_code == 422
    r = client.post("/api/routines", json={"name": "X", "weekdays": [1], "requirements": []})
    assert r.status_code == 422
    made = routine(weekdays=[4, 0, 0], requirements=[{"category": " Socks ", "quantity": 2}])
    assert made["weekdays"] == [0, 4]
    assert made["requirements"][0]["category"] == "socks"
    r = client.put(f"/api/routines/{made['id']}", json={**made, "active": False})
    assert r.json()["active"] is False
    assert client.delete(f"/api/routines/{made['id']}").status_code == 204


def test_shortage_is_reported_not_invented(client, make_garment, routine):
    for i in range(3):
        make_garment(f"Shirt {i}", "shirt")
    routine()
    plan = get_plan(client)
    planned = [slot(plan, n, "Office") for n in range(5)]
    assert [len(s["garments"]) for s in planned] == [1, 1, 1, 0, 0]
    assert planned[3]["problems"] == ["Missing 1 shirt"]
    messages = [i["message"] for i in plan["issues"]]
    assert "Office: 5 clean shirts needed over these 5 days, but only 3 can be planned." in messages
    assert any(m.startswith("Tip: set your usual laundry days") for m in messages)
    # Each shirt is planned once (shirts need washing after every wear).
    worn = [n for s in planned for n in names(s)]
    assert len(worn) == len(set(worn)) == 3


def test_laundry_day_brings_clothes_back(client, make_garment, routine):
    for i in range(2):
        make_garment(f"Shirt {i}", "shirt", ironing_policy="not_required")
    routine()
    client.put("/api/settings", json={"laundry_weekdays": [2], "drying_days": 0})  # Wednesday
    plan = get_plan(client)
    assert all(len(slot(plan, n, "Office")["garments"]) == 1 for n in range(4))
    assert slot(plan, 4, "Office")["garments"] == []  # Wed+Thu used both again
    wed = slot(plan, 2, "Office")
    assert any("after your Wednesday laundry" in p for p in wed["prep"])


def test_basket_return_and_ironing_prep(client, make_garment, make_basket, routine):
    shirt = make_garment("Blue shirt", "shirt")  # ironing required
    make_basket("Monday Laundry", [shirt["id"]], scheduled_for=iso(MON))  # back Tue (1 drying day)
    routine(weekdays=EVERY_DAY)
    plan = get_plan(client, days=3)
    assert slot(plan, 0, "Office")["garments"] == []
    tue = slot(plan, 1, "Office")
    assert names(tue) == ["Blue shirt"]
    assert "Iron Blue shirt before Tue 8 Jan" in tue["prep"]
    assert any("after 'Monday Laundry'" in p for p in tue["prep"])


def test_unscheduled_basket_warns(client, make_garment, make_basket, routine):
    shirt = make_garment("Blue shirt", "shirt")
    make_basket("Someday", [shirt["id"]])
    routine()
    issues = get_plan(client)["issues"]
    assert any(i["kind"] == "unscheduled" and "Someday" in i["message"] for i in issues)


def test_fixed_reuse_and_category_rules(client, make_garment, routine):
    make_garment("Office shoes", "shoes")
    make_garment("Other shoes", "shoes")
    for i in range(5):
        make_garment(f"Shirt {i}", "shirt")
    routine(requirements=[
        {"category": "shirt", "quantity": 1},
        {"category": "shoes", "quantity": 1, "reuse": "fixed"},
    ])
    plan = get_plan(client)
    shoes = {n for d in range(5) for n in names(slot(plan, d, "Office")) if "shoes" in n}
    assert len(shoes) == 1  # the same pair all week


def test_min_formality_filter(client, make_garment, routine):
    make_garment("Formal shirt", "shirt", formality=5)
    make_garment("Casual shirt", "shirt", formality=2)
    routine(requirements=[{"category": "shirt", "quantity": 1, "min_formality": 4}])
    plan = get_plan(client, days=2)
    assert names(slot(plan, 0, "Office")) == ["Formal shirt"]
    assert slot(plan, 1, "Office")["problems"] == ["Missing 1 shirt"]


# --- Events, holidays, reservations -------------------------------------------------


def test_holiday_skips_day_routines_but_not_night(client, make_garment, routine):
    make_garment("Shirt", "shirt")
    make_garment("PJs", "nightwear")
    routine()
    routine("Night", EVERY_DAY, [{"category": "nightwear", "quantity": 1}], kind="night")
    r = client.post("/api/events", json={"title": "Holiday", "kind": "holiday", "date": iso(MON)})
    assert r.json()["skip_day_routines"] is True
    titles = [s["title"] for s in get_plan(client, days=1)["days"][0]["slots"]]
    assert titles == ["Night"]


def test_event_dress_code_generates_outfit(client, make_garment):
    make_garment("Party shirt", "shirt", labels=["Party"], color="black")
    make_garment("Office shirt", "shirt", labels=["Office"], color="white")
    make_garment("Jeans", "jeans", labels=["Party"], color="blue")
    client.post("/api/events", json={"title": "Birthday", "kind": "party", "date": iso(MON), "occasion": "Party"})
    s = slot(get_plan(client, days=1), 0, "Birthday")
    assert set(names(s)) == {"Party shirt", "Jeans"}


def test_reserved_outfit_is_protected(client, make_garment, routine):
    best = make_garment("Wedding shirt", "shirt")
    make_garment("Spare shirt", "shirt")
    routine(weekdays=EVERY_DAY)
    client.post("/api/events", json={"title": "Wedding", "date": day(2), "garment_ids": [best["id"]]})
    plan = get_plan(client, days=3)
    used_before = [n for d in range(2) for n in names(slot(plan, d, "Office"))]
    assert "Wedding shirt" not in used_before
    assert names(slot(plan, 2, "Wedding")) == ["Wedding shirt"]


def test_reserved_outfit_conflict_is_reported(client, make_garment, make_basket):
    shirt = make_garment("Wedding shirt", "shirt")
    make_basket("Later", [shirt["id"]], scheduled_for=day(5))
    client.post("/api/events", json={"title": "Wedding", "date": day(1), "garment_ids": [shirt["id"]]})
    s = slot(get_plan(client, days=2), 1, "Wedding")
    assert s["problems"][0] == "Reserved outfit has a problem"
    assert "isn't back until" in s["problems"][1]


# --- Saving, locking, replanning ------------------------------------------------------


def test_generate_lock_and_partial_replan(client, make_garment, routine):
    for i in range(5):
        make_garment(f"Shirt {i}", "shirt")
    routine()
    plan = generate(client)
    assert plan["has_plan"] and plan["affected_dates"] == []
    mon = slot(plan, 0, "Office")
    assert mon["saved"] and not mon["locked"]
    # Hand-pick Monday's shirt: it gets locked and survives regeneration.
    other = slot(plan, 4, "Office")["garments"][0]["id"]
    client.patch(f"/api/plan/entries/{mon['entry_id']}", json={"garment_ids": [other]})
    plan = generate(client)
    mon = slot(plan, 0, "Office")
    assert mon["locked"] and mon["garments"][0]["id"] == other
    all_ids = [g["id"] for d in range(5) for g in slot(plan, d, "Office")["garments"]]
    assert len(all_ids) == len(set(all_ids)) == 5


def test_basket_change_flags_affected_days(client, make_garment, make_basket, routine):
    for i in range(3):
        make_garment(f"Shirt {i}", "shirt")
    routine(weekdays=[0, 1, 2])
    plan = generate(client, days=3)
    wed_shirt = slot(plan, 2, "Office")["garments"][0]
    make_basket("Oops", [wed_shirt["id"]])
    plan = get_plan(client, days=3)
    assert slot(plan, 2, "Office")["problems"] == [
        f"{wed_shirt['name']} will need washing first",
        "Missing 1 shirt",
    ]
    assert plan["affected_dates"] == [day(2)]
    plan = generate(client, days=3, dates=[day(2)])
    assert plan["affected_dates"] == []


def test_saved_plan_keeps_reporting_shortages(client, make_garment, routine):
    make_garment("Shirt", "shirt")
    make_garment("Socks", "socks")
    routine(requirements=[{"category": "shirt", "quantity": 1}, {"category": "socks", "quantity": 1}])
    plan = generate(client, days=2)
    tue = slot(plan, 1, "Office")
    assert tue["saved"] is False  # nothing could be planned, so nothing was stored
    assert tue["problems"] == ["Missing 1 shirt", "Missing 1 socks"]
    # Re-planning can't fix a pure shortage, so it isn't flagged as "affected".
    assert plan["affected_dates"] == []
    assert any("2 clean shirts needed" in i["message"] for i in plan["issues"])
    # A hand-edited entry is checked against the routine too.
    mon = slot(plan, 0, "Office")
    shirt_only = [g["id"] for g in mon["garments"] if g["category"] == "shirt"]
    client.patch(f"/api/plan/entries/{mon['entry_id']}", json={"garment_ids": shirt_only})
    assert slot(get_plan(client, days=1), 0, "Office")["problems"] == ["Missing 1 socks"]


def test_new_event_replans_saved_days(client, make_garment, routine):
    make_garment("Shirt", "shirt", max_wears_before_wash=10)
    routine()
    generate(client)
    client.post("/api/events", json={"title": "Day off", "kind": "holiday", "date": day(1)})
    plan = get_plan(client)
    assert [s["title"] for s in plan["days"][1]["slots"]] == []
    assert plan["affected_dates"] == []


def test_wear_planned_entry(client, make_garment, routine):
    make_garment("Shirt", "shirt")
    routine()
    entry = slot(generate(client, days=1), 0, "Office")
    r = client.post(f"/api/plan/entries/{entry['entry_id']}/wear?today={iso(MON)}")
    assert r.status_code == 200
    assert state_of(client, entry["garments"][0]["id"]) == "needs_laundry"
    assert slot(get_plan(client, days=1), 0, "Office")["status"] == "worn"
    assert client.post(f"/api/plan/entries/{entry['entry_id']}/wear?today={iso(MON)}").status_code == 409


def test_cannot_wear_future_entry(client, make_garment, routine):
    make_garment("Shirt", "shirt", max_wears_before_wash=10)
    routine()
    entry = slot(generate(client, days=2), 1, "Office")
    assert client.post(f"/api/plan/entries/{entry['entry_id']}/wear?today={iso(MON)}").status_code == 409


# --- Feasibility & simulation -----------------------------------------------------------


def test_feasibility_check_with_draft(client, make_garment):
    make_garment("Only socks", "socks")
    draft = {"name": "Daily", "weekdays": EVERY_DAY, "requirements": [{"category": "socks", "quantity": 1}]}
    r = client.post("/api/routines/check", json={"routine": draft, "days": 3})
    out = r.json()
    assert out["ok"] is False
    assert "Daily: 3 clean socks needed over these 3 days, but only 1 can be planned." in [
        i["message"] for i in out["issues"]
    ]
    assert client.get("/api/routines").json() == []  # nothing saved


def test_simulate_basket(client, make_garment, make_basket, routine):
    a = make_garment("Shirt A", "shirt", ironing_policy="not_required")
    b = make_garment("Shirt B", "shirt", ironing_policy="not_required")
    t = make_garment("Trousers", "trousers")
    client.post("/api/pairs", json={"name": "A look", "garment_ids": [a["id"], t["id"]]})
    client.post("/api/pairs", json={"name": "B look", "garment_ids": [b["id"], t["id"]]})
    routine(weekdays=EVERY_DAY)
    basket = make_basket("Whites", [a["id"]], scheduled_for=day(3))
    r = client.post(f"/api/plan/simulate?today={iso(MON)}", json={"basket_id": basket["id"], "wash_on": iso(MON), "days": 4})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["returns_on"] == day(1)
    assert [p["name"] for p in out["pairs_possible"]] == ["B look"]
    assert [p["name"] for p in out["pairs_blocked"]] == ["A look"]
    # Washing Monday instead of Thursday gets shirt A back sooner, so fewer shortages.
    assert out["resolved_issues"] and not out["new_issues"]


def test_simulate_new_wash_reports_unavailable(client, make_garment):
    a = make_garment("Shirt A", "shirt")
    make_garment("Shirt B", "shirt")
    r = client.post(f"/api/plan/simulate?today={iso(MON)}", json={"garment_ids": [a["id"]], "wash_on": day(2)})
    out = r.json()
    assert [g["name"] for g in out["unavailable"]] == ["Shirt A"]
    assert out["returns_on"] == day(3)
    assert out["scarce"] == ["Only 1 of your 2 shirt will be ready while this washes"]
    assert out["preparation"][0] == "1 of these will need ironing after washing"


# --- Weather -------------------------------------------------------------------------


def test_weather_tags():
    assert weather.tags_for(32, 10, 5, 80) == ["Hot", "Humid"]
    assert weather.tags_for(8, 70, 40, 90) == ["Cold", "Rainy", "Windy"]
    assert weather.tags_for(None, None, None, None) == []


def test_forecast_drives_plan_and_report_overrides(client, make_garment, routine, monkeypatch):
    weather._cache.clear()
    days = [day(i) for i in range(3)]
    monkeypatch.setattr(weather, "_get", lambda url, params: {"daily": {
        "time": days,
        "temperature_2m_max": [33, 10, 20],
        "temperature_2m_min": [25, 2, 12],
        "apparent_temperature_max": [35, 6, 20],
        "precipitation_probability_max": [0, 80, 10],
        "wind_speed_10m_max": [5, 10, 5],
        "relative_humidity_2m_mean": [40, 60, 50],
    }})
    client.put("/api/settings", json={"location_name": "Testville", "latitude": 1, "longitude": 2})
    make_garment("Linen shirt", "shirt", weather=["Hot"], max_wears_before_wash=10)
    make_garment("Flannel shirt", "shirt", weather=["Cold"], max_wears_before_wash=10)
    routine(weekdays=EVERY_DAY)
    client.put("/api/weather/reports", json={"date": day(2), "tags": ["cold", "bogus"]})
    plan = get_plan(client, days=3)
    assert plan["location"] == "Testville"
    assert plan["days"][0]["weather"] == ["Hot"]
    assert plan["days"][1]["weather"] == ["Cold", "Rainy"]
    assert plan["days"][2]["forecast"]["tags"] == ["Mild"]
    assert plan["days"][2]["weather"] == ["Cold"]  # the user's report wins for planning
    assert names(slot(plan, 0, "Office")) == ["Linen shirt"]
    assert names(slot(plan, 1, "Office")) == ["Flannel shirt"]


def test_forecast_failure_is_not_fatal(client, make_garment, routine, monkeypatch):
    weather._cache.clear()

    def boom(url, params):
        raise weather.httpx.ConnectError("offline")

    monkeypatch.setattr(weather, "_get", boom)
    client.put("/api/settings", json={"latitude": 1, "longitude": 2})
    make_garment("Shirt", "shirt")
    routine()
    plan = get_plan(client, days=1)
    assert plan["weather_error"] and len(slot(plan, 0, "Office")["garments"]) == 1


# --- AI interpretation ---------------------------------------------------------------


def test_interpret_routines(client, monkeypatch):
    sent = []
    monkeypatch.setattr(ai, "enabled", lambda: True)

    def fake_post(payload):
        sent.append(payload)
        content = json.dumps({
            "routines": [
                {"name": "Office", "kind": "day", "weekdays": [0, 1, 2, "thu", "Friday", 9], "occasion": "office",
                 "formality": 4, "requirements": [
                     {"category": "shirt", "quantity": 1, "min_formality": 4},
                     {"category": "socks", "quantity": "1"},
                     {"category": "shoes", "quantity": 1, "reuse": "fixed"},
                     {"category": "cravat", "quantity": 1},
                 ]},
                {"name": "Night", "kind": "night", "weekdays": [], "requirements": [{"category": "nightwear"}]},
            ],
            "questions": ["Do you wear a tie?"],
        })
        return ai.httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    monkeypatch.setattr(ai, "_post", fake_post)
    r = client.post("/api/routines/interpret", json={"text": "Mon-Fri office..."})
    assert r.status_code == 200, r.text
    out = r.json()
    office, night = out["routines"]
    assert office["weekdays"] == [0, 1, 2, 3, 4]
    assert office["occasion"] == "Office"
    assert [q["category"] for q in office["requirements"]] == ["shirt", "socks", "shoes"]
    assert office["requirements"][2]["reuse"] == "fixed"
    assert night["kind"] == "night" and night["weekdays"] == []
    assert out["questions"] == [
        "Do you wear a tie?",
        "'cravat' in Office isn't one of your categories. Which category should it use?",
        "Which days of the week does 'Night' apply to?",
    ]
    assert sent[0]["messages"][1]["content"] == "Mon-Fri office..."


def test_interpret_without_ai(client):
    r = client.post("/api/routines/interpret", json={"text": "Office every weekday"})
    assert r.status_code == 503 and r.json()["code"] == "ai_not_configured"
