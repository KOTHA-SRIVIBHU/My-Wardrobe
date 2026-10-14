import json
from datetime import date, timedelta

from conftest import state_of

MON = date(2030, 1, 7)
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32


def iso(d: date) -> str:
    return d.isoformat()


# --- Analytics -------------------------------------------------------------------------


def test_analytics(client, make_garment, make_basket):
    shirt = make_garment("Shirt", "shirt", purchase_price="40.00", max_wears_before_wash=10)
    jeans = make_garment("Jeans", "jeans", purchase_price="60.00", max_wears_before_wash=10)
    make_garment("Never worn", "t-shirt")
    for i in range(3):
        client.post("/api/garments/actions/wear", json={"garment_ids": [shirt["id"], jeans["id"]], "worn_on": iso(MON - timedelta(days=i))})
    basket = make_basket("Wash", [shirt["id"]])
    client.post(f"/api/baskets/{basket['id']}/complete", json={})
    a = client.get("/api/analytics", params={"today": iso(MON), "days": 30}).json()
    assert a["garments_total"] == 3 and a["wears_in_period"] == 6
    assert a["never_worn"] == 1
    assert [m["name"] for m in a["most_worn"]] == ["Jeans", "Shirt"] or [m["name"] for m in a["most_worn"]] == ["Shirt", "Jeans"]
    assert a["least_worn"][0]["name"] == "Never worn"
    assert a["repeated_outfits"] == [{"garments": ["Jeans", "Shirt"], "times": 3}]
    assert a["awaiting_ironing"] == 1  # the shirt (ironing required) after washing
    # The basket was completed at the real current time.
    real = client.get("/api/analytics", params={"days": 30}).json()
    assert real["laundry_runs"] == 1 and real["garments_washed"] == 1
    assert a["cost_per_wear"][0] == {"id": jeans["id"], "name": "Jeans", "category": "jeans", "value": 20.0}
    assert sum(w["wears"] for w in a["weekly_wears"]) == 6


# --- Packing ---------------------------------------------------------------------------


def test_packing_list(client, make_garment, make_basket):
    for i in range(4):
        make_garment(f"Tee {i}", "t-shirt")
        make_garment(f"Socks {i}", "socks")
    make_garment("Underwear", "underwear")
    make_garment("Jeans", "jeans")
    make_garment("Sneakers", "shoes")
    make_garment("PJs", "nightwear")
    dirty = make_garment("Dirty tee", "t-shirt")
    client.post("/api/garments/actions/wear", json={"garment_ids": [dirty["id"]]})
    r = client.post(f"/api/packing?today={iso(MON)}", json={"start": iso(MON + timedelta(days=2)), "nights": 4})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["days"] == 5
    by_title = {s["title"]: s for s in out["sections"]}
    assert by_title["Tops"]["needed"] == 5 and len(by_title["Tops"]["garments"]) == 4
    assert by_title["Tops"]["shortfall"] == "Only 4 of 5 will be clean by departure"
    assert "Dirty tee" not in [g["name"] for g in by_title["Tops"]["garments"]]
    assert by_title["Underwear"]["shortfall"] == "Only 1 of 5 will be clean by departure"
    assert by_title["Bottoms"]["needed"] == 2
    assert [g["name"] for g in by_title["Nightwear"]["garments"]] == ["PJs"]
    # With laundry on the trip, pack for at most 4 days.
    out = client.post(f"/api/packing?today={iso(MON)}", json={"start": iso(MON), "nights": 9, "laundry_available": True}).json()
    assert {s["title"]: s["needed"] for s in out["sections"]}["Tops"] == 4
    assert any("assuming you can do laundry" in n for n in out["notes"])


# --- Before you buy --------------------------------------------------------------------


def test_purchase_analysis(client, make_garment):
    make_garment("White shirt", "shirt", color="white")
    make_garment("Blue shirt", "shirt", color="light blue")
    make_garment("Navy chinos", "trousers", color="navy")
    out = client.post("/api/analysis/purchase", json={"category": "trousers", "color": "black"}).json()
    assert out["new_outfits"] == 2 and out["strong_outfits"] == 2
    assert out["category_owned"] == 1
    out = client.post("/api/analysis/purchase", json={"category": "Shirt", "color": "white"}).json()
    assert out["similar_owned"] == ["White shirt"]
    make_garment("White linen shirt", "shirt", color="white")
    out = client.post("/api/analysis/purchase", json={"category": "shirt", "color": "white"}).json()
    assert out["verdict"].startswith("You already own 2 similar")
    out = client.post("/api/analysis/purchase", json={"category": "socks", "color": "black"}).json()
    assert "isn't used in outfit suggestions" in out["verdict"]
    # The candidate is never saved.
    assert len(client.get("/api/garments").json()) == 4


# --- Reminders ---------------------------------------------------------------------------


