from conftest import state_of


def wear(client, *ids):
    r = client.post("/api/garments/actions/wear", json={"garment_ids": list(ids)})
    assert r.status_code == 200, r.text


def test_adding_to_basket_makes_garment_unavailable(client, make_garment, make_basket):
    g = make_garment()
    basket = make_basket()
    r = client.post(f"/api/baskets/{basket['id']}/items", json={"garment_ids": [g["id"]]})
    assert r.status_code == 200
    assert r.json()["basket"]["garment_count"] == 1
    got = client.get(f"/api/garments/{g['id']}").json()
    assert got["state"] == "in_basket"
    assert got["wearable"] is False
    assert got["active_basket"]["name"] == "Monday Laundry"
    assert client.get("/api/garments", params={"wearable": True}).json() == []
    assert client.post("/api/garments/actions/wear", json={"garment_ids": [g["id"]]}).status_code == 409


def test_garment_cannot_be_in_two_active_baskets(client, make_garment, make_basket):
    g = make_garment()
    first = make_basket("Monday Laundry", [g["id"]])
    second = make_basket("Whites")
    r = client.post(f"/api/baskets/{second['id']}/items", json={"garment_ids": [g["id"]]})
    assert r.status_code == 409
    assert r.json()["code"] == "in_other_basket"
    assert "Monday Laundry" in r.json()["detail"]
    r = client.post(f"/api/baskets/{first['id']}/items", json={"garment_ids": [g["id"]]})
    assert r.json()["code"] == "duplicate"


def test_bulk_add_is_all_or_nothing(client, make_garment, make_basket):
    a, b = make_garment("A"), make_garment("B")
    make_basket("Other", [b["id"]])
    basket = make_basket()
    r = client.post(f"/api/baskets/{basket['id']}/items", json={"garment_ids": [a["id"], b["id"]]})
    assert r.status_code == 409
    assert state_of(client, a["id"]) == "ready"


def test_removing_restores_previous_state(client, make_garment, make_basket):
    clean = make_garment("Clean shirt")
    dirty = make_garment("Dirty shirt")
    wear(client, dirty["id"])
    basket = make_basket(garment_ids=[clean["id"], dirty["id"]])
    for gid, expected in ((clean["id"], "ready"), (dirty["id"], "needs_laundry")):
        r = client.post(f"/api/baskets/{basket['id']}/items/{gid}/remove", json={})
        assert r.status_code == 200, r.text
        assert state_of(client, gid) == expected
    assert client.get(f"/api/baskets/{basket['id']}").json()["garment_count"] == 0


def test_removing_with_explicit_state(client, make_garment, make_basket):
    g = make_garment()
    basket = make_basket(garment_ids=[g["id"]])
    r = client.post(
        f"/api/baskets/{basket['id']}/items/{g['id']}/remove", json={"restore_to": "needs_laundry"}
    )
    assert r.status_code == 200
    assert state_of(client, g["id"]) == "needs_laundry"


def test_removing_from_in_progress_basket_needs_confirmation(client, make_garment, make_basket):
    g = make_garment()
    wear(client, g["id"])
    basket = make_basket(garment_ids=[g["id"]])
    r = client.post(f"/api/baskets/{basket['id']}/start")
    assert r.json()["status"] == "in_progress" and r.json()["started_at"]
    assert state_of(client, g["id"]) == "in_laundry"

    url = f"/api/baskets/{basket['id']}/items/{g['id']}/remove"
    r = client.post(url, json={})
    assert r.status_code == 409 and r.json()["code"] == "confirmation_required"
    assert client.post(url, json={"confirm": True}).status_code == 200
    assert state_of(client, g["id"]) == "needs_laundry"


def test_adding_to_in_progress_basket_goes_straight_to_laundry(client, make_garment, make_basket):
    a, b = make_garment("A"), make_garment("B")
    basket = make_basket(garment_ids=[a["id"]])
    client.post(f"/api/baskets/{basket['id']}/start")
    client.post(f"/api/baskets/{basket['id']}/items", json={"garment_ids": [b["id"]]})
    assert state_of(client, b["id"]) == "in_laundry"


def test_completion_resets_counts_and_respects_ironing(client, make_garment, make_basket):
    shirt = make_garment("Formal shirt", "shirt")  # ironing required
    tee = make_garment("Tee", "t-shirt")  # no ironing
    wear(client, shirt["id"], tee["id"])
    basket = make_basket(garment_ids=[shirt["id"], tee["id"]])
    client.post(f"/api/baskets/{basket['id']}/start")
    r = client.post(f"/api/baskets/{basket['id']}/complete", json={"default_result": "dry"})
    assert r.status_code == 200, r.text
    done = r.json()
    assert done["status"] == "completed" and done["completed_at"]
    assert done["garment_count"] == 2
    assert all(i["outcome"] == "washed" and not i["active"] for i in done["items"])

    s = client.get(f"/api/garments/{shirt['id']}").json()
    t = client.get(f"/api/garments/{tee['id']}").json()
    assert s["state"] == "needs_ironing"  # never auto-Ready when ironing is required
    assert t["state"] == "ready"
    for g in (s, t):
        assert g["wears_since_wash"] == 0
        assert g["total_wears"] == 1
        assert g["last_washed_at"] is not None
    assert t["active_basket"] is None
    assert s["active_basket"]["kind"] == "ironing"  # waits in the ironing basket


