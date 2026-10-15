// Controlled vocabularies shared by the forms, the AI prompts and the outfit engine.
export const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter']
export const WEATHER = ['Hot', 'Warm', 'Mild', 'Cold', 'Rainy', 'Windy', 'Humid']
export const PATTERNS = ['solid', 'striped', 'checked', 'plaid', 'floral', 'printed', 'graphic', 'polka dot', 'textured', 'other']
export const SUGGESTED_LABELS = ['Office', 'College', 'Party', 'Casual', 'Nightwear', 'Travel', 'Gym', 'Rainy Weather', 'Favorite']
export const OCCASIONS = ['Office', 'College', 'Casual', 'Party', 'Wedding', 'Interview', 'Date', 'Gym', 'Travel', 'Lounge', 'Outdoor']

/** Keep only known values (case-insensitive), in canonical spelling, without duplicates. */
export function canonical(values: unknown, allowed: string[], limit?: number): string[] {
  if (!Array.isArray(values)) return []
  const lookup = new Map(allowed.map((a) => [a.toLowerCase(), a]))
  const out: string[] = []
  for (const v of values) {
    const c = typeof v === 'string' ? lookup.get(v.trim().toLowerCase()) : undefined
    if (c && !out.includes(c)) out.push(c)
  }
  return limit ? out.slice(0, limit) : out
}

/** Trim, drop empties and case-insensitive duplicates (first spelling wins). */
export function cleanTags(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const seen = new Map<string, string>()
  for (const v of values) {
    if (typeof v !== 'string') continue
    const t = v.trim()
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t)
  }
  return [...seen.values()]
}
