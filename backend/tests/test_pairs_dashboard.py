from conftest import state_of


def test_pair_crud_and_availability(client, make_garment, make_basket):
    shirt = make_garment("Blue shirt", "shirt")
    trousers = make_garment("Navy trousers", "trousers")
    shoes = make_garment("Brown shoes", "shoes")
    r = client.post(
        "/api/pairs",
        json={
            "name": "Monday office",
            "garment_ids": [shirt["id"], trousers["id"], shoes["id"]],
            "labels": ["Office"],
        },
    )
    assert r.status_code == 201
    pair = r.json()
    assert [g["name"] for g in pair["garments"]] == ["Blue shirt", "Navy trousers", "Brown shoes"]
    assert pair["wearable"] is True and pair["blockers"] == []

    make_basket(garment_ids=[shirt["id"]])
    pair = client.get(f"/api/pairs/{pair['id']}").json()
    assert pair["wearable"] is False
    assert pair["blockers"] == [
        {"garment_id": shirt["id"], "garment_name": "Blue shirt", "reason": "In Laundry Basket"}
    ]
    assert client.get("/api/pairs", params={"wearable": True}).json() == []

    r = client.patch(f"/api/pairs/{pair['id']}", json={"garment_ids": [trousers["id"]], "favorite": True})
    assert r.json()["wearable"] is True and r.json()["favorite"] is True
    assert len(r.json()["garments"]) == 1

    dup = client.post(f"/api/pairs/{pair['id']}/duplicate").json()
    assert dup["name"] == "Monday office (copy)" and dup["favorite"] is False
    assert client.delete(f"/api/pairs/{pair['id']}").status_code == 204
    assert [p["name"] for p in client.get("/api/pairs").json()] == ["Monday office (copy)"]


def test_wearing_pair_updates_all_garments_atomically(client, make_garment):
    shirt = make_garment("Shirt", "shirt")
    jeans = make_garment("Jeans", "jeans")
    pair = client.post("/api/pairs", json={"name": "Casual", "garment_ids": [shirt["id"], jeans["id"]]}).json()
    r = client.post(f"/api/pairs/{pair['id']}/wear", json={"worn_on": "2026-10-13"})
    assert r.status_code == 200
    assert state_of(client, shirt["id"]) == "needs_laundry"
    assert state_of(client, jeans["id"]) == "worn_reusable"
    # Shirt now needs laundry, so the whole pair is refused and jeans are untouched.
    assert client.post(f"/api/pairs/{pair['id']}/wear", json={}).status_code == 409
    assert client.get(f"/api/garments/{jeans['id']}").json()["total_wears"] == 1
    history = client.get(f"/api/garments/{jeans['id']}/history").json()
    assert history[0]["kind"] == "worn" and history[0]["pair_id"] == pair["id"]


def test_pair_rejects_unknown_garment(client):
    r = client.post("/api/pairs", json={"name": "X", "garment_ids": ["nope"]})
    assert r.status_code == 404


def test_dashboard(client, make_garment, make_basket):
    s1, s2 = make_garment("Shirt 1"), make_garment("Shirt 2")
    tee = make_garment("Tee", "t-shirt")
    make_basket("Monday Laundry", [s1["id"], s2["id"]], scheduled_for="2026-10-13")
    make_basket("Old", [tee["id"]], scheduled_for="2026-10-01")
    d = client.get("/api/dashboard", params={"today": "2026-10-13"}).json()
    assert d["garments_total"] == 3 and d["garments_wearable"] == 0
    assert d["state_counts"]["in_basket"] == 3
    assert [b["name"] for b in d["baskets_due_today"]] == ["Monday Laundry"]
    kinds = {w["kind"] for w in d["warnings"]}
    assert {"basket_due", "basket_overdue", "shortage"} <= kinds
    messages = [w["message"] for w in d["warnings"]]
    assert "Your Monday Laundry basket is due today." in messages
    assert "No shirt ready to wear (you own 2)." in messages


def test_users_are_isolated(client, make_garment, make_basket):
    from app.auth import current_user
    from app.main import app

    g = make_garment()
    basket = make_basket()
    app.dependency_overrides[current_user] = lambda: "someone-else"
    try:
        assert client.get(f"/api/garments/{g['id']}").status_code == 404
        assert client.get("/api/garments").json() == []
        assert client.get(f"/api/baskets/{basket['id']}").status_code == 404
        r = client.post("/api/garments/actions/wear", json={"garment_ids": [g["id"]]})
        assert r.status_code == 404
        mine = client.post("/api/baskets", json={"name": "Mine"}).json()["basket"]
        r = client.post(f"/api/baskets/{mine['id']}/items", json={"garment_ids": [g["id"]]})
        assert r.status_code == 404
    finally:
        app.dependency_overrides.clear()
