import json

import httpx
import pytest

from app import ai, outfits

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32


def groq_reply(content: str, status: int = 200, headers: dict | None = None) -> httpx.Response:
    body = {"choices": [{"message": {"content": content}}]} if status == 200 else {"error": {}}
    return httpx.Response(status, json=body, headers=headers or {})


@pytest.fixture
def groq(monkeypatch):
    """Enable AI and capture what would be sent to Groq."""
    sent: list[dict] = []
    replies: list[httpx.Response] = []
    monkeypatch.setattr(ai, "enabled", lambda: True)

    def fake_post(payload):
        sent.append(payload)
        return replies.pop(0)

    monkeypatch.setattr(ai, "_post", fake_post)
    return sent, replies


# --- AI: classification & graceful degradation ---------------------------------


def test_ai_disabled_without_key(client):
    assert client.get("/api/ai/status").json()["enabled"] is False
    r = client.post("/api/ai/classify", files={"file": ("x.png", PNG, "image/png")})
    assert r.status_code == 503 and r.json()["code"] == "ai_not_configured"


def test_classify_sanitizes_ai_output(client, groq):
    sent, replies = groq
    replies.append(groq_reply(json.dumps({
        "name": "  Light blue   Oxford shirt ",
        "category": "Shirt",
        "color": "Light Blue",
        "pattern": "Striped",
        "formality": "9",
        "occasions": ["office", "Spaceship", "Office"],
        "labels": ["favorite", "made-up"],
        "seasons": ["summer", "monsoon"],
        "weather": ["HOT"],
    })))
    r = client.post("/api/ai/classify", files={"file": ("x.png", PNG, "image/png")})
    assert r.status_code == 200, r.text
    out = r.json()
    assert out["name"] == "Light blue Oxford shirt"
    assert out["category"] == "shirt"
    assert out["color"] == "light blue" and out["pattern"] == "striped"
    assert out["formality"] == 5
    assert out["occasions"] == ["Office"] and out["labels"] == ["Favorite"]
    assert out["seasons"] == ["Summer"] and out["weather"] == ["Hot"]
    # The photo went to the vision model as a data URL, with Qwen reasoning switched off.
    payload = sent[0]
    assert payload["model"] == ai.settings.groq_vision_model
    assert payload["response_format"] == {"type": "json_object"}
    assert payload["reasoning_effort"] == "none"
    assert payload["messages"][0]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")


def test_classify_unknown_category_and_think_tags(client, groq):
    _, replies = groq
    replies.append(groq_reply('<think>hmm</think>{"name": "Cape", "category": "cape"}'))
    out = client.post("/api/ai/classify", files={"file": ("x.png", PNG, "image/png")}).json()
    assert out["category"] == "other" and out["name"] == "Cape"


def test_classify_not_clothing(client, groq):
    _, replies = groq
    replies.append(groq_reply('{"error": "not_clothing"}'))
    r = client.post("/api/ai/classify", files={"file": ("x.png", PNG, "image/png")})
    assert r.status_code == 422


def test_quota_is_reported_not_hidden(client, groq):
    _, replies = groq
    replies.append(groq_reply("", status=429, headers={"retry-after": "17"}))
    r = client.post("/api/ai/classify", files={"file": ("x.png", PNG, "image/png")})
    assert r.status_code == 503
    assert r.json()["code"] == "ai_quota" and r.json()["retry_after"] == 17
    # Core features are unaffected.
    assert client.post("/api/garments", json={"name": "Tee", "category": "t-shirt"}).status_code == 201


def test_garbage_reply(client, groq):
    _, replies = groq
    replies.append(groq_reply("I think it's a shirt!"))
    r = client.post("/api/ai/classify", files={"file": ("x.png", PNG, "image/png")})
    assert r.status_code == 503 and r.json()["code"] == "ai_bad_output"


def test_explain_sends_only_styling_attributes(client, groq, make_garment):
    sent, replies = groq
    shirt = make_garment("Dad's lucky shirt", "shirt", color="white", notes="private note")
    jeans = make_garment("Jeans", "jeans", color="blue")
    replies.append(groq_reply('{"summary": "Classic and clean.", "tips": ["Roll the sleeves", "", 3]}'))
    r = client.post("/api/outfits/explain", json={"garment_ids": [shirt["id"], jeans["id"]], "occasion": "Casual"})
    assert r.json() == {"summary": "Classic and clean.", "tips": ["Roll the sleeves"]}
    user_msg = sent[0]["messages"][1]["content"]
    assert "lucky" not in user_msg and "private" not in user_msg
    assert "white" in user_msg and "Casual" in user_msg
    assert sent[0]["model"] == ai.settings.groq_text_model


# --- Outfit engine --------------------------------------------------------------


