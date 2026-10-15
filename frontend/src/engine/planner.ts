// Laundry-aware planning: a deterministic day-by-day simulation of which garments are
// clean and available. It starts from every garment's real state and accounts for
// baskets coming back (plus drying), assumed laundry days, wear limits, ironing
// (prep notes), reserved event outfits and locked plan entries. It never invents
// availability: unmet requirements are reported as shortages.
import { BASKET_STATES, WEARABLE_STATES } from './lifecycle'
import { type OutfitContext, rank, withRequest } from './outfits'
import type { BasketItemRow, BasketRow, EventRow, GarmentRow, PlanEntryRow, RoutineRow, SettingsRow } from './rows'
import { WEEKDAYS, addDays, dateOf, dayLabel, daysBetween, maxDate, minDate, weekday } from './time'
import type { DayWeather } from './weather'

export const MAX_DAYS = 28

export function catTitle(category: string, n: number): string {
  if (n === 1 || ['trousers', 'jeans', 'shorts', 'socks', 'shoes', 'underwear', 'nightwear', 'accessories', 'activewear'].includes(category)) {
    return category
  }
  return category + (/(s|sh|ch|x)$/.test(category) ? 'es' : 's')
}

export interface Issue {
  kind: string // shortage | conflict | unscheduled | info
  severity: 'error' | 'warning' | 'info'
  message: string
  date: string | null
  slot_key: string | null
  ref?: string // shortages: which routine requirement
  shortfall?: number
}

export const publicIssue = (i: Issue) => ({ kind: i.kind, severity: i.severity, message: i.message, date: i.date, slot_key: i.slot_key })

export interface Slot {
  key: string
  title: string
  source: string // routine | event
  routine?: RoutineRow
  event?: EventRow
}

export interface PlannedSlot {
  slot: Slot
  garmentIds: string[]
  entry: PlanEntryRow | null
  problems: string[]
  prep: string[]
  /** A stored entry that no longer works: re-planning helps. */
  stale: boolean
}

export interface PlanDay {
  date: string
  forecast: DayWeather | null
  reported: string[]
  effectiveWeather: string[]
  events: EventRow[]
  slots: PlannedSlot[]
  issues: Issue[]
}

export interface Sim {
  g: GarmentRow
  availableFrom: string | null // null = not within the simulation (dirty / unavailable)
  dirty: boolean
  wears: number
  needsIroning: boolean
  via: string | null
  reservedState: boolean
  lastUsed: string | null
}

interface Need {
  routine: RoutineRow
  category: string
  required: number
  satisfied: number
  firstShort: string | null
}

function count(need: Need, d: string, wanted: number, got: number): void {
  need.required += wanted
  need.satisfied += got
  if (got < wanted && (need.firstShort === null || d < need.firstShort)) need.firstShort = d
}

export interface PlanResult {
  days: PlanDay[]
  issues: Issue[]
  weatherError: string | null
  location: string | null
  simsAtStart: Map<string, Sim>
}

/** Everything the planner reads, gathered by the caller (nothing here does I/O). */
export interface Snapshot {
  garments: GarmentRow[]
  baskets: BasketRow[]
  basketItems: BasketItemRow[]
  routines: RoutineRow[] // all routines; inactive ones are ignored unless passed via options
  events: EventRow[]
  entries: PlanEntryRow[]
  reports: Map<string, string[]>
  settings: SettingsRow | null
  forecast: Map<string, DayWeather>
  weatherError: string | null
  outfitCtx: OutfitContext
}

export interface PlannerOptions {
  today: string
  regenerate?: Set<string>
  routines?: RoutineRow[]
  washOverrides?: Map<string, string>
}

const cloneSim = (s: Sim): Sim => ({ ...s })

