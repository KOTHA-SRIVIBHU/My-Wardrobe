"""Groq integration (free tier, OpenAI-compatible API).

The API key stays on the backend. Every AI feature is optional: callers either let
AIUnavailable surface as HTTP 503 with a reason code, or fall back to deterministic
behaviour. There is deliberately no fallback to any other (paid) provider.

AI output is always treated as untrusted suggestions: it is sanitised against the
app's vocabularies and never changes garment state or availability.
"""

import base64
import json
import re

import httpx

from . import vocab
from .config import settings
from .lifecycle import CATEGORY_DEFAULTS


class AIUnavailable(Exception):
    def __init__(self, message: str, code: str, retry_after: int | None = None):
        super().__init__(message)
        self.message = message
        self.code = code
        self.retry_after = retry_after


class NotClothing(Exception):
    pass


def enabled() -> bool:
    return bool(settings.groq_api_key)


def status() -> dict:
    return {
        "enabled": enabled(),
        "provider": "groq",
        "vision_model": settings.groq_vision_model,
        "text_model": settings.groq_text_model,
    }


def _model_options(model: str) -> dict:
    # Reasoning models spend tokens thinking first. Qwen 3 can switch it off; GPT-OSS
    # can't, but "low" keeps it short (its reasoning arrives in a separate field).
    if model.startswith("qwen/"):
        return {"reasoning_effort": "none"}
    if model.startswith("openai/gpt-oss"):
        return {"reasoning_effort": "low"}
    return {}


def _post(payload: dict) -> httpx.Response:
    """Single HTTP seam, replaced in tests."""
    return httpx.post(
        f"{settings.groq_base_url}/chat/completions",
        json=payload,
        headers={"Authorization": f"Bearer {settings.groq_api_key}"},
        timeout=45,
    )


def _parse_json(text: str) -> dict:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    candidates = [text]
    if match := re.search(r"\{.*\}", text, re.S):
        candidates.append(match.group(0))
    for c in candidates:
        try:
            data = json.loads(c)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
    raise AIUnavailable("The AI reply wasn't usable. Please try again.", "ai_bad_output")


def chat_json(model: str, messages: list[dict], max_tokens: int = 600) -> dict:
    if not enabled():
        raise AIUnavailable(
            "AI features are off. Add a GROQ_API_KEY to the backend to enable them.",
            "ai_not_configured",
        )
    payload = {
        "model": model,
        "messages": messages,
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
        "max_completion_tokens": max_tokens,
        **_model_options(model),
    }
    try:
        r = _post(payload)
    except httpx.HTTPError:
        raise AIUnavailable("Couldn't reach Groq. Please try again later.", "ai_unreachable")
    if r.status_code == 429:
        retry = r.headers.get("retry-after")
        retry_s = int(float(retry)) if retry and retry.replace(".", "", 1).isdigit() else None
        wait = f" Try again in about {retry_s} s." if retry_s else " Try again later."
        raise AIUnavailable(
            "Groq's free-tier limit has been reached." + wait + " Everything else keeps working.",
            "ai_quota",
            retry_s,
        )
    if r.status_code in (401, 403):
        raise AIUnavailable("Groq rejected the API key. Check GROQ_API_KEY.", "ai_auth")
    if r.status_code == 404:
        raise AIUnavailable(f"Groq doesn't offer the model '{model}' any more.", "ai_model")
    if r.status_code >= 400:
        raise AIUnavailable(f"Groq returned an error ({r.status_code}).", "ai_error")
    try:
        content = r.json()["choices"][0]["message"].get("content") or ""
    except (ValueError, KeyError, IndexError, TypeError):
        raise AIUnavailable("The AI reply wasn't usable. Please try again.", "ai_bad_output")
    return _parse_json(content)


# --- Photo classification -----------------------------------------------------

_CATEGORIES = list(CATEGORY_DEFAULTS)

CLASSIFY_PROMPT = f"""You label clothing photos for a personal wardrobe app.
Describe the single main garment in the photo. Reply with a JSON object only, with these keys:
- "name": short descriptive name, e.g. "Light blue Oxford shirt"
- "category": one of {_CATEGORIES}
- "subcategory": e.g. "Oxford", "polo", "chinos", or null
- "color": the main colour as one or two common words
- "pattern": one of {vocab.PATTERNS}
- "fabric": best guess or null
- "formality": integer 1-5 (1 very casual, 3 smart casual, 5 formal)
- "occasions": up to 4 of {vocab.OCCASIONS}
- "labels": up to 3 of {vocab.SUGGESTED_LABELS}
- "seasons": any of {vocab.SEASONS}
- "weather": any of {vocab.WEATHER}
If the photo does not show clothing, reply {{"error": "not_clothing"}}."""