def test_completion_with_per_garment_outcomes(client, make_garment, make_basket):
    shirt = make_garment("Shirt", "shirt")
    tee = make_garment("Tee", "t-shirt")
    jeans = make_garment("Jeans", "jeans")
    sweater = make_garment("Sweater", "sweater")
    wear(client, jeans["id"], sweater["id"])
    basket = make_basket(garment_ids=[shirt["id"], tee["id"], jeans["id"], sweater["id"]])
    r = client.post(
        f"/api/baskets/{basket['id']}/complete",
        json={
            "default_result": "drying",
            "outcomes": [
                {"garment_id": tee["id"], "result": "dry", "needs_ironing": True},
                {"garment_id": jeans["id"], "result": "not_processed"},
                {"garment_id": sweater["id"], "result": "unavailable"},
            ],
        },
    )
    assert r.status_code == 200, r.text
    assert state_of(client, shirt["id"]) == "drying"
    assert state_of(client, tee["id"]) == "needs_ironing"
    j = client.get(f"/api/garments/{jeans['id']}").json()
    assert (j["state"], j["wears_since_wash"], j["last_washed_at"]) == ("worn_reusable", 1, None)
    sw = client.get(f"/api/garments/{sweater['id']}").json()
    assert (sw["state"], sw["wears_since_wash"]) == ("unavailable", 0)

    # The drying shirt still has to be ironed once it's dry.
    r = client.post("/api/garments/actions/dried", json={"garment_ids": [shirt["id"]]})
    assert r.json()[0]["state"] == "needs_ironing"


def test_completed_basket_is_closed(client, make_garment, make_basket):
    g = make_garment("Tee", "t-shirt")
    basket = make_basket(garment_ids=[g["id"]])
    client.post(f"/api/baskets/{basket['id']}/complete", json={})
    for path, body in (("items", {"garment_ids": [g["id"]]}), ("complete", {}), ("start", None)):
        r = client.post(f"/api/baskets/{basket['id']}/{path}", json=body)
        assert r.status_code == 409, path
    # Garment is free again for a new basket.
    second = make_basket("Next", [g["id"]])
    assert second["garment_count"] == 1
    assert client.get(f"/api/baskets/{basket['id']}").json()["status"] == "completed"


def test_outcome_for_garment_not_in_basket_rejected(client, make_garment, make_basket):
    a, b = make_garment("A"), make_garment("B")
    basket = make_basket(garment_ids=[a["id"]])
    r = client.post(
        f"/api/baskets/{basket['id']}/complete",
        json={"outcomes": [{"garment_id": b["id"], "result": "dry"}]},
    )
    assert r.status_code == 409
    assert state_of(client, a["id"]) == "in_basket"


def test_deleting_pending_basket_releases_garments(client, make_garment, make_basket):
    g = make_garment()
    basket = make_basket(garment_ids=[g["id"]])
    assert client.delete(f"/api/baskets/{basket['id']}").status_code == 204
    assert state_of(client, g["id"]) == "ready"


def test_in_progress_basket_cannot_be_deleted(client, make_garment, make_basket):
    g = make_garment()
    basket = make_basket(garment_ids=[g["id"]])
    client.post(f"/api/baskets/{basket['id']}/start")
    assert client.delete(f"/api/baskets/{basket['id']}").status_code == 409


def test_reserved_garment_warns_and_restores(client, make_garment, make_basket):
    g = make_garment()
    client.post(f"/api/garments/{g['id']}/state", json={"state": "reserved"})
    r = client.post("/api/baskets", json={"name": "Urgent", "garment_ids": [g["id"]]})
    assert any("reserved" in w for w in r.json()["warnings"])
    basket_id = r.json()["basket"]["id"]
    client.post(f"/api/baskets/{basket_id}/items/{g['id']}/remove", json={})
    assert state_of(client, g["id"]) == "reserved"


def test_garment_in_basket_cannot_be_overridden_or_archived(client, make_garment, make_basket):
    g = make_garment()
    make_basket(garment_ids=[g["id"]])
    assert client.post(f"/api/garments/{g['id']}/state", json={"state": "ready"}).status_code == 409
    assert client.post(f"/api/garments/{g['id']}/archive", json={}).status_code == 409
    assert client.delete(f"/api/garments/{g['id']}").status_code == 409


def test_basket_sorting_and_filter(client, make_basket):
    make_basket("Weekend", scheduled_for="2026-10-18")
    make_basket("Monday", scheduled_for="2026-10-12")
    make_basket("Someday")
    names = [b["name"] for b in client.get("/api/baskets").json()]
    assert names == ["Monday", "Weekend", "Someday"]
    names = [b["name"] for b in client.get("/api/baskets", params={"sort": "name"}).json()]
    assert names == ["Monday", "Someday", "Weekend"]
    assert client.get("/api/baskets", params={"status": "completed"}).json() == []
