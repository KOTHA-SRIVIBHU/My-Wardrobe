// Analytics, trip packing, purchase analysis, dashboard warnings and reminders.
// Packing and purchase analysis reuse the planner's availability simulation and the
// outfit engine, so they never count clothes that won't be clean.
import type { Analytics, DeclutterItem, GarmentStat, PurchaseResult, Reminder } from '../lib/types'
import { coverage } from './coverage'
import { CATEGORY_DEFAULTS, isWearable } from './lifecycle'
import { SLOT_OF, colorKey, rank } from './outfits'
import { Planner, type Sim, type Snapshot } from './planner'
import type { BasketItemRow, BasketRow, GarmentEventRow, GarmentRow } from './rows'
import { addDays, dateOf, dayLabelPadded, daysBetween, weekday } from './time'
import type { DayWeather } from './weather'

// --- Analytics --------------------------------------------------------------------------

export function analytics(
  garmentsAll: GarmentRow[],
  events: GarmentEventRow[],
  baskets: BasketRow[],
  items: BasketItemRow[],
  today: string,
  days: number,
): Analytics {
  const garments = garmentsAll.filter((g) => !g.archived)
  const byId = new Map(garments.map((g) => [g.id, g]))
  const since = addDays(today, -(days - 1))
  const worn = events.filter((e) => e.kind === 'worn' && e.worn_on && e.worn_on >= since && e.worn_on <= today)
  const perGarment = new Map<string, number>()
  for (const e of worn) if (byId.has(e.garment_id)) perGarment.set(e.garment_id, (perGarment.get(e.garment_id) ?? 0) + 1)
  const wearsOf = (g: GarmentRow) => perGarment.get(g.id) ?? 0

  const monday = (d: string) => addDays(d, -weekday(d))
  const thisWeek = monday(today)
  const weeks = Array.from({ length: 12 }, (_, i) => addDays(thisWeek, -7 * (11 - i)))
  const weekly = new Map<string, number>()
  for (const e of worn) weekly.set(monday(e.worn_on!), (weekly.get(monday(e.worn_on!)) ?? 0) + 1)

  // Outfit repetition: the same set of 2+ garments worn on different days.
  const perDay = new Map<string, Set<string>>()
  for (const e of worn) {
    if (!perDay.has(e.worn_on!)) perDay.set(e.worn_on!, new Set())
    perDay.get(e.worn_on!)!.add(e.garment_id)
  }
  const combos = new Map<string, number>()
  for (const ids of perDay.values()) {
    if (ids.size < 2) continue
    const key = [...ids].sort().join('|')
    combos.set(key, (combos.get(key) ?? 0) + 1)
  }
  const repeated = [...combos]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .filter(([, n]) => n >= 2)
    .map(([key, n]) => ({ garments: key.split('|').filter((g) => byId.has(g)).map((g) => byId.get(g)!.name).sort(), times: n }))

  const ref = (g: GarmentRow, value: number): GarmentStat => ({ id: g.id, name: g.name, category: g.category, value })
  const ranked = [...garments].sort((a, b) => wearsOf(a) - wearsOf(b) || a.total_wears - b.total_wears)
  const laundry = baskets.filter((b) => b.status === 'completed' && b.kind !== 'ironing')
  const recent = laundry.filter((b) => b.completed_at && dateOf(b.completed_at) >= since)
  const recentIds = new Set(recent.map((b) => b.id))
  const washed = items.filter((i) => recentIds.has(i.basket_id) && i.outcome === 'washed').length

  const cpw = garments
    .filter((g) => g.purchase_price !== null)
    .map((g) => ref(g, Math.round((Number(g.purchase_price) / Math.max(1, g.total_wears)) * 100) / 100))
    .sort((a, b) => b.value - a.value)

  const categories: Record<string, { total: number; ready: number; wears: number }> = {}
  for (const g of garments) {
    const c = (categories[g.category] ??= { total: 0, ready: 0, wears: 0 })
    c.total += 1
    c.ready += isWearable(g) ? 1 : 0
    c.wears += wearsOf(g)
  }
  const sortedCats = Object.fromEntries(Object.entries(categories).sort(([a], [b]) => a.localeCompare(b)))

  // Declutter: owned for 2+ months but not worn in the last 3 (or ever).
  const idleCutoff = addDays(today, -90)
  const declutter: DeclutterItem[] = garments
    .filter((g) => dateOf(g.created_at) <= addDays(today, -60) && (g.last_worn_on === null || g.last_worn_on < idleCutoff))
    .map((g) => ({
      id: g.id, name: g.name, category: g.category, last_worn_on: g.last_worn_on,
      idle_days: daysBetween(g.last_worn_on ?? dateOf(g.created_at), today),
      never_worn: g.last_worn_on === null,
    }))
    .sort((a, b) => b.idle_days - a.idle_days)
    .slice(0, 12)

  const lastLaundry = laundry.map((b) => b.completed_at).filter((c): c is string => !!c).sort().at(-1) ?? null
  return {
    declutter,
    period_days: days,
    garments_total: garments.length,
    garments_ready: garments.filter(isWearable).length,
    wears_in_period: worn.length,
    never_worn: garments.filter((g) => g.total_wears === 0).length,
    most_worn: ranked.slice(-5).reverse().filter((g) => wearsOf(g)).map((g) => ref(g, wearsOf(g))),
    least_worn: ranked.slice(0, 5).map((g) => ref(g, wearsOf(g))),
    weekly_wears: weeks.map((w) => ({ week: w, wears: weekly.get(w) ?? 0 })),
    repeated_outfits: repeated,
    laundry_runs: recent.length,
    garments_washed: washed,
    last_laundry: lastLaundry,
    awaiting_ironing: garments.filter((g) => g.state === 'needs_ironing').length,
    cost_per_wear: cpw.slice(0, 5),
    average_cost_per_wear: cpw.length ? Math.round((cpw.reduce((a, r) => a + r.value, 0) / cpw.length) * 100) / 100 : null,
    categories: sortedCats,
    shortages: Object.entries(sortedCats).filter(([, v]) => v.total >= 2 && v.ready === 0).map(([c]) => c),
  }
}