def _text(v: object, max_len: int) -> str | None:
    if not isinstance(v, str):
        return None
    v = " ".join(v.split())
    return v[:max_len] or None


def sanitize_classification(raw: dict) -> dict:
    if raw.get("error") == "not_clothing":
        raise NotClothing()
    category = (_text(raw.get("category"), 40) or "").lower()
    formality = raw.get("formality")
    try:
        formality = min(5, max(1, int(formality))) if formality is not None else None
    except (TypeError, ValueError):
        formality = None
    pattern = (_text(raw.get("pattern"), 40) or "").lower()
    return {
        "name": _text(raw.get("name"), 120),
        "category": category if category in CATEGORY_DEFAULTS else "other",
        "subcategory": _text(raw.get("subcategory"), 60),
        "color": (_text(raw.get("color"), 40) or "").lower() or None,
        "pattern": pattern if pattern in vocab.PATTERNS else None,
        "fabric": _text(raw.get("fabric"), 60),
        "formality": formality,
        "occasions": vocab.canonical(raw.get("occasions"), vocab.OCCASIONS, 4),
        "labels": vocab.canonical(raw.get("labels"), vocab.SUGGESTED_LABELS, 3),
        "seasons": vocab.canonical(raw.get("seasons"), vocab.SEASONS),
        "weather": vocab.canonical(raw.get("weather"), vocab.WEATHER),
    }


def classify_image(data: bytes, content_type: str) -> dict:
    image_url = f"data:{content_type};base64,{base64.b64encode(data).decode()}"
    raw = chat_json(
        settings.groq_vision_model,
        [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": CLASSIFY_PROMPT},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            }
        ],
        max_tokens=400,
    )
    return sanitize_classification(raw)


# --- Routine interpretation ------------------------------------------------------

_DAY_NAMES = {
    name: i
    for i, names in enumerate([
        ("monday", "mon"), ("tuesday", "tue", "tues"), ("wednesday", "wed"),
        ("thursday", "thu", "thur", "thurs"), ("friday", "fri"), ("saturday", "sat"), ("sunday", "sun"),
    ])
    for name in names
}


def _interpret_prompt(categories: list[str]) -> str:
    return f"""You turn a person's description of their clothing routine into structured rules
for a wardrobe planner. Reply with a JSON object only:
{{"routines": [{{
    "name": short name, e.g. "Office days",
    "kind": "day" or "night",
    "weekdays": weekday numbers, 0=Monday ... 6=Sunday,
    "occasion": one of {vocab.OCCASIONS} or null,
    "formality": 1-5 or null (1 very casual, 5 formal),
    "mandatory": true unless the person says it is optional,
    "requirements": [{{
        "category": one of {categories},
        "quantity": items needed per day,
        "min_formality": 1-5 or null,
        "reuse": "fixed" if the same item is worn every time (e.g. the same shoes all month), else "rotate",
        "no_consecutive": true only if they say not to repeat an item on consecutive days
    }}]
}}],
"questions": [short clarification questions, only if something important is ambiguous]}}
Rules: a "pair" of socks, underwear or nightwear is quantity 1. A "formal shirt" is category
"shirt" with min_formality 4. Use only the listed categories; if an item fits none, ask about
it in "questions" instead of inventing a category. Night-time routines have kind "night"."""


def _weekdays(v: object) -> list[int]:
    out: set[int] = set()
    for x in v if isinstance(v, list) else []:
        if isinstance(x, bool):
            continue
        if isinstance(x, int) and 0 <= x <= 6:
            out.add(x)
        elif isinstance(x, str) and (i := _DAY_NAMES.get(x.strip().lower())) is not None:
            out.add(i)
    return sorted(out)


def _level(v: object) -> int | None:
    try:
        return min(5, max(1, int(v))) if v is not None and not isinstance(v, bool) else None
    except (TypeError, ValueError):
        return None


