"""Weather via Open-Meteo (free, no API key).

Forecasts are turned into the app's weather tags (Hot, Cold, Rainy, ...). Failures
are never fatal: callers get an empty forecast plus an error message, and planning
continues without weather.
"""

import time
from dataclasses import dataclass
from datetime import date

import httpx

GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
CACHE_SECONDS = 30 * 60
MAX_DAYS = 16

_cache: dict[tuple[float, float], tuple[float, dict]] = {}


@dataclass
class DayWeather:
    date: date
    temp_max: float | None
    temp_min: float | None
    feels_max: float | None
    precip_probability: int | None
    wind_max: float | None
    humidity: float | None
    tags: list[str]


def _get(url: str, params: dict) -> dict:
    """Single HTTP seam, replaced in tests."""
    r = httpx.get(url, params=params, timeout=15)
    r.raise_for_status()
    return r.json()


def tags_for(feels_max: float | None, precip: int | None, wind: float | None, humidity: float | None) -> list[str]:
    tags: list[str] = []
    if feels_max is not None:
        if feels_max >= 30:
            tags.append("Hot")
        elif feels_max >= 24:
            tags.append("Warm")
        elif feels_max >= 14:
            tags.append("Mild")
        else:
            tags.append("Cold")
    if precip is not None and precip >= 50:
        tags.append("Rainy")
    if wind is not None and wind >= 30:
        tags.append("Windy")
    if humidity is not None and humidity >= 75 and feels_max is not None and feels_max >= 24:
        tags.append("Humid")
    return tags


def geocode(name: str) -> list[dict]:
    data = _get(GEOCODE_URL, {"name": name, "count": 5, "language": "en", "format": "json"})
    return [
        {
            "name": ", ".join(p for p in (r.get("name"), r.get("admin1"), r.get("country")) if p),
            "latitude": r["latitude"],
            "longitude": r["longitude"],
        }
        for r in data.get("results") or []
    ]


def forecast(lat: float, lon: float) -> dict[date, DayWeather]:
    """Up to 16 days of daily forecast, keyed by local date. Raises httpx.HTTPError."""
    key = (round(lat, 2), round(lon, 2))
    hit = _cache.get(key)
    if hit and time.monotonic() - hit[0] < CACHE_SECONDS:
        return hit[1]
    data = _get(
        FORECAST_URL,
        {
            "latitude": lat,
            "longitude": lon,
            "daily": ",".join([
                "temperature_2m_max", "temperature_2m_min", "apparent_temperature_max",
                "precipitation_probability_max", "wind_speed_10m_max", "relative_humidity_2m_mean",
            ]),
            "timezone": "auto",
            "forecast_days": MAX_DAYS,
        },
    )
    daily = data.get("daily") or {}
    days = daily.get("time") or []

    def col(name: str, i: int):
        values = daily.get(name) or []
        return values[i] if i < len(values) else None

    out: dict[date, DayWeather] = {}
    for i, d in enumerate(days):
        feels = col("apparent_temperature_max", i)
        precip = col("precipitation_probability_max", i)
        wind = col("wind_speed_10m_max", i)
        humidity = col("relative_humidity_2m_mean", i)
        out[date.fromisoformat(d)] = DayWeather(
            date=date.fromisoformat(d),
            temp_max=col("temperature_2m_max", i),
            temp_min=col("temperature_2m_min", i),
            feels_max=feels,
            precip_probability=precip,
            wind_max=wind,
            humidity=humidity,
            tags=tags_for(feels, precip, wind, humidity),
        )
    _cache[key] = (time.monotonic(), out)
    return out


def safe_forecast(lat: float | None, lon: float | None) -> tuple[dict[date, DayWeather], str | None]:
    if lat is None or lon is None:
        return {}, None
    try:
        return forecast(lat, lon), None
    except (httpx.HTTPError, ValueError, KeyError):
        return {}, "Weather forecast is unavailable right now."