// --- Packing ----------------------------------------------------------------------------

const DAILY = new Set(['underwear', 'socks', 'vest'])
const TOPS = new Set(['shirt', 't-shirt'])
const BOTTOMS = new Set(['trousers', 'jeans', 'shorts', 'skirt'])
const LAYERS = new Set(['jacket', 'sweater'])

export interface PackingRequest {
  start: string
  nights: number
  activities: string[]
  laundry_available: boolean
}

export interface PackingSectionOut {
  title: string
  needed: number
  garments: GarmentRow[]
  shortfall: string | null
}

export function packingList(
  snap: Snapshot,
  req: PackingRequest,
  today: string,
  forecast: Map<string, DayWeather>,
  weatherError: string | null,
): { days: number; weather: string[]; sections: PackingSectionOut[]; notes: string[] } {
  const days = req.nights + 1
  const cycle = req.laundry_available ? Math.min(days, 4) : days
  const sim = new Planner(snap, today, Math.max(1, daysBetween(today, req.start) + 1), { today })
  const ready = [...sim.sims.values()].filter((s) => !s.dirty && s.availableFrom !== null && s.availableFrom <= req.start && !s.reservedState)

  const tags = new Set<string>()
  for (let i = 0; i < days; i++) for (const t of forecast.get(addDays(req.start, i))?.tags ?? []) tags.add(t)
  const activities = new Set(req.activities.map((a) => a.toLowerCase()))

  const scoreKey = (s: Sim): number[] => {
    const g = s.g
    const gTags = new Set([...g.labels, ...g.occasions].map((t) => t.toLowerCase()))
    const weatherFit = tags.size && g.weather.some((w) => tags.has(w)) ? 1 : tags.size && g.weather.length ? -1 : 0
    return [-[...gTags].filter((t) => activities.has(t)).length, -weatherFit, Number(s.needsIroning), g.total_wears]
  }
  const compare = (a: Sim, b: Sim) => {
    const ka = scoreKey(a)
    const kb = scoreKey(b)
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
    return 0
  }

  const groups: [string, Set<string>, number][] = [
    ['Underwear, socks & vests', DAILY, cycle],
    ['Tops', TOPS, cycle],
    ['Bottoms', BOTTOMS, Math.max(1, Math.ceil(cycle / 3))],
  ]
  if (req.nights) groups.push(['Nightwear', new Set(['nightwear']), Math.max(1, Math.ceil(Math.min(req.nights, cycle) / 3))])
  if (activities.has('gym')) groups.push(['Activewear', new Set(['activewear']), Math.max(1, Math.ceil(days / 2))])
  const formal = ['office', 'interview', 'wedding', 'party'].some((a) => activities.has(a))
  groups.push(['Shoes', new Set(['shoes']), (formal || activities.has('gym')) && days > 1 ? 2 : 1])
  if (['Cold', 'Rainy', 'Windy', 'Mild'].some((t) => tags.has(t)) || (!tags.size && days >= 3)) groups.push(['Layers', LAYERS, 1])
  if (formal) groups.push(['Formal wear', new Set(['suit', 'dress']), 1])

  const owned = new Map<string, number>()
  for (const s of sim.sims.values()) owned.set(s.g.category, (owned.get(s.g.category) ?? 0) + 1)
  const toIron: string[] = []
  const section = (title: string, candidates: Sim[], need: number): PackingSectionOut => {
    const chosen = [...candidates].sort(compare).slice(0, need)
    for (const s of chosen) if (s.needsIroning) toIron.push(s.g.name)
    return {
      title,
      needed: need,
      garments: chosen.map((s) => s.g),
      shortfall: need - chosen.length > 0 ? `Only ${chosen.length} of ${need} will be clean by departure` : null,
    }
  }
  const sections: PackingSectionOut[] = []
  for (const [title, cats, need] of groups) {
    if (![...cats].some((c) => owned.get(c))) continue
    if (cats === DAILY) {
      // Each daily category is packed separately (e.g. 4 socks AND 4 underwear).
      for (const c of [...cats].sort()) {
        if (owned.get(c)) sections.push(section(c.charAt(0).toUpperCase() + c.slice(1), ready.filter((s) => s.g.category === c), need))
      }
      continue
    }
    sections.push(section(title, ready.filter((s) => cats.has(s.g.category)), need))
  }

  const notes: string[] = []
  if (tags.size) notes.push(`Forecast for your trip: ${[...tags].sort().join(', ')}.`)
  else if (weatherError) notes.push(weatherError)
  else if (snap.settings?.latitude == null) notes.push('Set a location to pack for the weather.')
  else notes.push("Trip is beyond the 16-day forecast, so weather isn't considered.")
  if (req.laundry_available && days > cycle) notes.push(`Packed for ${cycle} days, assuming you can do laundry during the trip.`)
  if (toIron.length) notes.push(`Iron before you go: ${toIron.join(', ')}.`)
  return { days, weather: [...tags].sort(), sections, notes }
}