export class Planner {
  readonly today: string
  readonly start: string
  readonly end: string
  readonly regenerate: Set<string>
  readonly drying: number
  readonly laundryWeekdays: number[]
  readonly routines: RoutineRow[]
  readonly events: EventRow[]
  readonly entries = new Map<string, PlanEntryRow>()
  readonly needs = new Map<string, Need>()
  readonly sims: Map<string, Sim>
  simsInitial = new Map<string, Sim>()
  private readonly issues: Issue[] = []
  private readonly fixedChoice = new Map<string, string[]>()
  private readonly reservedFor = new Map<string, string[]>()
  private readonly washOverrides: Map<string, string>

  constructor(
    private readonly snap: Snapshot,
    start: string,
    days: number,
    opts: PlannerOptions,
  ) {
    this.today = opts.today
    this.start = start
    this.end = addDays(start, Math.min(MAX_DAYS, Math.max(1, days)) - 1)
    this.regenerate = opts.regenerate ?? new Set()
    this.washOverrides = opts.washOverrides ?? new Map()
    this.drying = Math.max(0, snap.settings?.drying_days ?? 1)
    this.laundryWeekdays = snap.settings?.laundry_weekdays ?? []
    this.routines = opts.routines ?? snap.routines.filter((r) => r.active)
    const from = minDate(this.today, start)
    this.events = snap.events.filter((e) => e.date >= from && e.date <= this.end)
    for (const e of snap.entries) {
      const inRange = e.date >= start && e.date <= this.end
      // Entries between today and the requested start still consume clothes.
      const before = start > this.today && e.date >= this.today && e.date < start
      if (inRange || before) this.entries.set(`${e.date}|${e.slot_key}`, e)
    }
    this.sims = this.initialState()
    for (const e of this.events) {
      for (const gid of e.garment_ids ?? []) {
        if (!this.reservedFor.has(gid)) this.reservedFor.set(gid, [])
        this.reservedFor.get(gid)!.push(e.date)
      }
    }
  }

  get settingsLocation(): string | null {
    return this.snap.settings?.location_name ?? null
  }

  // --- initial state ---------------------------------------------------------------------

  /** When a laundry basket's clothes are expected back and dry (null = unscheduled). */
  basketReturn(b: BasketRow): string | null {
    let done: string
    if (b.status === 'in_progress') {
      done = b.expected_completion_at ? dateOf(b.expected_completion_at) : this.today
    } else if (b.scheduled_for === null) {
      return null
    } else {
      const wash = maxDate(b.scheduled_for, this.today)
      done = b.expected_completion_at ? maxDate(dateOf(b.expected_completion_at), wash) : wash
    }
    return addDays(maxDate(done, this.today), this.drying)
  }

  private initialState(): Map<string, Sim> {
    const basketById = new Map(this.snap.baskets.map((b) => [b.id, b]))
    const basketOf = new Map<string, BasketRow>()
    for (const i of this.snap.basketItems) if (i.active && basketById.has(i.basket_id)) basketOf.set(i.garment_id, basketById.get(i.basket_id)!)
    const flagged = new Set<string>()
    const sims = new Map<string, Sim>()
    const sim = (g: GarmentRow, availableFrom: string | null, dirty: boolean, wears: number, needsIroning: boolean, extra: Partial<Sim> = {}): Sim => ({
      g, availableFrom, dirty, wears, needsIroning, via: null, reservedState: false, lastUsed: null, ...extra,
    })
    for (const g of this.snap.garments) {
      if (g.archived) continue
      const st = g.state
      const ironPolicy = g.ironing_policy === 'required'
      let s: Sim
      if (st === 'unavailable') continue
      if (WEARABLE_STATES.has(st) || st === 'reserved') {
        s = sim(g, this.today, false, g.wears_since_wash, false, { reservedState: st === 'reserved' })
      } else if (st === 'needs_ironing') {
        s = sim(g, this.today, false, g.wears_since_wash, true)
      } else if (st === 'drying') {
        s = sim(g, addDays(this.today, 1), false, 0, g.iron_after_drying, { via: 'once dry' })
      } else if (st === 'needs_laundry') {
        s = sim(g, null, true, g.wears_since_wash, false)
      } else if (BASKET_STATES.has(st)) {
        let b = basketOf.get(g.id)
        if (b?.kind === 'ironing') b = undefined
        const back = b ? this.basketReturn(b) : null
        if (back === null) {
          s = sim(g, null, true, g.wears_since_wash, false)
          if (b && !flagged.has(b.id)) {
            flagged.add(b.id)
            this.issues.push({
              kind: 'unscheduled', severity: 'warning', date: null, slot_key: null,
              message: `'${b.name}' has no laundry date, so its clothes aren't counted as coming back.`,
            })
          }
        } else {
          s = sim(g, back, false, 0, ironPolicy, { via: `after '${b!.name}'` })
        }
      } else {
        continue
      }
      const wash = this.washOverrides.get(g.id)
      if (wash) {
        s = sim(g, addDays(maxDate(wash, this.today), this.drying), false, 0, ironPolicy, { via: `after washing on ${dayLabel(wash)}` })
      }
      sims.set(g.id, s)
    }
    return sims
  }

