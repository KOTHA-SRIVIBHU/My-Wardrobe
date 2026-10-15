// Deterministic outfit generation and scoring. Callers decide which garments are
// "available" (wearable now, or clean on a future day in the planner), so availability
// rules can't be bypassed. Scores come with plain-language reasons.
import { isWearable } from './lifecycle'
import type { FeedbackRow, GarmentEventRow, GarmentRow } from './rows'
import { addDays, dayLabelPadded, daysBetween } from './time'

export const SLOT_OF: Record<string, string> = {
  shirt: 'top', 't-shirt': 'top',
  trousers: 'bottom', jeans: 'bottom', shorts: 'bottom', skirt: 'bottom',
  dress: 'onepiece', suit: 'onepiece',
  jacket: 'layer', sweater: 'layer',
  shoes: 'shoes',
}
const LAYER_WEATHER = new Set(['Cold', 'Mild', 'Windy', 'Rainy'])
const WARM_WEATHER = new Set(['Hot', 'Warm', 'Humid'])
const PER_SLOT = 12
export const MAX_REUSE = 2

// --- Colour harmony ---------------------------------------------------------------------

const NEUTRALS = new Set([
  'black', 'white', 'off-white', 'grey', 'gray', 'charcoal', 'navy', 'beige', 'cream',
  'ivory', 'khaki', 'tan', 'brown', 'camel', 'stone', 'denim', 'taupe', 'silver',
])
const HUES: Record<string, number> = {
  red: 0, burgundy: 345, maroon: 345, wine: 345, coral: 15, rust: 20,
  orange: 30, peach: 25, mustard: 45, gold: 48, yellow: 55, olive: 75,
  lime: 90, green: 120, mint: 150, emerald: 140, teal: 175, turquoise: 175,
  aqua: 180, cyan: 185, 'sky blue': 200, 'light blue': 205, blue: 220,
  'royal blue': 225, indigo: 245, lavender: 270, purple: 275, violet: 280,
  lilac: 285, magenta: 310, pink: 330, rose: 340,
}
const COLOR_WORDS = [...NEUTRALS, ...Object.keys(HUES)].sort((a, b) => b.length - a.length)

export function colorKey(color: string | null | undefined): string | null {
  if (!color) return null
  const c = color.toLowerCase()
  return COLOR_WORDS.find((w) => c.includes(w)) ?? null
}

export function colorPairScore(a: string | null, b: string | null): number {
  const ka = colorKey(a)
  const kb = colorKey(b)
  if (ka === null || kb === null) return 0.75
  if (NEUTRALS.has(ka) || NEUTRALS.has(kb)) return 1.0
  let d = Math.abs(HUES[ka] - HUES[kb]) % 360
  d = Math.min(d, 360 - d)
  if (d <= 20) return 0.85
  if (d <= 60) return 0.9
  if (d >= 150 && d <= 210) return 0.75
  return 0.45
}

const isPatterned = (g: GarmentRow) => !!g.pattern && !['solid', 'plain'].includes(g.pattern.toLowerCase())

// --- Request & result -------------------------------------------------------------------

export interface OutfitRequest {
  occasion: string | null
  formality: number | null
  weather: string[]
  count: number
  today: string
}

export interface Suggestion {
  garments: GarmentRow[]
  score: number
  breakdown: Record<string, number>
  reasons: string[]
  cautions: string[]
}

export interface OutfitContext {
  req: OutfitRequest
  feedback: [Set<string>, number][]
  wornTogether: [Set<string>, string][]
}

const tagsOf = (g: GarmentRow) => new Set([...g.labels, ...g.occasions].map((t) => t.toLowerCase()))

export function garmentFit(g: GarmentRow, ctx: OutfitContext): [number, Record<string, number>] {
  const req = ctx.req
  const parts: Record<string, number> = {}
  if (req.occasion) parts.occasion = tagsOf(g).has(req.occasion.toLowerCase()) ? 1 : 0
  if (req.formality) parts.formality = g.formality === null ? 0.5 : 1 - Math.abs(g.formality - req.formality) / 4
  if (req.weather.length) {
    if (!g.weather.length) parts.weather = 0.5
    else parts.weather = g.weather.some((w) => req.weather.includes(w)) ? 1 : 0.2
  }
  const days = g.last_worn_on ? daysBetween(g.last_worn_on, req.today) : null
  parts.freshness = days === null || days > 3 ? 1 : days <= 1 ? 0.4 : 0.75
  const values = Object.values(parts)
  let score = values.reduce((a, b) => a + b, 0) / values.length
  if (tagsOf(g).has('favorite')) score = Math.min(1, score + 0.1)
  return [score, parts]
}