def generate(client, **body):
    r = client.post("/api/outfits/generate", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def names(outfit):
    return {g["name"] for g in outfit["garments"]}


def test_generated_outfits_exclude_unavailable_garments(client, make_garment, make_basket):
    s1 = make_garment("White shirt", "shirt", color="white")
    s2 = make_garment("Blue shirt", "shirt", color="blue")
    make_garment("Navy trousers", "trousers", color="navy")
    make_garment("Brown shoes", "shoes", color="brown")
    make_basket(garment_ids=[s1["id"]])
    client.post("/api/garments/actions/needs-ironing", json={"garment_ids": [s2["id"]]})
    out = generate(client)
    assert out["outfits"] == []
    assert "None of your tops are ready to wear right now." in out["notes"]

    client.post("/api/garments/actions/ironed", json={"garment_ids": [s2["id"]]})
    out = generate(client)
    assert [names(o) for o in out["outfits"]] == [{"Blue shirt", "Navy trousers", "Brown shoes"}]
    assert all(g["wearable"] for o in out["outfits"] for g in o["garments"])


def test_ranking_prefers_occasion_and_formality(client, make_garment):
    make_garment("Formal shirt", "shirt", color="white", formality=5, labels=["Office"])
    make_garment("Band tee", "t-shirt", color="black", formality=1, labels=["Casual"])
    make_garment("Suit trousers", "trousers", color="charcoal", formality=5, labels=["Office"])
    make_garment("Ripped jeans", "jeans", color="blue", formality=1, labels=["Casual"])
    best = generate(client, occasion="Office", formality=5)["outfits"][0]
    assert names(best) == {"Formal shirt", "Suit trousers"}
    assert "Every piece is tagged Office" in best["reasons"]
    best = generate(client, occasion="Casual", formality=1)["outfits"][0]
    assert names(best) == {"Band tee", "Ripped jeans"}


def test_color_harmony():
    assert outfits.color_pair_score("Navy", "red") == 1.0
    assert outfits.color_pair_score("light blue", "blue") == 0.85
    assert outfits.color_pair_score("red", "green") < outfits.color_pair_score("blue", "teal")
    assert outfits.color_pair_score(None, "red") == 0.75


def test_feedback_changes_ranking(client, make_garment):
    a = make_garment("Shirt A", "shirt", color="white")
    b = make_garment("Shirt B", "shirt", color="white")
    t = make_garment("Trousers", "trousers", color="navy")
    first = generate(client, count=2)["outfits"]
    assert len(first) == 2 and first[0]["score"] == first[1]["score"]
    r = client.post("/api/outfits/feedback", json={"garment_ids": [b["id"], t["id"]], "rating": 1})
    assert r.status_code == 204
    client.post("/api/outfits/feedback", json={"garment_ids": [a["id"], t["id"]], "rating": -1})
    ranked = generate(client, count=2)["outfits"]
    assert names(ranked[0]) == {"Shirt B", "Trousers"}
    assert "Similar to outfits you liked" in ranked[0]["reasons"]
    assert "Similar to outfits you disliked" in ranked[1]["cautions"]


def test_recent_repetition_is_penalised(client, make_garment):
    a = make_garment("Shirt A", "shirt", color="white", max_wears_before_wash=5)
    make_garment("Shirt B", "shirt", color="white")
    t = make_garment("Trousers", "trousers", color="navy", max_wears_before_wash=5)
    client.post("/api/garments/actions/wear", json={"garment_ids": [a["id"], t["id"]], "worn_on": "2026-10-10"})
    ranked = generate(client, count=2, today="2026-10-13")["outfits"]
    assert names(ranked[0]) == {"Shirt B", "Trousers"}
    assert any(c.startswith("Worn together recently") for c in ranked[1]["cautions"])


def test_cold_weather_adds_layer(client, make_garment):
    make_garment("Shirt", "shirt", color="white")
    make_garment("Jeans", "jeans", color="blue")
    make_garment("Wool jacket", "jacket", color="grey", weather=["Cold"])
    assert names(generate(client, weather=["Cold"])["outfits"][0]) == {"Shirt", "Jeans", "Wool jacket"}
    assert names(generate(client, weather=["Hot"])["outfits"][0]) == {"Shirt", "Jeans"}


def test_variety_caps_reuse(client, make_garment):
    make_garment("Star shirt", "shirt", color="white", labels=["Office"])
    make_garment("Other shirt", "shirt", color="white")
    for i in range(4):
        make_garment(f"Trousers {i}", "trousers", color="navy", labels=["Office"])
    out = generate(client, occasion="Office", count=5)["outfits"]
    star = sum(1 for o in out if "Star shirt" in names(o))
    assert star == outfits.MAX_REUSE


def test_feedback_requires_owned_garments(client, make_garment):
    g = make_garment()
    r = client.post("/api/outfits/feedback", json={"garment_ids": [g["id"], "nope"], "rating": 1})
    assert r.status_code == 404