def test_notifications_and_preferences(client, make_garment, make_basket):
    shirt = make_garment("Blue shirt", "shirt")
    client.post("/api/garments/actions/needs-ironing", json={"garment_ids": [shirt["id"]]})
    make_garment("Spare", "socks")
    s2 = make_garment("Grey shirt", "shirt")
    make_basket("Monday Laundry", [s2["id"]], scheduled_for=iso(MON))
    client.post("/api/routines", json={"name": "Office", "weekdays": [1], "requirements": [{"category": "shirt"}]})
    client.post("/api/events", json={"title": "Wedding", "date": iso(MON + timedelta(days=1)), "occasion": "Wedding"})
    notes = client.get("/api/notifications", params={"today": iso(MON)}).json()
    messages = [n["message"] for n in notes]
    assert "Your Monday Laundry basket is due today." in messages
    assert "1 washed garment still needs ironing." in messages
    assert any(m.startswith("Tomorrow: Wedding.") for m in messages)
    assert any("needs ironing" in m and "tomorrow" in m for m in messages)
    client.put("/api/settings", json={"notification_prefs": {"laundry": False, "ironing": False, "events": False, "plan": False}})
    assert client.get("/api/notifications", params={"today": iso(MON)}).json() == []
    # Updating other settings doesn't reset the preferences.
    client.put("/api/settings", json={"drying_days": 2})
    assert client.get("/api/settings").json()["notification_prefs"]["laundry"] is False


# --- Backup -------------------------------------------------------------------------------


def test_export_and_restore_round_trip(client, make_garment, make_basket):
    shirt = make_garment("Shirt", "shirt", labels=["Office"], purchase_price="25.50")
    client.post(f"/api/garments/{shirt['id']}/image", files={"file": ("s.png", PNG, "image/png")})
    jeans = make_garment("Jeans", "jeans")
    pair = client.post("/api/pairs", json={"name": "Classic", "garment_ids": [shirt["id"], jeans["id"]]}).json()
    client.post(f"/api/pairs/{pair['id']}/wear", json={"worn_on": iso(MON)})
    basket = make_basket("Wash", [shirt["id"]], scheduled_for=iso(MON))
    routine = client.post("/api/routines", json={"name": "Office", "weekdays": [0], "requirements": [{"category": "shirt"}]}).json()
    client.post("/api/events", json={"title": "Party", "date": iso(MON), "garment_ids": [jeans["id"]]})
    client.post("/api/plan/entries", json={"date": iso(MON), "slot_key": f"routine:{routine['id']}", "title": "Office", "garment_ids": [jeans["id"]]})
    client.put("/api/settings", json={"laundry_weekdays": [5], "drying_days": 2})

    backup = client.get("/api/export").json()
    assert backup["format"] == "closetiq-backup" and len(backup["photos"]) == 1

    # Wreck the wardrobe, then restore.
    client.post(f"/api/baskets/{basket['id']}/items/{shirt['id']}/remove", json={})
    client.delete(f"/api/garments/{jeans['id']}")
    make_garment("Junk", "socks")
    r = client.post("/api/import", files={"file": ("b.json", json.dumps(backup), "application/json")})
    assert r.status_code == 409  # needs confirmation
    r = client.post("/api/import?confirm=true", files={"file": ("b.json", json.dumps(backup), "application/json")})
    assert r.status_code == 200, r.text

    garments = {g["name"]: g for g in client.get("/api/garments").json()}
    assert set(garments) == {"Shirt", "Jeans"}
    s = garments["Shirt"]
    assert s["id"] != shirt["id"]  # fresh ids
    assert s["state"] == "in_basket" and s["active_basket"]["name"] == "Wash"
    assert s["labels"] == ["Office"] and s["purchase_price"] == "25.50"
    assert client.get(s["image_url"]).content == PNG
    assert garments["Jeans"]["total_wears"] == 1
    pairs = client.get("/api/pairs").json()
    assert [g["name"] for g in pairs[0]["garments"]] == ["Shirt", "Jeans"]
    history = client.get(f"/api/garments/{garments['Jeans']['id']}/history").json()
    assert history[0]["kind"] == "worn" and history[0]["pair_id"] == pairs[0]["id"]
    events = client.get("/api/events", params={"start": iso(MON)}).json()
    assert events[0]["garment_ids"] == [garments["Jeans"]["id"]]
    new_routine = client.get("/api/routines").json()[0]
    plan = client.get("/api/plan", params={"start": iso(MON), "days": 1, "today": iso(MON)}).json()
    office = next(sl for sl in plan["days"][0]["slots"] if sl["title"] == "Office")
    assert office["saved"] and office["routine_id"] == new_routine["id"]
    assert client.get("/api/settings").json()["drying_days"] == 2
    # Basket still works after restore.
    b = client.get("/api/baskets").json()[0]
    assert client.post(f"/api/baskets/{b['id']}/complete", json={}).status_code == 200
    assert state_of(client, s["id"]) == "needs_ironing"


def test_old_databases_get_new_columns(tmp_path):
    """A table created by an older version gains columns added later."""
    from sqlalchemy import inspect, text

    from app.db import add_missing_columns, make_engine

    engine = make_engine(f"sqlite:///{tmp_path / 'old.db'}")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE user_settings (user_id VARCHAR(64) PRIMARY KEY, drying_days INTEGER)"))
        conn.execute(text("INSERT INTO user_settings VALUES ('u1', 2)"))
    added = add_missing_columns(engine)
    assert "user_settings.notification_prefs" in added
    cols = {c["name"] for c in inspect(engine).get_columns("user_settings")}
    assert {"notification_prefs", "laundry_weekdays", "location_name"} <= cols
    with engine.connect() as conn:
        assert conn.execute(text("SELECT drying_days FROM user_settings")).scalar() == 2
    assert add_missing_columns(engine) == []  # idempotent


def test_restore_rejects_bad_files(client):
    for body in ("not json", json.dumps([1]), json.dumps({"format": "other"})):
        r = client.post("/api/import?confirm=true", files={"file": ("b.json", body, "application/json")})
        assert r.status_code == 422