const intersect = (a: Set<string>, b: Set<string>) => [...a].filter((x) => b.has(x)).length

function score(items: GarmentRow[], ctx: OutfitContext): Suggestion {
  const fits = items.map((g) => garmentFit(g, ctx))
  const fit = fits.reduce((a, [f]) => a + f, 0) / fits.length

  const pairs: [GarmentRow, GarmentRow][] = []
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) pairs.push([items[i], items[j]])
  const color = pairs.length ? pairs.reduce((a, [x, y]) => a + colorPairScore(x.color, y.color), 0) / pairs.length : 1
  const patterned = items.filter(isPatterned)
  const pattern = patterned.length <= 1 ? 1 : 0.5
  const formal = items.map((g) => g.formality).filter((f): f is number => f !== null)
  const coherence = formal.length >= 2 ? 1 - (Math.max(...formal) - Math.min(...formal)) / 4 : 0.75

  const ids = new Set(items.map((g) => g.id))
  let signal = 0
  for (const [liked, rating] of ctx.feedback) {
    const overlap = intersect(ids, liked)
    if (overlap >= 2) signal += (rating * overlap) / Math.max(liked.size, ids.size)
  }
  const feedback = (Math.max(-1, Math.min(1, signal)) + 1) / 2

  const recent = ctx.wornTogether.filter(([combo]) => intersect(combo, ids) >= 2).map(([, d]) => d)
  const repetition = recent.length ? 0.5 : 1

  const breakdown = { fit, color, formality: coherence, pattern, feedback, repetition }
  const total = fit * 0.35 + color * 0.2 + coherence * 0.15 + pattern * 0.05 + feedback * 0.15 + repetition * 0.1

  const reasons: string[] = []
  const cautions: string[] = []
  const req = ctx.req
  const colors = items.map((g) => g.color).filter((c): c is string => !!c)
  if (color >= 0.9 && colors.length >= 2) reasons.push(`Colours work together (${[...new Set(colors)].join(' + ')})`)
  else if (color < 0.6) cautions.push('Colours may clash')
  if (req.occasion) {
    const matching = fits.filter(([, p]) => p.occasion === 1).length
    if (matching === items.length) reasons.push(`Every piece is tagged ${req.occasion}`)
    else if (matching) reasons.push(`${matching} of ${items.length} pieces tagged ${req.occasion}`)
    else cautions.push(`Nothing here is tagged ${req.occasion}`)
  }
  if (req.formality && formal.length) {
    const avg = formal.reduce((a, b) => a + b, 0) / formal.length
    if (Math.abs(avg - req.formality) <= 0.75) reasons.push(`Right formality level (${req.formality}/5)`)
  } else if (coherence >= 0.75 && formal.length >= 2) {
    reasons.push('Pieces sit at a similar formality')
  }
  if (req.weather.length && fits.every(([, p]) => (p.weather ?? 0) >= 0.5)) {
    if (fits.some(([, p]) => p.weather === 1)) reasons.push(`Suited to ${req.weather.join(', ').toLowerCase()} weather`)
  }
  if (patterned.length > 1) cautions.push('More than one patterned piece')
  if (feedback > 0.6) reasons.push('Similar to outfits you liked')
  else if (feedback < 0.4) cautions.push('Similar to outfits you disliked')
  if (recent.length) cautions.push(`Worn together recently (${dayLabelPadded(recent.sort().at(-1)!)})`)
  if (fits.some(([, p]) => p.freshness < 0.5)) cautions.push('Includes something you wore yesterday')

  return { garments: items, score: Math.round(total * 100), breakdown, reasons, cautions }
}

export function loadContext(req: OutfitRequest, feedback: FeedbackRow[], events: GarmentEventRow[]): OutfitContext {
  const since = addDays(req.today, -14)
  const byDay = new Map<string, Set<string>>()
  for (const e of events) {
    if (e.kind !== 'worn' || !e.worn_on || e.worn_on < since) continue
    if (!byDay.has(e.worn_on)) byDay.set(e.worn_on, new Set())
    byDay.get(e.worn_on)!.add(e.garment_id)
  }
  return {
    req,
    feedback: feedback.map((f) => [new Set(f.garment_ids), f.rating]),
    wornTogether: [...byDay.entries()].filter(([, ids]) => ids.size >= 2).map(([day, ids]) => [ids, day]),
  }
}

