from conftest import state_of


def test_category_defaults_applied(make_garment):
    shirt = make_garment(category="Shirt")
    assert shirt["category"] == "shirt"
    assert shirt["max_wears_before_wash"] == 1
    assert shirt["ironing_policy"] == "required"
    shoes = make_garment("Office shoes", "shoes")
    assert shoes["max_wears_before_wash"] is None


def test_explicit_settings_override_defaults(make_garment):
    g = make_garment("Jeans", "jeans", max_wears_before_wash=2, ironing_policy="optional")
    assert g["max_wears_before_wash"] == 2
    assert g["ironing_policy"] == "optional"


def test_edit_labels_and_filter(client, make_garment):
    g = make_garment(labels=["Office", "office", " Favorite "])
    assert g["labels"] == ["Office", "Favorite"]
    make_garment("Tee", "t-shirt", labels=["Casual"])
    r = client.get("/api/garments", params={"label": "office"})
    assert [x["name"] for x in r.json()] == ["White shirt"]
    assert client.get("/api/labels").json() == ["Casual", "Favorite", "Office"]

    r = client.patch(f"/api/garments/{g['id']}", json={"color": "white", "labels": ["Party"]})
    assert r.json()["labels"] == ["Party"] and r.json()["color"] == "white"
    assert client.patch(f"/api/garments/{g['id']}", json={"name": None}).status_code == 422


def test_wear_tracking_and_reuse_rules(client, make_garment):
    trousers = make_garment("Grey trousers", "trousers")  # 3 wears before wash
    socks = make_garment("Black socks", "socks")
    shoes = make_garment("Office shoes", "shoes")
    ids = [trousers["id"], socks["id"], shoes["id"]]

    r = client.post("/api/garments/actions/wear", json={"garment_ids": ids, "worn_on": "2026-10-12"})
    assert r.status_code == 200
    by_name = {g["name"]: g for g in r.json()}
    assert by_name["Grey trousers"]["state"] == "worn_reusable"
    assert by_name["Grey trousers"]["wearable"] is True
    assert by_name["Black socks"]["state"] == "needs_laundry"
    assert by_name["Office shoes"]["state"] == "worn_reusable"
    assert by_name["Grey trousers"]["last_worn_on"] == "2026-10-12"

    # Socks now need laundry, so wearing the same set again fails as a whole.
    r = client.post("/api/garments/actions/wear", json={"garment_ids": ids})
    assert r.status_code == 409
    assert client.get(f"/api/garments/{trousers['id']}").json()["total_wears"] == 1

    for _ in range(2):
        client.post("/api/garments/actions/wear", json={"garment_ids": [trousers["id"], shoes["id"]]})
    t = client.get(f"/api/garments/{trousers['id']}").json()
    assert (t["state"], t["total_wears"], t["wears_since_wash"]) == ("needs_laundry", 3, 3)
    assert state_of(client, shoes["id"]) == "worn_reusable"


def test_archive_hides_from_list_but_keeps_history(client, make_garment):
    g = make_garment()
    client.post("/api/garments/actions/wear", json={"garment_ids": [g["id"]]})
    r = client.post(f"/api/garments/{g['id']}/archive", json={"reason": "no_longer_owned"})
    assert r.json()["archived"] is True and r.json()["wearable"] is False
    assert client.get("/api/garments").json() == []
    assert len(client.get("/api/garments", params={"include_archived": True}).json()) == 1
    kinds = [e["kind"] for e in client.get(f"/api/garments/{g['id']}/history").json()]
    assert "worn" in kinds and "archived" in kinds
    assert client.post("/api/garments/actions/wear", json={"garment_ids": [g["id"]]}).status_code == 409


def test_manual_override_cannot_enter_basket_states(client, make_garment):
    g = make_garment()
    r = client.post(f"/api/garments/{g['id']}/state", json={"state": "in_laundry"})
    assert r.status_code == 409 and r.json()["code"] == "basket_state"
    r = client.post(f"/api/garments/{g['id']}/state", json={"state": "unavailable", "note": "Lent to Sam"})
    assert r.json()["state"] == "unavailable"


def test_ironing_does_not_reset_wear_count(client, make_garment):
    g = make_garment("Linen trousers", "trousers")
    client.post("/api/garments/actions/wear", json={"garment_ids": [g["id"]]})
    r = client.post("/api/garments/actions/needs-ironing", json={"garment_ids": [g["id"]]})
    assert r.json()[0]["state"] == "needs_ironing"
    assert r.json()[0]["wearable"] is False
    r = client.post("/api/garments/actions/ironed", json={"garment_ids": [g["id"]]})
    out = r.json()[0]
    assert out["state"] == "ready"
    assert out["wears_since_wash"] == 1
    assert out["last_washed_at"] is None


def test_manual_wash_drying_then_ironing(client, make_garment):
    g = make_garment()  # shirt: ironing required
    client.post("/api/garments/actions/wear", json={"garment_ids": [g["id"]]})
    r = client.post("/api/garments/actions/wash", json={"garment_ids": [g["id"]], "dry": False})
    out = r.json()[0]
    assert (out["state"], out["wears_since_wash"], out["iron_after_drying"]) == ("drying", 0, True)
    assert out["last_washed_at"] is not None
    r = client.post("/api/garments/actions/dried", json={"garment_ids": [g["id"]]})
    assert r.json()[0]["state"] == "needs_ironing"
    client.post("/api/garments/actions/ironed", json={"garment_ids": [g["id"]]})
    assert state_of(client, g["id"]) == "ready"


def test_image_upload_validation(client, make_garment):
    g = make_garment()
    r = client.post(f"/api/garments/{g['id']}/image", files={"file": ("x.txt", b"hi", "text/plain")})
    assert r.status_code == 415
    png = b"\x89PNG\r\n\x1a\n" + b"0" * 32
    r = client.post(f"/api/garments/{g['id']}/image", files={"file": ("x.png", png, "image/png")})
    assert r.status_code == 200
    url = r.json()["image_url"]
    assert url.startswith("/media/dev-user/")
    assert client.get(url).content == png