def sanitize_routines(raw: dict, categories: list[str]) -> dict:
    allowed = {c.lower() for c in categories}
    questions = [q for q in (_text(x, 200) for x in (raw.get("questions") or [])[:5]) if q]
    routines = []
    for r in (raw.get("routines") or [])[:10]:
        if not isinstance(r, dict):
            continue
        name = _text(r.get("name"), 120) or "Routine"
        requirements = []
        for req in (r.get("requirements") or [])[:15]:
            if not isinstance(req, dict):
                continue
            category = (_text(req.get("category"), 40) or "").lower()
            if category not in allowed:
                if category:
                    questions.append(f"'{category}' in {name} isn't one of your categories. Which category should it use?")
                continue
            try:
                qty = min(10, max(1, int(req.get("quantity") or 1)))
            except (TypeError, ValueError):
                qty = 1
            requirements.append({
                "category": category,
                "quantity": qty,
                "labels": [],
                "min_formality": _level(req.get("min_formality")),
                "reuse": "fixed" if req.get("reuse") == "fixed" else "rotate",
                "no_consecutive": req.get("no_consecutive") is True,
            })
        weekdays = _weekdays(r.get("weekdays"))
        if not weekdays:
            questions.append(f"Which days of the week does '{name}' apply to?")
        occasion = vocab.canonical([r.get("occasion")], vocab.OCCASIONS)
        routines.append({
            "name": name,
            "kind": "night" if r.get("kind") == "night" else "day",
            "weekdays": weekdays,
            "occasion": occasion[0] if occasion else None,
            "formality": _level(r.get("formality")),
            "mandatory": r.get("mandatory") is not False,
            "requirements": requirements,
        })
    return {"routines": routines, "questions": list(dict.fromkeys(questions))}


def interpret_routines(text: str, categories: list[str]) -> dict:
    raw = chat_json(
        settings.groq_text_model,
        [
            {"role": "system", "content": _interpret_prompt(categories)},
            {"role": "user", "content": text},
        ],
        max_tokens=2000,
    )
    return sanitize_routines(raw, categories)


# --- Weekly brief -----------------------------------------------------------------

BRIEF_PROMPT = """You are a friendly wardrobe assistant. Below are facts computed by the user's
wardrobe planner: whether their clean clothes will last until laundry, shortages, suggested
fixes, and the planned outfits with weather. Write a short briefing for the coming days.
Use ONLY these facts: never invent garments, dates or numbers. Reply with a JSON object only:
{"summary": one or two sentences, "bullets": up to 5 short points about the days ahead,
 "tips": up to 3 short, practical tips (laundry timing, ironing, weather)}."""


def weekly_brief(facts: dict) -> dict:
    raw = chat_json(
        settings.groq_text_model,
        [
            {"role": "system", "content": BRIEF_PROMPT},
            {"role": "user", "content": json.dumps(facts, default=str)},
        ],
        max_tokens=1500,
    )
    summary = _text(raw.get("summary"), 400)
    if not summary:
        raise AIUnavailable("The AI reply wasn't usable. Please try again.", "ai_bad_output")

    def items(key: str, n: int) -> list[str]:
        values = raw.get(key) if isinstance(raw.get(key), list) else []
        return [t for t in (_text(x, 220) for x in values[:n]) if t]

    return {"summary": summary, "bullets": items("bullets", 5), "tips": items("tips", 3)}


# --- Outfit explanations ------------------------------------------------------

EXPLAIN_PROMPT = """You are a concise personal stylist. The user has already chosen the outfit
below from clothes they own and that are clean and ready to wear. Explain briefly why it works
for the context. Only mention the listed garments; don't suggest buying anything.
Reply with a JSON object only: {"summary": one or two sentences, "tips": up to 2 short styling tips}."""


def explain_outfit(garments: list[dict], context: dict) -> dict:
    # Only styling-relevant attributes are sent: no names of people, notes or user ids.
    raw = chat_json(
        settings.groq_text_model,
        [
            {"role": "system", "content": EXPLAIN_PROMPT},
            {"role": "user", "content": json.dumps({"outfit": garments, "context": context})},
        ],
        max_tokens=1000,  # headroom for reasoning tokens on GPT-OSS
    )
    tips = raw.get("tips") if isinstance(raw.get("tips"), list) else []
    summary = _text(raw.get("summary"), 400)
    if not summary:
        raise AIUnavailable("The AI reply wasn't usable. Please try again.", "ai_bad_output")
    return {
        "summary": summary,
        "tips": [t for t in (_text(x, 200) for x in tips[:2]) if t],
    }
