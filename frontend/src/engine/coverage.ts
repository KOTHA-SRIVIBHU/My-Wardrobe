// "Will my clean clothes last?" A forward check of every routine for a week, or until
// the next laundry is back and dry if that's later (max three weeks). Suggested fixes
// are re-simulated before they're offered.
import type { Coverage, CoverageShortage, CoverageSuggestion, StockLine } from '../lib/types'
import { CATEGORY_DEFAULTS } from './lifecycle'
import { Planner, type Snapshot, catTitle } from './planner'
import { WEEKDAYS, addDays, dayLabel, daysBetween, maxDate, weekday } from './time'

const MIN_DAYS = 7
const MAX_DAYS = 21

export function nextLaundry(probe: Planner, snap: Snapshot, today: string): [string | null, string | null] {
  const options: [string, string][] = []
  for (const b of snap.baskets) {
    if (b.status === 'completed' || b.kind === 'ironing') continue
    if (!snap.basketItems.some((i) => i.basket_id === b.id && i.active)) continue
    const back = probe.basketReturn(b)
    if (back) options.push([back, `'${b.name}' is back`])
  }
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i)
    if (probe.laundryWeekdays.includes(weekday(d))) {
      options.push([addDays(d, probe.drying), `your ${WEEKDAYS[weekday(d)]} laundry is dry`])
      break
    }
  }
  if (!options.length) return [null, null]
  options.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
  return options[0]
}

function shortages(planner: Planner): CoverageShortage[] {
  const out: CoverageShortage[] = []
  for (const need of planner.needs.values()) {
    if (need.satisfied < need.required) {
      out.push({
        routine: need.routine.name,
        category: need.category,
        required: need.required,
        available: need.satisfied,
        missing: need.required - need.satisfied,
        first_short: need.firstShort,
        mandatory: need.routine.mandatory,
      })
    }
  }
  return out.sort((a, b) => (a.first_short ?? '9999').localeCompare(b.first_short ?? '9999') || a.routine.localeCompare(b.routine))
}

/** How many of each item a routine needs to get through one laundry cycle. */
export function recommendedStock(snap: Snapshot, probe: Planner): StockLine[] {
  const days = [...probe.laundryWeekdays].sort((a, b) => a - b)
  let cycle = 7
  if (days.length) cycle = Math.max(...days.map((d, i) => ((days[(i + 1) % days.length] - d + 7) % 7) || 7))
  cycle += probe.drying
  const garments = snap.garments.filter((g) => !g.archived)
  const out: StockLine[] = []
  for (const r of probe.routines) {
    for (const req of r.requirements ?? []) {
      const category = req.category ?? ''
      const qty = Math.max(1, Number(req.quantity) || 1)
      const minF = req.min_formality ?? null
      const owned = garments.filter((g) => g.category === category && (minF === null || g.formality === null || g.formality >= minF))
      const limits = owned.map((g) => g.max_wears_before_wash).filter((l): l is number => !!l)
      const defaultLimit = (CATEGORY_DEFAULTS[category] ?? CATEGORY_DEFAULTS.other)[0]
      let needed: number
      if (req.reuse === 'fixed' || (owned.length && !limits.length) || (!owned.length && defaultLimit === null)) {
        needed = qty // never needs washing by wear count (e.g. shoes)
      } else {
        const limit = limits.length ? limits.reduce((a, b) => a + b, 0) / limits.length : defaultLimit || 1
        const uses = (qty * (r.weekdays ?? []).length * cycle) / 7
        needed = Math.max(qty, Math.ceil(uses / limit))
      }
      out.push({ routine: r.name, category, needed, owned: owned.length, ok: owned.length >= needed, cycle_days: cycle })
    }
  }
  return out
}