// --- Before you buy -------------------------------------------------------------------------

export interface PurchaseItem {
  name?: string | null
  category: string
  color?: string | null
  pattern?: string | null
  formality?: number | null
  occasions?: string[]
  weather?: string[]
}

export function purchaseAnalysis(snap: Snapshot, item: PurchaseItem): PurchaseResult {
  const pool = snap.garments.filter((g) => !g.archived)
  const [maxWears, iron] = CATEGORY_DEFAULTS[item.category] ?? CATEGORY_DEFAULTS.other
  const now = new Date().toISOString()
  const candidate: GarmentRow = {
    id: '__candidate__', name: item.name || `New ${item.category}`, category: item.category, subcategory: null,
    color: item.color ?? null, pattern: item.pattern ?? null, labels: [], occasions: item.occasions ?? [],
    formality: item.formality ?? null, seasons: [], weather: item.weather ?? [], fabric: null, comfort_notes: null,
    max_wears_before_wash: maxWears, ironing_policy: iron, purchase_date: null, purchase_price: null, notes: null,
    photo_id: null, state: 'ready', iron_after_drying: false, total_wears: 0, wears_since_wash: 0, last_worn_on: null,
    last_washed_at: null, archived: false, archived_reason: null, created_at: now, updated_at: now, rev: 0,
  }
  // Judged against everything owned (not just what's clean today).
  const withIt = rank([...pool, candidate], snap.outfitCtx)
  const fresh = withIt.filter((s) => s.garments.includes(candidate))
  const good = fresh.filter((s) => s.score >= 70)
  const key = colorKey(candidate.color)
  const similar = pool.filter((g) => g.category === candidate.category && key !== null && colorKey(g.color) === key).map((g) => g.name)
  const sameCategory = pool.filter((g) => g.category === candidate.category)

  let verdict: string
  if (!SLOT_OF[candidate.category]) verdict = "This category isn't used in outfit suggestions, so its combinations can't be estimated."
  else if (similar.length >= 2) verdict = `You already own ${similar.length} similar ${candidate.color} ${candidate.category} items. Consider whether you need another.`
  else if (!fresh.length) verdict = "It wouldn't complete any outfit with what you own yet (no matching tops, bottoms or shoes)."
  else if (good.length >= 3) verdict = `Good fit: it creates ${good.length} strong outfits with clothes you already own.`
  else if (good.length) verdict = `It creates ${good.length} strong outfit${good.length > 1 ? 's' : ''} with clothes you already own.`
  else verdict = `It creates ${fresh.length} outfit${fresh.length > 1 ? 's' : ''}, but none look like strong matches.`

  return {
    new_outfits: fresh.length,
    strong_outfits: good.length,
    examples: fresh.slice(0, 3).map((s) => ({ garments: s.garments.filter((g) => g !== candidate).map((g) => g.name), score: s.score })),
    similar_owned: similar,
    category_owned: sameCategory.length,
    verdict,
  }
}