  // --- simulation helpers ------------------------------------------------------------------

  private available(s: Sim, d: string): boolean {
    return !s.dirty && s.availableFrom !== null && s.availableFrom <= d
  }

  private whyUnavailable(s: Sim | undefined, name: string, d: string): string {
    if (!s) return `${name} is no longer available`
    if (s.dirty) return `${name} will need washing first`
    if (s.availableFrom && s.availableFrom > d) return `${name} isn't back until ${dayLabel(s.availableFrom)}${s.via ? ` ${s.via}` : ''}`
    return `${name} isn't available`
  }

  private washDay(d: string): void {
    if (!this.laundryWeekdays.includes(weekday(d))) return
    for (const s of this.sims.values()) {
      if (!s.dirty) continue
      s.dirty = false
      s.wears = 0
      s.availableFrom = addDays(d, this.drying)
      s.needsIroning = s.g.ironing_policy === 'required'
      s.via = `after your ${WEEKDAYS[weekday(d)]} laundry`
    }
  }

  private consume(s: Sim, d: string): void {
    s.wears += 1
    s.lastUsed = d
    s.needsIroning = false
    const limit = s.g.max_wears_before_wash
    if (limit !== null && s.wears >= limit) {
      s.dirty = true
      s.availableFrom = null
    }
  }

  private prepFor(s: Sim, d: string): string[] {
    const notes: string[] = []
    if (s.needsIroning) notes.push(`Iron ${s.g.name} before ${dayLabel(d)}`)
    if (s.via && s.availableFrom && s.availableFrom > this.today) notes.push(`${s.g.name} comes back ${s.via} (${dayLabel(s.availableFrom)})`)
    return notes
  }

  /** Don't use a garment reserved for a later event if that would dirty it first. */
  private blockedByReservation(s: Sim, d: string, slot: Slot): boolean {
    const forThisEvent = !!slot.event && (slot.event.garment_ids ?? []).includes(s.g.id)
    if (s.reservedState) return !forThisEvent
    const upcoming = (this.reservedFor.get(s.g.id) ?? []).filter((e) => e > d)
    if (!upcoming.length || forThisEvent) return false
    const limit = s.g.max_wears_before_wash
    return limit !== null && s.wears + 1 >= limit
  }

  private weatherFor(d: string): [DayWeather | null, string[], string[]] {
    const fc = this.snap.forecast.get(d) ?? null
    const reported = this.snap.reports.get(d) ?? []
    return [fc, reported, reported.length ? reported : fc ? fc.tags : []]
  }