export const withRequest = (ctx: OutfitContext, req: OutfitRequest): OutfitContext => ({ ...ctx, req })

/** true = add a layer, false = skip, null = only if it improves the score. */
function wantsLayer(req: OutfitRequest): boolean | null {
  const w = new Set(req.weather)
  if (['Cold', 'Windy', 'Rainy'].some((x) => w.has(x))) return true
  if ([...WARM_WEATHER].some((x) => w.has(x))) return false
  return (req.formality ?? 0) >= 4 || [...LAYER_WEATHER].some((x) => w.has(x)) ? null : false
}

function slots(available: GarmentRow[], ctx: OutfitContext): Record<string, GarmentRow[]> {
  const out: Record<string, GarmentRow[]> = { top: [], bottom: [], onepiece: [], layer: [], shoes: [] }
  for (const g of available) {
    const slot = SLOT_OF[g.category]
    if (slot) out[slot].push(g)
  }
  for (const key of Object.keys(out)) {
    const fit = new Map(out[key].map((g) => [g.id, garmentFit(g, ctx)[0]]))
    out[key] = out[key].sort((a, b) => fit.get(b.id)! - fit.get(a.id)!).slice(0, PER_SLOT)
  }
  return out
}

/** Every base outfit (top+bottom or one-piece) built from `available`, best first. */
export function rank(available: GarmentRow[], ctx: OutfitContext): Suggestion[] {
  const s = slots(available, ctx)
  const bases: GarmentRow[][] = []
  for (const t of s.top) for (const b of s.bottom) bases.push([t, b])
  for (const o of s.onepiece) bases.push([o])
  const layer = wantsLayer(ctx.req)
  const shoes = s.shoes.slice(0, 5)
  const layers = s.layer.slice(0, 5)
  const scored: Suggestion[] = []
  for (const base of bases) {
    let options = [base]
    if (shoes.length) options = options.flatMap((o) => shoes.map((sh) => [...o, sh]))
    if (layers.length && layer !== false) {
      const withLayer = options.flatMap((o) => layers.map((l) => [...o, l]))
      options = layer ? withLayer : [...options, ...withLayer]
    }
    let best: Suggestion | null = null
    for (const o of options) {
      const sc = score(o, ctx)
      if (!best || sc.score > best.score) best = sc
    }
    scored.push(best!)
  }
  return scored.sort((a, b) => b.score - a.score)
}

/** Suggestions from what's wearable right now, plus notes on why there are few/none. */
export function generate(garments: GarmentRow[], ctx: OutfitContext): [Suggestion[], string[]] {
  const pool = garments.filter((g) => !g.archived)
  const wearable = pool.filter(isWearable)
  const s = slots(wearable, ctx)
  const notes: string[] = []
  const owned: Record<string, number> = {}
  for (const g of pool) {
    const slot = SLOT_OF[g.category]
    if (slot) owned[slot] = (owned[slot] ?? 0) + 1
  }
  for (const [slot, label] of [['top', 'tops'], ['bottom', 'bottoms'], ['shoes', 'shoes']]) {
    if (owned[slot] && !s[slot].length) notes.push(`None of your ${label} are ready to wear right now.`)
  }
  if (!(s.top.length && s.bottom.length) && !s.onepiece.length) {
    if (!notes.length) notes.push('Add some tops and bottoms (or dresses/suits) to get outfit suggestions.')
    return [[], notes]
  }
  if (wantsLayer(ctx.req) && owned.layer && !s.layer.length) notes.push('No jackets or sweaters are ready, so outfits skip a layer.')

  const chosen: Suggestion[] = []
  const uses = new Map<string, number>()
  for (const sug of rank(wearable, ctx)) {
    // Prefer variety: cap how often any single garment is suggested.
    if (sug.garments.some((g) => SLOT_OF[g.category] !== 'shoes' && (uses.get(g.id) ?? 0) >= MAX_REUSE)) continue
    chosen.push(sug)
    for (const g of sug.garments) uses.set(g.id, (uses.get(g.id) ?? 0) + 1)
    if (chosen.length === ctx.req.count) break
  }
  return [chosen, notes]
}