// --- Dashboard warnings -----------------------------------------------------------------------

export interface DashWarning {
  kind: string
  message: string
  basket_id: string | null
  garment_id: string | null
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function dashboardWarnings(
  garments: GarmentRow[],
  baskets: BasketRow[],
  items: BasketItemRow[],
  today: string,
  now: string,
): DashWarning[] {
  const live = garments.filter((g) => !g.archived)
  const laundry = baskets.filter((b) => b.kind !== 'ironing')
  const pending = laundry.filter((b) => b.status === 'pending').sort((a, b) =>
    Number(a.scheduled_for === null) - Number(b.scheduled_for === null) || (a.scheduled_for ?? today).localeCompare(b.scheduled_for ?? today))
  const inProgress = laundry.filter((b) => b.status === 'in_progress')
  const byId = new Map(garments.map((g) => [g.id, g]))
  const out: DashWarning[] = []
  const w = (kind: string, message: string, basket_id: string | null = null, garment_id: string | null = null) =>
    out.push({ kind, message, basket_id, garment_id })

  for (const b of pending) if (b.scheduled_for === today) w('basket_due', `Your ${b.name} basket is due today.`, b.id)
  for (const b of pending) {
    if (b.scheduled_for && b.scheduled_for < today) w('basket_overdue', `${b.name} was scheduled for ${dayLabelPadded(b.scheduled_for)} and hasn't been started.`, b.id)
  }
  for (const b of inProgress) {
    if (b.expected_completion_at && b.expected_completion_at < now) w('basket_overrun', `${b.name} is still marked In Progress.`, b.id)
  }
  for (const b of [...pending, ...inProgress]) {
    for (const i of items) {
      if (i.basket_id === b.id && i.active && i.previous_state === 'reserved') {
        w('reserved_in_basket', `'${byId.get(i.garment_id)?.name}' in ${b.name} is reserved for an upcoming event.`, b.id, i.garment_id)
      }
    }
  }
  const ironing = live.filter((g) => g.state === 'needs_ironing')
  if (ironing.length) w('ironing', `${plural(ironing.length, 'washed garment')} still ${ironing.length === 1 ? 'needs' : 'need'} ironing.`)
  const cats: Record<string, { total: number; wearable: number }> = {}
  for (const g of live) {
    const c = (cats[g.category] ??= { total: 0, wearable: 0 })
    c.total += 1
    c.wearable += isWearable(g) ? 1 : 0
  }
  for (const [cat, c] of Object.entries(cats).sort(([a], [b]) => a.localeCompare(b))) {
    // Only categories where the user owns several items but none are ready.
    if (c.total >= 2 && c.wearable === 0 && (CATEGORY_DEFAULTS[cat] ?? [1])[0] !== null) {
      w('shortage', `No ${cat} ready to wear (you own ${c.total}).`)
    }
  }
  return out
}

// --- Reminders ---------------------------------------------------------------------------------

export const DEFAULT_PREFS = { laundry: true, ironing: true, plan: true, events: true }

export function reminders(snap: Snapshot, today: string, warnings: DashWarning[]): Reminder[] {
  const prefs = { ...DEFAULT_PREFS, ...(snap.settings?.notification_prefs ?? {}) }
  const out: Reminder[] = []
  if (prefs.plan) {
    const cov = coverage(snap, today)
    if (cov.status === 'alert' || cov.status === 'warning') {
      const fix = cov.suggestions.length ? ` Suggested: ${cov.suggestions[0].title}.` : ''
      out.push({ group: 'plan', link: '/plan', message: `Clothes alert: ${cov.headline}${fix}` })
    }
  }
  const groupOf: Record<string, Reminder['group']> = {
    basket_due: 'laundry', basket_overdue: 'laundry', basket_overrun: 'laundry',
    reserved_in_basket: 'laundry', ironing: 'ironing', shortage: 'plan',
  }
  for (const w of warnings) {
    const group = groupOf[w.kind] ?? 'plan'
    if (prefs[group]) out.push({ group, message: w.message, link: w.basket_id ? `/laundry/${w.basket_id}` : group === 'ironing' ? '/laundry' : '/plan' })
  }

  const result = new Planner(snap, today, 2, { today }).run()
  result.days.forEach((day, i) => {
    const when = i === 0 ? 'today' : 'tomorrow'
    for (const slot of day.slots) {
      if (slot.entry && slot.entry.status !== 'planned') continue
      if (prefs.ironing) {
        for (const p of slot.prep) {
          if (p.startsWith('Iron ')) {
            out.push({ group: 'ironing', link: '/plan', message: `${p.split(' before ')[0].slice(5)} for ${when}'s ${slot.slot.title} still needs ironing.` })
          }
        }
      }
      if (prefs.plan && slot.problems.length) {
        out.push({ group: 'plan', link: '/plan', message: `${when.charAt(0).toUpperCase() + when.slice(1)}'s ${slot.slot.title}: ${slot.problems[0]}` })
      }
    }
    if (prefs.events && i === 1) {
      for (const e of day.events) {
        const planned = day.slots.some((s) => s.slot.event?.id === e.id && s.garmentIds.length)
        const needsOutfit = !!(e.garment_ids?.length || e.occasion || e.formality)
        const tail = planned ? ' Your outfit is planned.' : needsOutfit ? ' No outfit is planned yet.' : ''
        out.push({ group: 'events', link: '/calendar', message: `Tomorrow: ${e.title}.${tail}` })
      }
    }
  })
  const seen = new Set<string>()
  return out.filter((r) => (seen.has(r.message) ? false : (seen.add(r.message), true)))
}