export function coverage(snap: Snapshot, today: string): Coverage {
  const probe = new Planner(snap, today, 1, { today })
  const [backOn, why] = nextLaundry(probe, snap, today)
  let days = MIN_DAYS
  let horizon = 'for the next 7 days'
  if (backOn && daysBetween(today, backOn) + 1 > MIN_DAYS) {
    days = Math.min(MAX_DAYS, daysBetween(today, backOn) + 1)
    horizon = `until ${why} (${dayLabel(backOn)})`
  }
  const dates = new Set(Array.from({ length: days }, (_, i) => addDays(today, i)))
  const planner = new Planner(snap, today, days, { today, regenerate: dates })
  planner.run()
  const short = shortages(planner)
  const serious = short.filter((s) => s.mandatory)
  const stock = recommendedStock(snap, probe)

  let status: Coverage['status']
  let headline: string
  if (!planner.routines.length) {
    status = 'none'
    headline = 'Add your routines so I can check whether your clothes will last.'
  } else if (!short.length) {
    status = 'ok'
    headline = `You're covered: your clean clothes meet every routine ${horizon}.`
  } else {
    status = serious.length ? 'alert' : 'warning'
    const first = short.map((s) => s.first_short).filter((d): d is string => !!d).sort()[0]
    const cats = [...new Set(short.map((s) => catTitle(s.category, 2)))]
    headline = `Not enough clean ${cats.join(', ')}: you'll run short from ${dayLabel(first)}.`
  }
  return {
    today,
    until: addDays(today, days - 1),
    days,
    horizon,
    next_laundry: backOn,
    next_laundry_reason: why,
    status,
    headline,
    shortages: short,
    suggestions: short.length ? suggestions(snap, today, days, planner, short, stock) : [],
    stock,
  }
}

function suggestions(snap: Snapshot, today: string, days: number, planner: Planner, short: CoverageShortage[], stock: StockLine[]): CoverageSuggestion[] {
  const out: CoverageSuggestion[] = []
  const shortCats = new Set(short.map((s) => s.category))
  const firstShort = short.map((s) => s.first_short).filter((d): d is string => !!d).sort()[0] ?? today
  const garmentById = new Map(snap.garments.map((g) => [g.id, g]))

  // 1. Unscheduled laundry baskets holding clothes we're short of.
  for (const b of snap.baskets) {
    if (b.status !== 'pending' || b.kind === 'ironing' || b.scheduled_for !== null) continue
    const hits = snap.basketItems.filter((i) => i.basket_id === b.id && i.active && shortCats.has(garmentById.get(i.garment_id)?.category ?? ''))
    if (hits.length) {
      const when = maxDate(today, addDays(firstShort, -(planner.drying + 1)))
      out.push({
        kind: 'schedule',
        title: `Schedule '${b.name}' for ${dayLabel(when)}`,
        detail: `It holds ${hits.length} of the items you're short of, but has no laundry date yet.`,
        basket_id: b.id,
        wash_on: when,
        garment_ids: [],
      })
    }
  }

  // 2. Wash the dirty clothes that are needed, early enough to be dry in time.
  const dirty = [...planner.simsInitial.values()].map((s) => s.g).filter((g) => g.state === 'needs_laundry' && shortCats.has(g.category))
  if (dirty.length) {
    const washOn = maxDate(today, addDays(firstShort, -planner.drying))
    const trial = new Planner(snap, today, days, { today, regenerate: planner.regenerate, washOverrides: new Map(dirty.map((g) => [g.id, washOn])) })
    trial.run()
    const before = short.reduce((a, s) => a + s.missing, 0)
    const after = shortages(trial).reduce((a, s) => a + s.missing, 0)
    const back = addDays(washOn, planner.drying)
    const counts = new Map<string, number>()
    for (const g of dirty) counts.set(g.category, (counts.get(g.category) ?? 0) + 1)
    const what = [...counts].map(([c, n]) => `${n} ${catTitle(c, n)}`).join(', ')
    const late = back > firstShort ? " (that's the earliest possible, so a day or two may still be short)" : ''
    if (after < before) {
      out.push({
        kind: 'wash',
        title: `Wash ${what} on ${dayLabel(washOn)}`,
        detail: `Back by ${dayLabel(back)}${late}. This fixes ${before - after} of ${before} missing item(s).`,
        basket_id: null,
        wash_on: washOn,
        garment_ids: dirty.map((g) => g.id),
      })
    }
  }

  // 3. Not enough owned to get through a laundry cycle at all.
  for (const s of stock) {
    if (!s.ok && shortCats.has(s.category)) {
      out.push({
        kind: 'stock',
        title: `Own more ${catTitle(s.category, 2)}`,
        detail: `${s.routine} uses about ${s.needed} between laundries (${s.cycle_days} days); you have ${s.owned}.`,
        basket_id: null,
        wash_on: null,
        garment_ids: [],
      })
    }
  }
  return out
}
