"""Controlled vocabularies shared by the API, the AI prompts and the outfit engine."""

SEASONS = ["Spring", "Summer", "Autumn", "Winter"]
WEATHER = ["Hot", "Warm", "Mild", "Cold", "Rainy", "Windy", "Humid"]
PATTERNS = [
    "solid", "striped", "checked", "plaid", "floral", "printed",
    "graphic", "polka dot", "textured", "other",
]
SUGGESTED_LABELS = [
    "Office", "College", "Party", "Casual", "Nightwear",
    "Travel", "Gym", "Rainy Weather", "Favorite",
]
OCCASIONS = [
    "Office", "College", "Casual", "Party", "Wedding", "Interview",
    "Date", "Gym", "Travel", "Lounge", "Outdoor",
]


def canonical(values: object, allowed: list[str], limit: int | None = None) -> list[str]:
    """Keep only known values (case-insensitive), in canonical spelling, without duplicates."""
    if not isinstance(values, list):
        return []
    lookup = {a.lower(): a for a in allowed}
    out: list[str] = []
    for v in values:
        if isinstance(v, str) and (c := lookup.get(v.strip().lower())) and c not in out:
            out.append(c)
    return out[:limit] if limit else out
