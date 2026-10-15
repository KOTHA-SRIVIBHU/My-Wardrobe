// Weather via Open-Meteo (free, no key). Failures never break planning: callers get an
// empty forecast plus a message.
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const CACHE_MS = 30 * 60 * 1000

export interface DayWeather {
  date: string
  temp_max: number | null
  temp_min: number | null
  feels_max: number | null
  precip_probability: number | null
  wind_max: number | null
  humidity: number | null
  tags: string[]
}

/** Replaceable in tests. */
export const http = {
  getJson: async (url: string): Promise<unknown> => {
    const r = await fetch(url)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  },
}

const cache = new Map<string, [number, Map<string, DayWeather>]>()
export const clearWeatherCache = () => cache.clear()

export function tagsFor(feelsMax: number | null, precip: number | null, wind: number | null, humidity: number | null): string[] {
  const tags: string[] = []
  if (feelsMax !== null) {
    if (feelsMax >= 30) tags.push('Hot')
    else if (feelsMax >= 24) tags.push('Warm')
    else if (feelsMax >= 14) tags.push('Mild')
    else tags.push('Cold')
  }
  if (precip !== null && precip >= 50) tags.push('Rainy')
  if (wind !== null && wind >= 30) tags.push('Windy')
  if (humidity !== null && humidity >= 75 && feelsMax !== null && feelsMax >= 24) tags.push('Humid')
  return tags
}

export async function geocode(name: string): Promise<{ name: string; latitude: number; longitude: number }[]> {
  const q = new URLSearchParams({ name, count: '5', language: 'en', format: 'json' })
  const data = (await http.getJson(`${GEOCODE_URL}?${q}`)) as { results?: Record<string, unknown>[] }
  return (data.results ?? []).map((r) => ({
    name: [r.name, r.admin1, r.country].filter(Boolean).join(', '),
    latitude: r.latitude as number,
    longitude: r.longitude as number,
  }))
}

export async function forecast(lat: number, lon: number): Promise<Map<string, DayWeather>> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit[0] < CACHE_MS) return hit[1]
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: [
      'temperature_2m_max', 'temperature_2m_min', 'apparent_temperature_max',
      'precipitation_probability_max', 'wind_speed_10m_max', 'relative_humidity_2m_mean',
    ].join(','),
    timezone: 'auto',
    forecast_days: '16',
  })
  const data = (await http.getJson(`${FORECAST_URL}?${q}`)) as { daily?: Record<string, (number | string | null)[]> }
  const daily = data.daily ?? {}
  const col = (name: string, i: number) => ((daily[name] ?? [])[i] ?? null) as number | null
  const out = new Map<string, DayWeather>()
  ;((daily.time ?? []) as string[]).forEach((d, i) => {
    const feels = col('apparent_temperature_max', i)
    const precip = col('precipitation_probability_max', i)
    const wind = col('wind_speed_10m_max', i)
    const humidity = col('relative_humidity_2m_mean', i)
    out.set(d, {
      date: d,
      temp_max: col('temperature_2m_max', i),
      temp_min: col('temperature_2m_min', i),
      feels_max: feels,
      precip_probability: precip,
      wind_max: wind,
      humidity,
      tags: tagsFor(feels, precip, wind, humidity),
    })
  })
  cache.set(key, [Date.now(), out])
  return out
}

export async function safeForecast(lat: number | null, lon: number | null): Promise<[Map<string, DayWeather>, string | null]> {
  if (lat === null || lon === null) return [new Map(), null]
  try {
    return [await forecast(lat, lon), null]
  } catch {
    return [new Map(), 'Weather forecast is unavailable right now.']
  }
}