  private slotsFor(d: string): [EventRow[], Slot[]] {
    const events = this.events.filter((e) => e.date === d).sort((a, b) => (a.start_time ?? '').localeCompare(b.start_time ?? ''))
    const skipDay = events.some((e) => e.skip_day_routines)
    const slots: Slot[] = events.map((e) => ({ key: `event:${e.id}`, title: e.title, source: 'event', event: e }))
    const routines = this.routines
      .filter((r) =>
        (r.weekdays ?? []).includes(weekday(d)) &&
        (r.start_date === null || r.start_date <= d) &&
        (r.end_date === null || d <= r.end_date) &&
        !(skipDay && r.kind === 'day'))
      // Mandatory day routines first, flexible next, night routines last.
      .sort((a, b) =>
        Number(a.kind === 'night') - Number(b.kind === 'night') ||
        Number(!a.mandatory) - Number(!b.mandatory) ||
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    for (const r of routines) slots.push({ key: `routine:${r.id}`, title: r.name, source: 'routine', routine: r })
    return [events, slots]
  }

  // --- choosing garments -------------------------------------------------------------------

  private pref(s: Sim, r: RoutineRow, weatherTags: string[]): number {
    const g = s.g
    const tags = new Set([...g.labels, ...g.occasions].map((t) => t.toLowerCase()))
    let score = 0
    if (r.occasion && tags.has(r.occasion.toLowerCase())) score += 1
    if (r.formality && g.formality) score += 1 - Math.abs(g.formality - r.formality) / 4
    if (weatherTags.length && g.weather.length) score += g.weather.some((w) => weatherTags.includes(w)) ? 1 : -0.5
    if (s.needsIroning) score -= 0.25
    return score
  }

  private need(r: RoutineRow, idx: number, category: string): Need {
    const key = `${r.id}:${idx}`
    if (!this.needs.has(key)) this.needs.set(key, { routine: r, category, required: 0, satisfied: 0, firstShort: null })
    return this.needs.get(key)!
  }

  private inRange = (d: string) => d >= this.start && d <= this.end

  private pickRoutine(d: string, slot: Slot, used: Set<string>, weatherTags: string[]): PlannedSlot {
    const r = slot.routine!
    const planned: PlannedSlot = { slot, garmentIds: [], entry: null, problems: [], prep: [], stale: false }
    ;(r.requirements ?? []).forEach((req, idx) => {
      const category = req.category ?? ''
      const qty = Math.max(1, Number(req.quantity) || 1)
      const labels = new Set((req.labels ?? []).map((x) => x.toLowerCase()))
      const minFormality = req.min_formality ?? null
      const need = this.need(r, idx, category)
      const eligible = (s: Sim) => {
        const g = s.g
        return (
          g.category === category &&
          !used.has(g.id) &&
          this.available(s, d) &&
          !this.blockedByReservation(s, d, slot) &&
          (!labels.size || [...g.labels, ...g.occasions].some((t) => labels.has(t.toLowerCase()))) &&
          (minFormality === null || g.formality === null || g.formality >= minFormality)
        )
      }
      let candidates = [...this.sims.values()].filter(eligible)
      if (req.no_consecutive) {
        const yesterday = addDays(d, -1)
        const fresh = candidates.filter((s) => s.lastUsed !== yesterday)
        if (fresh.length >= qty || !candidates.length) candidates = fresh
        else planned.problems.push(`Repeats a ${category} from yesterday (not enough alternatives)`)
      }
      const fixedKey = `${r.id}:${idx}`
      const preferred = req.reuse === 'fixed' ? (this.fixedChoice.get(fixedKey) ?? []) : []
      const prefScore = new Map(candidates.map((s) => [s.g.id, -Math.round(this.pref(s, r, weatherTags) * 2) / 2]))
      candidates.sort((a, b) =>
        Number(!preferred.includes(a.g.id)) - Number(!preferred.includes(b.g.id)) ||
        prefScore.get(a.g.id)! - prefScore.get(b.g.id)! ||
        (a.lastUsed ?? '').localeCompare(b.lastUsed ?? '') ||
        a.wears - b.wears)
      const chosen = candidates.slice(0, qty)
      if (req.reuse === 'fixed' && chosen.length) this.fixedChoice.set(fixedKey, chosen.map((s) => s.g.id))
      if (this.inRange(d)) count(need, d, qty, chosen.length)
      if (chosen.length < qty) {
        const missing = qty - chosen.length
        planned.problems.push(`Missing ${missing} ${catTitle(category, missing)}`)
      }
      for (const s of chosen) {
        used.add(s.g.id)
        planned.garmentIds.push(s.g.id)
        planned.prep.push(...this.prepFor(s, d))
        this.consume(s, d)
      }
    })
    return planned
  }

  private pickEvent(d: string, slot: Slot, used: Set<string>, weatherTags: string[]): PlannedSlot | null {
    const e = slot.event!
    if (e.garment_ids?.length) return this.applyFixed(d, slot, [...e.garment_ids], null, used, true)
    if (!(e.occasion || e.formality)) return null // no dress code: nothing to plan
    const pool = [...this.sims.values()]
      .filter((s) => !used.has(s.g.id) && this.available(s, d) && !this.blockedByReservation(s, d, slot))
      .map((s) => s.g)
    const ctx = withRequest(this.snap.outfitCtx, { occasion: e.occasion, formality: e.formality, weather: weatherTags, today: d, count: 5 })
    const ranked = rank(pool, ctx)
    if (!ranked.length) return { slot, garmentIds: [], entry: null, problems: ['No complete outfit is available'], prep: [], stale: false }
    const planned: PlannedSlot = { slot, garmentIds: [], entry: null, problems: [], prep: [], stale: false }
    for (const g of ranked[0].garments) {
      const s = this.sims.get(g.id)!
      used.add(g.id)
      planned.garmentIds.push(g.id)
      planned.prep.push(...this.prepFor(s, d))
      this.consume(s, d)
    }
    return planned
  }

  /** Apply a fixed list of garments (stored entry or reserved outfit), checking each. */
  private applyFixed(d: string, slot: Slot, garmentIds: string[], entry: PlanEntryRow | null, used: Set<string>, reserved = false): PlannedSlot {
    const planned: PlannedSlot = { slot, garmentIds: [...garmentIds], entry, problems: [], prep: [], stale: false }
    if (entry && entry.status !== 'planned') return planned // already worn or skipped
    const applied: string[] = []
    for (const gid of garmentIds) {
      const s = this.sims.get(gid)
      const name = s ? s.g.name : 'A garment'
      if (!s || !this.available(s, d) || used.has(gid)) {
        planned.problems.push(used.has(gid) ? `${name} is already used in another outfit that day` : this.whyUnavailable(s, name, d))
        planned.stale = true
        continue
      }
      used.add(gid)
      applied.push(gid)
      planned.prep.push(...this.prepFor(s, d))
      this.consume(s, d)
    }
    if (planned.problems.length && reserved) planned.problems.unshift('Reserved outfit has a problem')
    if (slot.routine) this.checkCoverage(d, slot.routine, applied, planned)
    return planned
  }

  /** A stored routine entry still has to meet the routine's requirements. */
  private checkCoverage(d: string, r: RoutineRow, garmentIds: string[], planned: PlannedSlot): void {
    const remaining = garmentIds.filter((g) => this.sims.has(g)).map((g) => this.sims.get(g)!.g.category)
    ;(r.requirements ?? []).forEach((req, idx) => {
      const category = req.category ?? ''
      const qty = Math.max(1, Number(req.quantity) || 1)
      let have = 0
      while (have < qty) {
        const i = remaining.indexOf(category)
        if (i < 0) break
        remaining.splice(i, 1)
        have += 1
      }
      const need = this.need(r, idx, category)
      if (this.inRange(d)) count(need, d, qty, have)
      if (have < qty) planned.problems.push(`Missing ${qty - have} ${catTitle(category, qty - have)}`)
    })
  }

  // --- main loop -------------------------------------------------------------------------

  run(): PlanResult {
    const simsAtStart = new Map([...this.sims].map(([k, v]) => [k, cloneSim(v)]))
    this.simsInitial = simsAtStart
    const days: PlanDay[] = []
    for (let d = this.today; d <= this.end; d = addDays(d, 1)) {
      this.washDay(d)
      const [events, slots] = this.slotsFor(d)
      const [fc, reported, effective] = this.weatherFor(d)
      const used = new Set<string>()
      const plannedSlots: PlannedSlot[] = []
      const dayIssues: Issue[] = []
      for (const slot of slots) {
        const entry = this.entries.get(`${d}|${slot.key}`)
        let planned: PlannedSlot | null
        if (entry && !(this.regenerate.has(d) && !entry.locked && entry.status === 'planned')) {
          planned = this.applyFixed(d, slot, entry.garment_ids, entry, used)
        } else if (slot.source === 'event') {
          planned = this.pickEvent(d, slot, used, effective)
        } else {
          planned = this.pickRoutine(d, slot, used, effective)
        }
        if (!planned) continue
        plannedSlots.push(planned)
        const severity = !planned.slot.routine || planned.slot.routine.mandatory ? 'error' : 'warning'
        for (const p of planned.problems) {
          dayIssues.push({ kind: planned.entry ? 'conflict' : 'shortage', severity, message: `${slot.title}: ${p}`, date: d, slot_key: slot.key })
        }
      }
      // Stored entries whose routine/event no longer applies to this date.
      const keys = new Set(slots.map((s) => s.key))
      for (const entry of this.entries.values()) {
        if (entry.date === d && !keys.has(entry.slot_key) && entry.status === 'planned') {
          plannedSlots.push({
            slot: { key: entry.slot_key, title: entry.title, source: entry.slot_key.split(':')[0] },
            garmentIds: entry.garment_ids,
            entry,
            problems: ['No longer needed: its routine or event changed'],
            prep: [],
            stale: true,
          })
          dayIssues.push({ kind: 'conflict', severity: 'warning', message: `${entry.title}: no longer needed`, date: d, slot_key: entry.slot_key })
        }
      }
      if (d >= this.start) days.push({ date: d, forecast: fc, reported, effectiveWeather: effective, events, slots: plannedSlots, issues: dayIssues })
    }

    const summary = [...this.issues]
    const nDays = daysBetween(this.start, this.end) + 1
    for (const [ref, need] of this.needs) {
      if (need.satisfied < need.required) {
        summary.push({
          kind: 'shortage',
          severity: need.routine.mandatory ? 'error' : 'warning',
          message: `${need.routine.name}: ${need.required} clean ${catTitle(need.category, need.required)} needed over these ${nDays} days, but only ${need.satisfied} can be planned.`,
          date: null,
          slot_key: null,
          ref,
          shortfall: need.required - need.satisfied,
        })
      }
    }
    if (summary.some((i) => i.kind === 'shortage') && !this.laundryWeekdays.length) {
      summary.push({
        kind: 'info', severity: 'info', date: null, slot_key: null,
        message: 'Tip: set your usual laundry days in plan settings so the planner can count on clothes coming back.',
      })
    }
    return { days, issues: summary, weatherError: this.snap.weatherError, location: this.settingsLocation, simsAtStart }
  }
}

/** Dates with stored, unlocked entries that no longer work, or new unsaved slots. */
export function affectedDates(result: PlanResult, today: string): string[] {
  const out: string[] = []
  for (const day of result.days) {
    if (day.date < today) continue
    const stored = day.slots.filter((s) => s.entry)
    const broken = stored.some((s) => s.stale && !s.entry!.locked && s.entry!.status === 'planned')
    // Unsaved slots with garments = something new (e.g. an event) since the plan was saved.
    const missing = stored.length > 0 && day.slots.some((s) => !s.entry && s.garmentIds.length)
    if (broken || missing) out.push(day.date)
  }
  return out
}

export function* datesBetween(start: string, end: string): Generator<string> {
  for (let d = start; d <= end; d = addDays(d, 1)) yield d
}
