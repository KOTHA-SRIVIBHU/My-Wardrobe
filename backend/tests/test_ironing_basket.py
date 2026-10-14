from conftest import state_of


def ironing_baskets(client):
    return [b for b in client.get("/api/baskets").json() if b["kind"] == "ironing"]


def ironing_basket(client):
    found = ironing_baskets(client)
    assert len(found) <= 1, "there must never be more than one ironing basket"
    return found[0] if found else None


def complete(client, basket_id, **body):
    r = client.post(f"/api/baskets/{basket_id}/complete", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_laundry_completion_fills_auto_created_ironing_basket(client, make_garment, make_basket):
    shirt = make_garment("Formal shirt", "shirt")  # ironing required
    tee = make_garment("Tee", "t-shirt")
    assert ironing_basket(client) is None
    complete(client, make_basket("Wash", [shirt["id"], tee["id"]])["id"])

    ib = ironing_basket(client)
    assert ib is not None and ib["name"] == "Ironing basket" and ib["garment_count"] == 1
    g = client.get(f"/api/garments/{shirt['id']}").json()
    assert g["state"] == "needs_ironing"
    assert g["active_basket"] == {"id": ib["id"], "name": "Ironing basket", "status": "pending", "kind": "ironing"}
    assert client.get(f"/api/garments/{tee['id']}").json()["active_basket"] is None
    assert client.get("/api/baskets").json()[0]["id"] == ib["id"]
    d = client.get("/api/dashboard").json()
    assert d["ironing_basket"]["id"] == ib["id"]
    assert ib["id"] not in [b["id"] for b in d["baskets_pending"]]

    shirt2 = make_garment("Second shirt", "shirt")
    complete(client, make_basket("Wash 2", [shirt2["id"]])["id"])
    assert ironing_basket(client)["id"] == ib["id"]
    assert ironing_basket(client)["garment_count"] == 2


def test_one_permanent_basket_across_many_rounds(client, make_garment, make_basket):
    """Regression: every wash-and-iron round used to leave another 'Ironing basket'."""
    shirt = make_garment("Shirt", "shirt")
    first_id = None
    for round_ in range(3):
        complete(client, make_basket(f"Wash {round_}", [shirt["id"]])["id"])
        client.post("/api/garments/actions/ironed", json={"garment_ids": [shirt["id"]]})
        ib = ironing_basket(client)  # asserts there is only one
        first_id = first_id or ib["id"]
        assert ib["id"] == first_id and ib["status"] == "pending" and ib["garment_count"] == 0
        client.post("/api/garments/actions/wear", json={"garment_ids": [shirt["id"]]})
    history = client.get(f"/api/baskets/{first_id}").json()["items"]
    assert [i["outcome"] for i in history] == ["ironed", "ironed", "ironed"]


def test_ironing_empties_but_basket_stays(client, make_garment, make_basket):
    a, b = make_garment("A", "shirt"), make_garment("B", "shirt")
    complete(client, make_basket("Wash", [a["id"], b["id"]])["id"])
    ib = ironing_basket(client)
    client.post("/api/garments/actions/ironed", json={"garment_ids": [a["id"]]})
    assert ironing_basket(client)["garment_count"] == 1
    client.post("/api/garments/actions/ironed", json={"garment_ids": [b["id"]]})
    after = ironing_basket(client)
    assert after["id"] == ib["id"] and after["status"] == "pending" and after["garment_count"] == 0
    assert state_of(client, a["id"]) == "ready"
    client.post("/api/garments/actions/needs-ironing", json={"garment_ids": [a["id"]]})
    assert ironing_basket(client)["id"] == ib["id"]


def test_drying_garments_join_once_dry(client, make_garment, make_basket):
    shirt = make_garment("Shirt", "shirt")
    complete(client, make_basket("Wash", [shirt["id"]])["id"], default_result="drying")
    assert ironing_basket(client) is None
    client.post("/api/garments/actions/dried", json={"garment_ids": [shirt["id"]]})
    assert ironing_basket(client)["garment_count"] == 1


def test_no_ironing_needed_after_all(client, make_garment):
    g = make_garment("Shirt", "shirt")
    client.post("/api/garments/actions/needs-ironing", json={"garment_ids": [g["id"]]})
    ib = ironing_basket(client)
    r = client.post(f"/api/baskets/{ib['id']}/items/{g['id']}/remove", json={})
    assert r.status_code == 200
    assert state_of(client, g["id"]) == "ready"
    assert ironing_basket(client)["garment_count"] == 0


def test_rewashing_moves_garment_from_ironing_to_laundry(client, make_garment, make_basket):
    g = make_garment("Shirt", "shirt")
    client.post("/api/garments/actions/needs-ironing", json={"garment_ids": [g["id"]]})
    laundry = make_basket("Rewash", [g["id"]])
    got = client.get(f"/api/garments/{g['id']}").json()
    assert got["state"] == "in_basket" and got["active_basket"]["id"] == laundry["id"]
    assert ironing_basket(client)["garment_count"] == 0
    client.post(f"/api/baskets/{laundry['id']}/items/{g['id']}/remove", json={})
    assert state_of(client, g["id"]) == "needs_ironing"
    assert ironing_basket(client)["garment_count"] == 1


def test_override_and_archive_leave_the_ironing_basket(client, make_garment):
    a, b = make_garment("A", "shirt"), make_garment("B", "shirt")
    client.post("/api/garments/actions/needs-ironing", json={"garment_ids": [a["id"], b["id"]]})
    assert client.post(f"/api/garments/{a['id']}/state", json={"state": "unavailable"}).status_code == 200
    assert client.post(f"/api/garments/{b['id']}/archive", json={}).status_code == 200
    assert ironing_basket(client)["garment_count"] == 0


def test_ironing_basket_rules(client, make_garment):
    a, b = make_garment("A", "shirt"), make_garment("B", "shirt")
    client.post("/api/garments/actions/needs-ironing", json={"garment_ids": [a["id"]]})
    ib = ironing_basket(client)
    for action in ("start", "complete"):
        r = client.post(f"/api/baskets/{ib['id']}/{action}", json={})
        assert r.status_code == 409 and r.json()["code"] == "ironing_basket"
    assert client.delete(f"/api/baskets/{ib['id']}").status_code == 409  # not while it holds clothes
    r = client.post(f"/api/baskets/{ib['id']}/items", json={"garment_ids": [b["id"]]})
    assert r.status_code == 200 and r.json()["basket"]["garment_count"] == 2
    assert state_of(client, b["id"]) == "needs_ironing"
    assert client.delete(f"/api/garments/{b['id']}").status_code == 204
    assert ironing_basket(client)["garment_count"] == 1


def test_duplicate_ironing_baskets_are_merged(client, make_garment):
    """Databases from the previous version can hold several ironing baskets."""
    from sqlalchemy import text

    from app.db import SessionLocal, engine
    from app.lifecycle import consolidate_ironing_baskets
    from app.models import BasketItem, BasketItemOutcome, BasketStatus, Garment, GarmentState, LaundryBasket

    g = make_garment("Shirt", "shirt")
    with engine.begin() as conn:  # simulate an old database without the one-per-user index
        conn.execute(text("DROP INDEX IF EXISTS uq_laundry_baskets_one_ironing"))
    with SessionLocal() as db:
        garment = db.get(Garment, g["id"])
        for n in range(3):
            b = LaundryBasket(user_id="dev-user", name="Ironing basket", kind="ironing", status=BasketStatus.COMPLETED)
            b.items.append(BasketItem(user_id="dev-user", garment=garment, previous_state=GarmentState.READY,
                                      active=False, outcome=BasketItemOutcome.IRONED))
            db.add(b)
            db.flush()
        assert consolidate_ironing_baskets(db) == 2
        db.commit()
    from app.db import add_missing_indexes

    add_missing_indexes(engine)
    ib = ironing_basket(client)
    assert ib["status"] == "pending"
    assert len(client.get(f"/api/baskets/{ib['id']}").json()["items"]) == 3  # history kept
    # The database now refuses a second one.
    with SessionLocal() as db:
        db.add(LaundryBasket(user_id="dev-user", name="dup", kind="ironing"))
        try:
            db.flush()
            raise AssertionError("duplicate ironing basket was allowed")
        except Exception as e:
            assert "UNIQUE" in str(e).upper()


# --- Wear limits ------------------------------------------------------------------------


def wear(client, gid):
    r = client.post("/api/garments/actions/wear", json={"garment_ids": [gid]})
    assert r.status_code == 200, r.text
    return r.json()[0]


def test_reuse_count_and_threshold(client, make_garment):
    g = make_garment("Jeans", "jeans", max_wears_before_wash=3)
    after = [wear(client, g["id"]) for _ in range(2)]
    assert [(x["state"], x["wears_since_wash"], x["wearable"]) for x in after] == [
        ("worn_reusable", 1, True), ("worn_reusable", 2, True)]
    third = wear(client, g["id"])
    assert (third["state"], third["wears_since_wash"], third["wearable"]) == ("needs_laundry", 3, False)


def test_lowering_limit_below_wears_makes_it_not_ready(client, make_garment):
    g = make_garment("Jeans", "jeans", max_wears_before_wash=5)
    wear(client, g["id"])
    wear(client, g["id"])
    r = client.patch(f"/api/garments/{g['id']}", json={"max_wears_before_wash": 2})
    assert r.json()["state"] == "needs_laundry" and r.json()["wearable"] is False
    # Raising it again makes it reusable (it was only "dirty" because of the limit).
    r = client.patch(f"/api/garments/{g['id']}", json={"max_wears_before_wash": 4})
    assert r.json()["state"] == "worn_reusable"


def test_raising_limit_keeps_manually_dirty_clothes_dirty(client, make_garment):
    g = make_garment("Jeans", "jeans", max_wears_before_wash=5)
    wear(client, g["id"])
    client.post(f"/api/garments/{g['id']}/state", json={"state": "needs_laundry", "note": "stain"})
    r = client.patch(f"/api/garments/{g['id']}", json={"max_wears_before_wash": 10})
    assert r.json()["state"] == "needs_laundry"


def test_marking_ready_means_fresh(client, make_garment):
    g = make_garment("Shirt", "shirt")  # limit 1
    wear(client, g["id"])
    r = client.post(f"/api/garments/{g['id']}/state", json={"state": "ready"})
    assert (r.json()["state"], r.json()["wears_since_wash"]) == ("ready", 0)
    assert r.json()["total_wears"] == 1
    assert wear(client, g["id"])["state"] == "needs_laundry"  # one wear again, not "already over"
