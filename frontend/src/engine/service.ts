// The app's data service: everything the pages ask for. It keeps an in-memory copy of
// the user's data, applies the business rules locally, and saves each change to the
// database atomically. Results have the same shapes the old HTTP API returned.
import type {
  AiStatus, Analytics, Basket, BasketItem, BasketMutation, BasketStatus, Brief, CalendarEvent, CalendarEventInput,
  Classification, Coverage, Dashboard, Explanation, Feasibility, Garment, GarmentEvent, GarmentFields, GarmentState,
  Meta, Outfit, OutfitRequest as OutfitRequestIn, Pair, Plan, PlanDay as PlanDayOut, PlanSlot, PurchaseResult,
  Reminder, Routine, RoutineDraft, RoutineInput, Settings, Simulation, WashResult, WeatherDay,
} from '../lib/types'
import * as ai from './ai'
import type { Backend } from './backend'
import { coverage as computeCoverage } from './coverage'
import { ApiError, LifecycleError, invalid, notFound } from './errors'
import { analytics as computeAnalytics, dashboardWarnings, packingList, purchaseAnalysis, reminders } from './insights'
import * as lc from './lifecycle'
import { generate as generateOutfits, loadContext } from './outfits'
import { MAX_DAYS, Planner, type PlanResult, type Snapshot, affectedDates, publicIssue } from './planner'
import type { BasketRow, EventRow, GarmentRow, PairRow, PlanEntryRow, RoutineRow, SettingsRow, TableName, Tables } from './rows'
import { Store, Tx, type Op, applyOps, newId } from './store'
import { addDays, clock, dayLabelPadded, localToday, maxDate } from './time'
import * as v from './validate'
import { geocode as geocodeCity, safeForecast } from './weather'

type Reader = { all<T extends TableName>(table: T): Tables[T][] }
type Listener = () => void

export type GarmentInput = Partial<GarmentFields> & { name: string; category: string; use_category_defaults?: boolean; state?: GarmentState }

export interface GarmentFilters {
  state?: GarmentState | ''
  category?: string
  label?: string
  q?: string
  wearable?: boolean
  include_archived?: boolean
}

const BACKUP_FORMAT = 'closetiq-app-backup'
const BACKUP_VERSION = 1

export class WardrobeService {
  readonly store = new Store()
  private queue: Promise<unknown> = Promise.resolve()
  private listeners = new Set<Listener>()
  private photoCache = new Map<string, string>()
  private photoWaiters = new Map<string, ((url: string | null) => void)[]>()
  private photoTimer: ReturnType<typeof setTimeout> | null = null
  /** Overridable "today" (tests); the app uses the device's local date. */
  todayFn: () => string = localToday

  constructor(private backend: Backend) {}

  // --- plumbing -----------------------------------------------------------------------------

  async reload(): Promise<void> {
    const data = await this.backend.loadAll()
    for (const [table, rows] of Object.entries(data)) this.store.load(table as TableName, rows as never[])
    this.emit()
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  private today(given?: string | null): string {
    return given || this.todayFn()
  }

  /** Wait for pending saves so reads see a consistent copy. */
  private async idle(): Promise<void> {
    await this.queue.catch(() => undefined)
  }

  /** Run `fn` as one unit: its changes are saved atomically, or not at all. */
  private mutate<T>(fn: (tx: Tx) => T | Promise<T>): Promise<T> {
    const run = async () => {
      const tx = new Tx(this.store)
      const result = await fn(tx)
      const ops = tx.ops()
      if (ops.length) {
        try {
          await this.backend.apply(ops)
        } catch (e) {
          if (e instanceof ApiError && (e.code === 'stale' || e.code === 'integrity')) await this.reload().catch(() => undefined)
          throw e
        }
        applyOps(this.store, ops)
        this.emit()
      }
      return result
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p
  }

  private settingsRow(r: Reader = this.store): SettingsRow | null {
    return r.all('settings')[0] ?? null
  }

  private async snapshot(today: string, r: Reader = this.store): Promise<Snapshot> {
    const settings = this.settingsRow(r)
    const [forecast, weatherError] = await safeForecast(settings?.latitude ?? null, settings?.longitude ?? null)
    return this.snapshotWith(today, r, forecast, weatherError)
  }

  private snapshotWith(today: string, r: Reader, forecast: Snapshot['forecast'], weatherError: string | null): Snapshot {
    const reports = new Map(r.all('weather_reports').map((w) => [w.date, w.tags]))
    return {
      garments: r.all('garments'),
      baskets: r.all('laundry_baskets'),
      basketItems: r.all('basket_items'),
      routines: r.all('routines'),
      events: r.all('events'),
      entries: r.all('plan_entries'),
      reports,
      settings: this.settingsRow(r),
      forecast,
      weatherError,
      outfitCtx: loadContext({ occasion: null, formality: null, weather: [], count: 5, today }, r.all('outfit_feedback'), r.all('garment_events')),
    }
  }

  private garmentOrThrow(tx: Tx, id: string): GarmentRow {
    const g = tx.get('garments', id)
    if (!g) throw notFound('Garment')
    return g
  }

  private ownedGarments(tx: Tx, idList: string[]): GarmentRow[] {
    const unique = [...new Set(idList)]
    const out = unique.map((id) => tx.get('garments', id))
    const missing = unique.find((_, i) => !out[i])
    if (missing) throw new ApiError(404, `Garment not found: ${missing}`, 'not_found')
    return out as GarmentRow[]
  }

  // --- serialization ----------------------------------------------------------------------------

  garmentsOut(rows: GarmentRow[], r: Reader = this.store): Garment[] {
    const baskets = new Map(r.all('laundry_baskets').map((b) => [b.id, b]))
    const active = new Map<string, BasketRow>()
    for (const i of r.all('basket_items')) if (i.active && baskets.has(i.basket_id)) active.set(i.garment_id, baskets.get(i.basket_id)!)
    return rows.map((g) => {
      const b = active.get(g.id)
      return {
        id: g.id, name: g.name, category: g.category, subcategory: g.subcategory, color: g.color, pattern: g.pattern,
        labels: [...g.labels], occasions: [...g.occasions], formality: g.formality, seasons: [...g.seasons],
        weather: [...g.weather], fabric: g.fabric, comfort_notes: g.comfort_notes,
        max_wears_before_wash: g.max_wears_before_wash, ironing_policy: g.ironing_policy, purchase_date: g.purchase_date,
        purchase_price: g.purchase_price === null ? null : Number(g.purchase_price).toFixed(2), notes: g.notes,
        image_url: g.photo_id ? (this.photoCache.get(g.photo_id) ?? null) : null, photo_id: g.photo_id,
        state: g.state, iron_after_drying: g.iron_after_drying, total_wears: g.total_wears,
        wears_since_wash: g.wears_since_wash, last_worn_on: g.last_worn_on, last_washed_at: g.last_washed_at,
        archived: g.archived, archived_reason: g.archived_reason, created_at: g.created_at, updated_at: g.updated_at,
        wearable: lc.isWearable(g),
        active_basket: b ? { id: b.id, name: b.name, status: b.status, kind: b.kind ?? 'laundry' } : null,
      }
    })
  }

  private garmentOut(id: string): Garment {
    const g = this.store.get('garments', id)
    if (!g) throw notFound('Garment')
    return this.garmentsOut([g])[0]
  }

  private basketsOut(rows: BasketRow[], withItems = false): Basket[] {
    const allItems = this.store.all('basket_items')
    const garments = new Map(this.garmentsOut(this.store.all('garments')).map((g) => [g.id, g]))
    return rows.map((b) => {
      const items = allItems.filter((i) => i.basket_id === b.id).sort((a, c) => a.added_at.localeCompare(c.added_at))
      const count = b.completed_at ? items.filter((i) => i.outcome && i.outcome !== 'removed').length : items.filter((i) => i.active).length
      return {
        id: b.id, kind: b.kind ?? 'laundry', name: b.name, description: b.description, scheduled_for: b.scheduled_for,
        expected_completion_at: b.expected_completion_at, notes: b.notes, status: b.status, created_at: b.created_at,
        started_at: b.started_at, completed_at: b.completed_at, garment_count: count,
        items: withItems
          ? items.filter((i) => garments.has(i.garment_id)).map((i): BasketItem => ({
              id: i.id, garment: garments.get(i.garment_id)!, added_at: i.added_at, previous_state: i.previous_state,
              active: i.active, outcome: i.outcome, resolved_at: i.resolved_at,
            }))
          : [],
      }
    })
  }

  private basketOut(id: string): Basket {
    const b = this.store.get('laundry_baskets', id)
    if (!b) throw notFound('Basket')
    return this.basketsOut([b], true)[0]
  }

  private pairsOut(rows: PairRow[]): Pair[] {
    const items = this.store.all('pair_items')
    const garmentRows = new Map(this.store.all('garments').map((g) => [g.id, g]))
    const garments = new Map(this.garmentsOut([...garmentRows.values()]).map((g) => [g.id, g]))
    return rows.map((p) => {
      const mine = items.filter((i) => i.pair_id === p.id && garmentRows.has(i.garment_id)).sort((a, b) => a.position - b.position)
      const blockers = mine
        .map((i) => ({ g: garmentRows.get(i.garment_id)!, reason: lc.blockerReason(garmentRows.get(i.garment_id)!) }))
        .filter((x) => x.reason)
        .map((x) => ({ garment_id: x.g.id, garment_name: x.g.name, reason: x.reason! }))
      return {
        id: p.id, name: p.name, description: p.description, labels: [...p.labels], occasion: p.occasion, favorite: p.favorite,
        notes: p.notes, created_at: p.created_at, updated_at: p.updated_at,
        garments: mine.map((i) => garments.get(i.garment_id)!), wearable: mine.length > 0 && !blockers.length, blockers,
      }
    })
  }

  private eventOut(e: EventRow): CalendarEvent {
    return {
      id: e.id, title: e.title, kind: e.kind as CalendarEvent['kind'], date: e.date, start_time: e.start_time,
      end_time: e.end_time, occasion: e.occasion, formality: e.formality, labels: [...e.labels], notes: e.notes,
      skip_day_routines: e.skip_day_routines, garment_ids: [...e.garment_ids],
    }
  }

  private routineOut(r: RoutineRow): Routine {
    return { ...r, weekdays: [...r.weekdays], requirements: r.requirements.map((q) => ({ ...q, labels: [...(q.labels ?? [])] })) }
  }

  // --- reference data ----------------------------------------------------------------------------

  async meta(): Promise<Meta> {
    const { OCCASIONS, PATTERNS, SEASONS, SUGGESTED_LABELS, WEATHER } = await import('./vocab')
    return {
      states: v.GARMENT_STATES.map((s) => ({ value: s, label: lc.label(s) })),
      wearable_states: [...lc.WEARABLE_STATES],
      ironing_policies: v.IRONING_POLICIES,
      categories: Object.entries(lc.CATEGORY_DEFAULTS).map(([value, [w, i]]) => ({ value, max_wears_before_wash: w, ironing_policy: i })),
      suggested_labels: SUGGESTED_LABELS, occasions: OCCASIONS, seasons: SEASONS, weather: WEATHER, patterns: PATTERNS,
    }
  }

  async labels(): Promise<string[]> {
    await this.idle()
    const found = new Map<string, string>()
    for (const g of this.store.all('garments')) for (const t of g.labels) if (!found.has(t.toLowerCase())) found.set(t.toLowerCase(), t)
    return [...found.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
  }

  // --- garments --------------------------------------------------------------------------------

  async garments(f: GarmentFilters = {}): Promise<Garment[]> {
    await this.idle()
    let rows = this.store.all('garments').filter((g) => f.include_archived || !g.archived)
    if (f.state) rows = rows.filter((g) => g.state === f.state)
    if (f.category) rows = rows.filter((g) => g.category === f.category!.toLowerCase())
    if (f.label) rows = rows.filter((g) => g.labels.some((t) => t.toLowerCase() === f.label!.toLowerCase()))
    if (f.q) {
      const needle = f.q.toLowerCase()
      rows = rows.filter((g) => [g.name, g.category, g.subcategory, g.color, g.pattern, ...g.labels].filter(Boolean).join(' ').toLowerCase().includes(needle))
    }
    if (f.wearable !== undefined) rows = rows.filter((g) => lc.isWearable(g) === f.wearable)
    rows.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    return this.garmentsOut(rows)
  }

  async garment(id: string): Promise<Garment> {
    await this.idle()
    return this.garmentOut(id)
  }

  async createGarment(body: GarmentInput): Promise<Garment> {
    const category = v.required(body.category, 'Category', 40).toLowerCase()
    const [defWears, defIron] = lc.CATEGORY_DEFAULTS[category] ?? lc.CATEGORY_DEFAULTS.other
    const useDefaults = body.use_category_defaults !== false
    const state = body.state ?? 'ready'
    if (lc.BASKET_STATES.has(state)) throw invalid("New garments can't start in a laundry basket")
    const now = clock()
    const row: GarmentRow = {
      id: newId(),
      name: v.required(body.name, 'Name', 120),
      category,
      subcategory: v.str(body.subcategory, 'Subcategory', { max: 60 }),
      color: v.str(body.color, 'Colour', { max: 40 }),
      pattern: v.str(body.pattern, 'Pattern', { max: 40 }),
      labels: v.tags(body.labels ?? []),
      occasions: v.tags(body.occasions ?? []),
      formality: v.int(body.formality, 'Formality', 1, 5),
      seasons: v.tags(body.seasons ?? []),
      weather: v.tags(body.weather ?? []),
      fabric: v.str(body.fabric, 'Fabric', { max: 60 }),
      comfort_notes: v.str(body.comfort_notes, 'Comfort notes', { max: 2000 }),
      max_wears_before_wash: 'max_wears_before_wash' in body ? v.int(body.max_wears_before_wash, 'Wash after', 1, 100) : useDefaults ? defWears : 1,
      ironing_policy: body.ironing_policy ? v.oneOf(body.ironing_policy, v.IRONING_POLICIES, 'Ironing') : useDefaults ? defIron : 'not_required',
      purchase_date: v.dateStr(body.purchase_date, 'Purchase date'),
      purchase_price: v.price(body.purchase_price),
      notes: v.str(body.notes, 'Notes', { max: 4000 }),
      photo_id: null,
      state: v.oneOf(state, v.GARMENT_STATES, 'State'),
      iron_after_drying: false,
      total_wears: 0,
      wears_since_wash: 0,
      last_worn_on: null,
      last_washed_at: null,
      archived: false,
      archived_reason: null,
      created_at: now,
      updated_at: now,
      rev: 0,
    }
    await this.mutate((tx) => {
      tx.insert('garments', row)
      lc.recordCreated(tx, row)
    })
    return this.garmentOut(row.id)
  }

  async updateGarment(id: string, body: Partial<GarmentFields>): Promise<Garment> {
    await this.mutate((tx) => {
      const g = this.garmentOrThrow(tx, id)
      const b = body as Record<string, unknown>
      const has = (k: string) => k in b
      if (has('name')) g.name = v.required(b.name, 'Name', 120)
      if (has('category')) g.category = v.required(b.category, 'Category', 40).toLowerCase()
      if (has('subcategory')) g.subcategory = v.str(b.subcategory, 'Subcategory', { max: 60 })
      if (has('color')) g.color = v.str(b.color, 'Colour', { max: 40 })
      if (has('pattern')) g.pattern = v.str(b.pattern, 'Pattern', { max: 40 })
      for (const k of ['labels', 'occasions', 'seasons', 'weather'] as const) {
        if (has(k)) {
          if (b[k] === null) throw invalid(`${k} can't be empty`)
          g[k] = v.tags(b[k])
        }
      }
      if (has('formality')) g.formality = v.int(b.formality, 'Formality', 1, 5)
      if (has('fabric')) g.fabric = v.str(b.fabric, 'Fabric', { max: 60 })
      if (has('comfort_notes')) g.comfort_notes = v.str(b.comfort_notes, 'Comfort notes', { max: 2000 })
      if (has('max_wears_before_wash')) g.max_wears_before_wash = v.int(b.max_wears_before_wash, 'Wash after', 1, 100)
      if (has('ironing_policy')) {
        if (b.ironing_policy === null) throw invalid("ironing_policy can't be empty")
        g.ironing_policy = v.oneOf(b.ironing_policy, v.IRONING_POLICIES, 'Ironing')
      }
      if (has('purchase_date')) g.purchase_date = v.dateStr(b.purchase_date, 'Purchase date')
      if (has('purchase_price')) g.purchase_price = v.price(b.purchase_price)
      if (has('notes')) g.notes = v.str(b.notes, 'Notes', { max: 4000 })
      g.updated_at = clock()
      if (has('max_wears_before_wash')) lc.applyWearLimit(tx, g)
    })
    return this.garmentOut(id)
  }

  async deleteGarment(id: string): Promise<void> {
    await this.mutate((tx) => {
      const g = this.garmentOrThrow(tx, id)
      lc.prepareDelete(tx, g)
      tx.delete('garments', id)
    })
  }

  /** Store a photo (base64 of a downscaled JPEG/PNG/WebP). */
  async savePhoto(garmentId: string, mime: string, base64: string): Promise<Garment> {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new ApiError(415, 'Photos must be JPEG, PNG or WebP', 'type')
    if (base64.length > 1_500_000) throw new ApiError(413, 'Photo is too large', 'size')
    const photoId = newId()
    await this.mutate((tx) => {
      const g = this.garmentOrThrow(tx, garmentId)
      if (g.photo_id) tx.delete('photos', g.photo_id)
      tx.insert('photos', { id: photoId, garment_id: g.id, mime, data: base64, created_at: clock() })
      g.photo_id = photoId
      g.updated_at = clock()
    })
    this.photoCache.set(photoId, `data:${mime};base64,${base64}`)
    // The local copy keeps photo metadata only; the image itself lives in the cache.
    const meta = this.store.get('photos', photoId)
    if (meta) this.store.tables.photos.set(photoId, Object.freeze({ ...meta, data: undefined }))
    return this.garmentOut(garmentId)
  }

  async deleteImage(garmentId: string): Promise<Garment> {
    await this.mutate((tx) => {
      const g = this.garmentOrThrow(tx, garmentId)
      if (g.photo_id) tx.delete('photos', g.photo_id)
      g.photo_id = null
    })
    return this.garmentOut(garmentId)
  }

  /** A displayable URL for a photo, fetched in small batches and cached. */
  photoUrl(photoId: string): Promise<string | null> {
    const hit = this.photoCache.get(photoId)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve) => {
      const waiting = this.photoWaiters.get(photoId)
      if (waiting) waiting.push(resolve)
      else this.photoWaiters.set(photoId, [resolve])
      if (!this.photoTimer) this.photoTimer = setTimeout(() => void this.flushPhotos(), 30)
    })
  }

  cachedPhoto(photoId: string | null): string | null {
    return photoId ? (this.photoCache.get(photoId) ?? null) : null
  }

  private async flushPhotos(): Promise<void> {
    this.photoTimer = null
    const waiters = this.photoWaiters
    this.photoWaiters = new Map()
    const idList = [...waiters.keys()]
    try {
      const found = await this.backend.loadPhotos(idList)
      for (const [id, p] of found) this.photoCache.set(id, `data:${p.mime};base64,${p.data}`)
    } catch {
      /* photos are optional: show placeholders */
    }
    for (const [id, fns] of waiters) for (const fn of fns) fn(this.photoCache.get(id) ?? null)
  }

  async history(id: string): Promise<GarmentEvent[]> {
    await this.idle()
    if (!this.store.get('garments', id)) throw notFound('Garment')
    return this.store.all('garment_events').filter((e) => e.garment_id === id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 100)
      .map((e) => ({ ...e }))
  }

  async setState(id: string, state: GarmentState, note?: string): Promise<Garment> {
    const next = v.oneOf(state, v.GARMENT_STATES, 'State')
    await this.mutate((tx) => lc.overrideState(tx, this.garmentOrThrow(tx, id), next, v.str(note, 'Note', { max: 500 })))
    return this.garmentOut(id)
  }

  async archive(id: string, reason = 'archived'): Promise<Garment> {
    const r = v.oneOf(reason, ['archived', 'no_longer_owned', 'damaged', 'donated', 'sold'] as const, 'Reason')
    await this.mutate((tx) => lc.archive(tx, this.garmentOrThrow(tx, id), r))
    return this.garmentOut(id)
  }

  async unarchive(id: string): Promise<Garment> {
    await this.mutate((tx) => lc.unarchive(tx, this.garmentOrThrow(tx, id)))
    return this.garmentOut(id)
  }

  private async bulk(idList: string[], fn: (tx: Tx, g: GarmentRow) => void): Promise<Garment[]> {
    const list = v.ids(idList, 'Garments', { min: 1, max: 200 })
    await this.mutate((tx) => {
      for (const g of this.ownedGarments(tx, list)) fn(tx, g)
    })
    return this.garmentsOut(list.map((id) => this.store.get('garments', id)!))
  }

  wear(ids: string[], wornOn?: string): Promise<Garment[]> {
    const day = v.dateStr(wornOn, 'Date') ?? this.today()
    return this.bulk(ids, (tx, g) => lc.markWorn(tx, g, day))
  }

  wash(ids: string[], dry: boolean, needsIroning?: boolean | null): Promise<Garment[]> {
    return this.bulk(ids, (tx, g) => lc.manualWash(tx, g, dry !== false, needsIroning ?? null))
  }

  dried(ids: string[]): Promise<Garment[]> {
    return this.bulk(ids, (tx, g) => lc.finishDrying(tx, g))
  }

  needsIroning(ids: string[]): Promise<Garment[]> {
    return this.bulk(ids, (tx, g) => lc.markNeedsIroning(tx, g))
  }

  ironed(ids: string[]): Promise<Garment[]> {
    return this.bulk(ids, (tx, g) => lc.markIroned(tx, g))
  }

  // --- pairs -------------------------------------------------------------------------------------

  async pairs(): Promise<Pair[]> {
    await this.idle()
    const rows = this.store.all('pairs').sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name))
    return this.pairsOut(rows)
  }

  private setPairGarments(tx: Tx, pairId: string, garmentIds: string[]): void {
    const garments = this.ownedGarments(tx, v.ids(garmentIds, 'Garments', { min: 1, max: 20 }))
    for (const i of tx.filter('pair_items', (x) => x.pair_id === pairId)) tx.delete('pair_items', i.id)
    garments.forEach((g, position) => tx.insert('pair_items', { id: newId(), pair_id: pairId, garment_id: g.id, position }))
  }

  async createPair(body: Partial<Pair> & { name: string; garment_ids: string[] }): Promise<Pair> {
    const now = clock()
    const row: PairRow = {
      id: newId(), name: v.required(body.name, 'Name', 120), description: v.str(body.description, 'Description', { max: 2000 }),
      labels: v.tags(body.labels ?? []), occasion: v.str(body.occasion, 'Occasion', { max: 60 }), favorite: !!body.favorite,
      notes: v.str(body.notes, 'Notes', { max: 2000 }), created_at: now, updated_at: now, rev: 0,
    }
    await this.mutate((tx) => {
      tx.insert('pairs', row)
      this.setPairGarments(tx, row.id, body.garment_ids)
    })
    return this.pairsOut([this.store.get('pairs', row.id)!])[0]
  }

  async updatePair(id: string, body: Partial<Pair> & { garment_ids?: string[] }): Promise<Pair> {
    await this.mutate((tx) => {
      const p = tx.get('pairs', id)
      if (!p) throw notFound('Pair')
      if (body.name !== undefined && body.name !== null) p.name = v.required(body.name, 'Name', 120)
      if ('description' in body) p.description = v.str(body.description, 'Description', { max: 2000 })
      if (body.labels !== undefined && body.labels !== null) p.labels = v.tags(body.labels)
      if ('occasion' in body) p.occasion = v.str(body.occasion, 'Occasion', { max: 60 })
      if (body.favorite !== undefined && body.favorite !== null) p.favorite = !!body.favorite
      if ('notes' in body) p.notes = v.str(body.notes, 'Notes', { max: 2000 })
      p.updated_at = clock()
      if (body.garment_ids) this.setPairGarments(tx, id, body.garment_ids)
    })
    return this.pairsOut([this.store.get('pairs', id)!])[0]
  }

  async deletePair(id: string): Promise<void> {
    await this.mutate((tx) => {
      if (!tx.get('pairs', id)) throw notFound('Pair')
      tx.delete('pairs', id) // its items go with it (cascade)
    })
  }

  async duplicatePair(id: string): Promise<Pair> {
    const newPairId = newId()
    await this.mutate((tx) => {
      const src = tx.get('pairs', id)
      if (!src) throw notFound('Pair')
      const now = clock()
      tx.insert('pairs', { ...src, id: newPairId, name: `${src.name} (copy)`.slice(0, 120), labels: [...src.labels], favorite: false, created_at: now, updated_at: now, rev: 0 })
      for (const i of tx.filter('pair_items', (x) => x.pair_id === id)) tx.insert('pair_items', { ...i, id: newId(), pair_id: newPairId })
    })
    return this.pairsOut([this.store.get('pairs', newPairId)!])[0]
  }

  async wearPair(id: string, wornOn?: string): Promise<Garment[]> {
    const day = v.dateStr(wornOn, 'Date') ?? this.today()
    let garmentIds: string[] = []
    await this.mutate((tx) => {
      if (!tx.get('pairs', id)) throw notFound('Pair')
      garmentIds = tx.filter('pair_items', (i) => i.pair_id === id).sort((a, b) => a.position - b.position).map((i) => i.garment_id)
      for (const gid of garmentIds) lc.markWorn(tx, tx.get('garments', gid)!, day, id)
    })
    return this.garmentsOut(garmentIds.map((g) => this.store.get('garments', g)!))
  }

  // --- baskets -----------------------------------------------------------------------------------

  async baskets(status?: BasketStatus | string, sort: string = 'scheduled'): Promise<Basket[]> {
    await this.idle()
    let rows = this.store.all('laundry_baskets')
    if (status) rows = rows.filter((b) => b.status === status)
    if (sort === 'name') rows.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    else if (sort === 'created') rows.sort((a, b) => b.created_at.localeCompare(a.created_at))
    else rows.sort((a, b) => Number(a.scheduled_for === null) - Number(b.scheduled_for === null) || (a.scheduled_for ?? a.created_at.slice(0, 10)).localeCompare(b.scheduled_for ?? b.created_at.slice(0, 10)))
    rows.sort((a, b) => Number(!(a.kind === 'ironing' && a.status !== 'completed')) - Number(!(b.kind === 'ironing' && b.status !== 'completed')))
    return this.basketsOut(rows)
  }

  async basket(id: string): Promise<Basket> {
    await this.idle()
    return this.basketOut(id)
  }

  async createBasket(body: Partial<Basket> & { name: string; garment_ids?: string[] }): Promise<BasketMutation> {
    const row: BasketRow = {
      id: newId(), name: v.required(body.name, 'Name', 120), kind: 'laundry', description: v.str(body.description, 'Description', { max: 2000 }),
      scheduled_for: v.dateStr(body.scheduled_for, 'Scheduled for'), expected_completion_at: v.timestamp(body.expected_completion_at, 'Expected done by'),
      status: 'pending', notes: v.str(body.notes, 'Notes', { max: 2000 }), created_at: clock(), started_at: null, completed_at: null, rev: 0,
    }
    const garmentIds = v.ids(body.garment_ids ?? [], 'Garments', { max: 200 })
    const warnings = await this.mutate((tx) => {
      const b = tx.insert('laundry_baskets', row)
      const w: string[] = []
      for (const g of this.ownedGarments(tx, garmentIds)) w.push(...lc.addToBasket(tx, b, g))
      return w
    })
    return { basket: this.basketOut(row.id), warnings }
  }

  async updateBasket(id: string, body: Partial<Basket>): Promise<Basket> {
    await this.mutate((tx) => {
      const b = tx.get('laundry_baskets', id)
      if (!b) throw notFound('Basket')
      if (body.name) b.name = v.required(body.name, 'Name', 120)
      if ('description' in body) b.description = v.str(body.description, 'Description', { max: 2000 })
      if ('scheduled_for' in body) b.scheduled_for = v.dateStr(body.scheduled_for, 'Scheduled for')
      if ('expected_completion_at' in body) b.expected_completion_at = v.timestamp(body.expected_completion_at, 'Expected done by')
      if ('notes' in body) b.notes = v.str(body.notes, 'Notes', { max: 2000 })
    })
    return this.basketOut(id)
  }

  async deleteBasket(id: string): Promise<void> {
    await this.mutate((tx) => {
      const b = tx.get('laundry_baskets', id)
      if (!b) throw notFound('Basket')
      lc.releasePendingBasket(tx, b)
      tx.delete('laundry_baskets', id)
    })
  }

  async addToBasket(id: string, garmentIds: string[]): Promise<BasketMutation> {
    const list = v.ids(garmentIds, 'Garments', { min: 1, max: 200 })
    const warnings = await this.mutate((tx) => {
      const b = tx.get('laundry_baskets', id)
      if (!b) throw notFound('Basket')
      const w: string[] = []
      for (const g of this.ownedGarments(tx, list)) w.push(...lc.addToBasket(tx, b, g))
      return w
    })
    return { basket: this.basketOut(id), warnings }
  }

  async removeFromBasket(id: string, garmentId: string, confirm = false, restoreTo?: GarmentState): Promise<Basket> {
    await this.mutate((tx) => {
      const b = tx.get('laundry_baskets', id)
      if (!b) throw notFound('Basket')
      lc.removeFromBasket(tx, b, garmentId, { confirm, restoreTo: restoreTo ? v.oneOf(restoreTo, v.GARMENT_STATES, 'State') : null })
    })
    return this.basketOut(id)
  }

  async startBasket(id: string): Promise<Basket> {
    await this.mutate((tx) => {
      const b = tx.get('laundry_baskets', id)
      if (!b) throw notFound('Basket')
      lc.startBasket(tx, b)
    })
    return this.basketOut(id)
  }

  async completeBasket(
    id: string,
    defaultResult: 'dry' | 'drying' = 'dry',
    outcomes: { garment_id: string; result: WashResult; needs_ironing?: boolean | null }[] = [],
  ): Promise<Basket> {
    await this.mutate((tx) => {
      const b = tx.get('laundry_baskets', id)
      if (!b) throw notFound('Basket')
      lc.completeBasket(tx, b, defaultResult, new Map(outcomes.map((o) => [o.garment_id, [o.result, o.needs_ironing ?? null]])))
    })
    return this.basketOut(id)
  }

  // --- dashboard ---------------------------------------------------------------------------------

  async dashboard(today?: string): Promise<Dashboard> {
    await this.idle()
    const day = this.today(today)
    const now = new Date().toISOString()
    const garments = this.store.all('garments').filter((g) => !g.archived)
    const all = this.store.all('laundry_baskets')
    const baskets = all.filter((b) => b.kind !== 'ironing')
    const ironing = all.find((b) => b.kind === 'ironing' && b.status !== 'completed') ?? null
    const counts = Object.fromEntries(v.GARMENT_STATES.map((s) => [s, 0])) as Record<GarmentState, number>
    const categories: Record<string, { total: number; wearable: number }> = {}
    for (const g of garments) {
      counts[g.state] += 1
      const c = (categories[g.category] ??= { total: 0, wearable: 0 })
      c.total += 1
      c.wearable += lc.isWearable(g) ? 1 : 0
    }
    const pending = baskets.filter((b) => b.status === 'pending').sort((a, b) =>
      Number(a.scheduled_for === null) - Number(b.scheduled_for === null) || (a.scheduled_for ?? day).localeCompare(b.scheduled_for ?? day))
    const cutoff = new Date(Date.now() - 14 * 86_400_000).toISOString()
    const completed = baskets.filter((b) => b.status === 'completed' && (b.completed_at ?? '') >= cutoff).sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
    const byState = (s: GarmentState) => this.garmentsOut(garments.filter((g) => g.state === s))
    return {
      today: day,
      garments_total: garments.length,
      garments_wearable: garments.filter(lc.isWearable).length,
      state_counts: counts,
      category_counts: Object.fromEntries(Object.entries(categories).sort(([a], [b]) => a.localeCompare(b))),
      baskets_pending: this.basketsOut(pending),
      baskets_due_today: this.basketsOut(pending.filter((b) => b.scheduled_for === day)),
      baskets_in_progress: this.basketsOut(baskets.filter((b) => b.status === 'in_progress')),
      baskets_recently_completed: this.basketsOut(completed.slice(0, 10)),
      ironing_basket: ironing ? this.basketsOut([ironing])[0] : null,
      drying: byState('drying'),
      needs_ironing: byState('needs_ironing'),
      needs_laundry: byState('needs_laundry'),
      warnings: dashboardWarnings(this.store.all('garments'), all, this.store.all('basket_items'), day, now),
    }
  }

  // --- outfits & AI ----------------------------------------------------------------------------

  async aiStatus(): Promise<AiStatus> {
    return { enabled: ai.aiEnabled(), provider: 'groq', vision_model: aiModels.vision, text_model: aiModels.text, daily_limit: 0, used_today: 0 }
  }

  classify(dataUrl: string): Promise<Classification> {
    return ai.classifyImage(dataUrl)
  }

  async generateOutfits(body: OutfitRequestIn): Promise<{ outfits: Outfit[]; notes: string[] }> {
    await this.idle()
    const req = {
      occasion: v.str(body.occasion, 'Occasion', { max: 60 }),
      formality: v.int(body.formality, 'Formality', 1, 5),
      weather: v.tags(body.weather ?? []),
      count: v.int(body.count ?? 5, 'Count', 1, 10) ?? 5,
      today: this.today(body.today),
    }
    const ctx = loadContext(req, this.store.all('outfit_feedback'), this.store.all('garment_events'))
    const [suggestions, notes] = generateOutfits(this.store.all('garments'), ctx)
    const out = new Map(this.garmentsOut([...new Set(suggestions.flatMap((s) => s.garments))]).map((g) => [g.id, g]))
    return {
      outfits: suggestions.map((s) => ({
        garments: s.garments.map((g) => out.get(g.id)!),
        score: s.score,
        breakdown: Object.fromEntries(Object.entries(s.breakdown).map(([k, x]) => [k, Math.round(x * 100) / 100])),
        reasons: s.reasons,
        cautions: s.cautions,
      })),
      notes,
    }
  }

  async outfitFeedback(garmentIds: string[], rating: 1 | -1): Promise<void> {
    const list = v.ids(garmentIds, 'Garments', { min: 2, max: 20 })
    if (rating !== 1 && rating !== -1) throw invalid('Rating must be 1 or -1')
    await this.mutate((tx) => {
      this.ownedGarments(tx, list)
      tx.insert('outfit_feedback', { id: newId(), garment_ids: [...list].sort(), rating, created_at: clock() })
    })
  }

  async explainOutfit(garmentIds: string[], occasion?: string | null, weather?: string[]): Promise<Explanation> {
    await this.idle()
    const list = v.ids(garmentIds, 'Garments', { min: 1, max: 20 })
    const rows = list.map((id) => {
      const g = this.store.get('garments', id)
      if (!g) throw new ApiError(404, `Garment not found: ${id}`, 'not_found')
      return g
    })
    // Styling attributes only: no garment names or notes leave the device.
    const described = rows.map((g) =>
      Object.fromEntries(Object.entries({ category: g.category, subcategory: g.subcategory, color: g.color, pattern: g.pattern, fabric: g.fabric, formality: g.formality }).filter(([, x]) => x !== null)))
    const context = Object.fromEntries(Object.entries({ occasion: occasion || null, weather: v.tags(weather ?? []) }).filter(([, x]) => (Array.isArray(x) ? x.length : x)))
    return ai.explainOutfit(described, context)
  }

  // --- routines -----------------------------------------------------------------------------------

  async routines(): Promise<Routine[]> {
    await this.idle()
    return this.store.all('routines').sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)).map((r) => this.routineOut(r))
  }

  async createRoutine(body: RoutineInput): Promise<Routine> {
    const input = v.routineInput(body)
    const now = clock()
    const row: RoutineRow = { id: newId(), ...input, created_at: now, updated_at: now, rev: 0 }
    await this.mutate((tx) => void tx.insert('routines', row))
    return this.routineOut(this.store.get('routines', row.id)!)
  }

  async updateRoutine(id: string, body: RoutineInput): Promise<Routine> {
    const input = v.routineInput(body)
    await this.mutate((tx) => {
      const r = tx.get('routines', id)
      if (!r) throw notFound('Routine')
      Object.assign(r, input, { updated_at: clock() })
    })
    return this.routineOut(this.store.get('routines', id)!)
  }

  async deleteRoutine(id: string): Promise<void> {
    await this.mutate((tx) => {
      if (!tx.get('routines', id)) throw notFound('Routine')
      tx.delete('routines', id)
    })
  }

  async interpretRoutines(text: string): Promise<{ routines: RoutineDraft[]; questions: string[] }> {
    const input = v.str(text, 'Description', { min: 3, max: 2000 })!
    await this.idle()
    const owned = this.store.all('garments').map((g) => g.category)
    return ai.interpretRoutines(input, [...new Set([...Object.keys(lc.CATEGORY_DEFAULTS), ...owned])])
  }

  async checkRoutines(routine?: RoutineInput, routineId?: string, days = 14, start?: string): Promise<Feasibility> {
    await this.idle()
    const n = v.int(days, 'Days', 1, 28) ?? 14
    const today = this.today()
    const from = maxDate(start ?? today, today)
    let list = this.store.all('routines').filter((r) => r.active)
    if (routine) {
      const now = clock()
      const draft: RoutineRow = { id: routineId || 'draft', ...v.routineInput(routine), created_at: now, updated_at: now, rev: 0 }
      list = [...list.filter((r) => r.id !== draft.id), draft]
    }
    const dates = new Set(Array.from({ length: n }, (_, i) => addDays(from, i)))
    const result = new Planner(await this.snapshot(today), from, n, { today, routines: list, regenerate: dates }).run()
    const issues = result.issues.map(publicIssue)
    return { ok: !issues.some((i) => i.severity === 'error'), days: n, issues }
  }

  // --- calendar, settings, weather ---------------------------------------------------------------

  async events(start?: string, end?: string): Promise<CalendarEvent[]> {
    await this.idle()
    const from = start || this.today()
    const to = end || addDays(from, 90)
    return this.store.all('events').filter((e) => e.date >= from && e.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date) || (a.start_time ?? '').localeCompare(b.start_time ?? ''))
      .map((e) => this.eventOut(e))
  }

  private applyEvent(tx: Tx, e: EventRow, body: CalendarEventInput): void {
    const input = v.eventInput(body)
    if (input.garment_ids.length) this.ownedGarments(tx, input.garment_ids)
    Object.assign(e, input, {
      skip_day_routines: input.skip_day_routines ?? ['holiday', 'travel'].includes(input.kind),
      updated_at: clock(),
    })
  }

  async createEvent(body: CalendarEventInput): Promise<CalendarEvent> {
    const id = newId()
    const forecast = await this.currentForecast()
    await this.mutate((tx) => {
      const now = clock()
      const e = tx.insert('events', {
        id, title: '', kind: 'custom', date: '', start_time: null, end_time: null, occasion: null, formality: null,
        labels: [], notes: null, skip_day_routines: false, garment_ids: [], created_at: now, updated_at: now, rev: 0,
      })
      this.applyEvent(tx, e, body)
      this.replanIfPlanned(tx, [e.date], forecast)
    })
    return this.eventOut(this.store.get('events', id)!)
  }

  async updateEvent(id: string, body: CalendarEventInput): Promise<CalendarEvent> {
    const forecast = await this.currentForecast()
    await this.mutate((tx) => {
      const e = tx.get('events', id)
      if (!e) throw notFound('Event')
      const oldDate = e.date
      this.applyEvent(tx, e, body)
      // A moved event releases its old date and needs planning on the new one.
      this.replanIfPlanned(tx, [...new Set([oldDate, e.date])], forecast)
    })
    return this.eventOut(this.store.get('events', id)!)
  }

  async deleteEvent(id: string): Promise<void> {
    const forecast = await this.currentForecast()
    await this.mutate((tx) => {
      const e = tx.get('events', id)
      if (!e) throw notFound('Event')
      tx.delete('events', id)
      this.replanIfPlanned(tx, [e.date], forecast)
    })
  }

  private async currentForecast(): Promise<[Snapshot['forecast'], string | null]> {
    const s = this.settingsRow()
    return safeForecast(s?.latitude ?? null, s?.longitude ?? null)
  }

  async settings(): Promise<Settings> {
    await this.idle()
    const s = this.settingsRow()
    return {
      location_name: s?.location_name ?? null, latitude: s?.latitude ?? null, longitude: s?.longitude ?? null,
      laundry_weekdays: s?.laundry_weekdays ?? [], drying_days: s?.drying_days ?? 1, notification_prefs: s?.notification_prefs ?? {},
    }
  }

  /** Partial update: only fields present in `body` change. */
  async updateSettings(body: Partial<Settings>): Promise<Settings> {
    const input = v.settingsInput(body)
    await this.mutate((tx) => {
      let s = tx.get('settings', 'me')
      if (!s) {
        s = tx.insert('settings', {
          id: 'me', location_name: null, latitude: null, longitude: null, laundry_weekdays: [], drying_days: 1,
          notification_prefs: {}, updated_at: clock(), rev: 0,
        })
      }
      Object.assign(s, input, { updated_at: clock() })
    })
    return this.settings()
  }

  saveSettings(body: Settings): Promise<Settings> {
    return this.updateSettings(body)
  }

  geocode(q: string): Promise<{ name: string; latitude: number; longitude: number }[]> {
    const query = v.str(q, 'Search', { min: 2, max: 80 })!
    return geocodeCity(query).catch(() => {
      throw new ApiError(503, 'Location search is unavailable right now.', 'weather')
    })
  }

  async weather(days = 7, today?: string): Promise<{ location: string | null; error: string | null; days: WeatherDay[] }> {
    await this.idle()
    const day = this.today(today)
    const s = this.settingsRow()
    const [fc, error] = await safeForecast(s?.latitude ?? null, s?.longitude ?? null)
    const reports = new Map(this.store.all('weather_reports').map((r) => [r.date, r.tags]))
    const out: WeatherDay[] = []
    for (let i = 0; i < Math.min(16, Math.max(1, days)); i++) {
      const d = addDays(day, i)
      const f = fc.get(d)
      const reported = reports.get(d) ?? []
      out.push({ date: d, forecast: f ? stripDate(f) : null, reported, weather: reported.length ? reported : f ? f.tags : [] })
    }
    return { location: s?.location_name ?? null, error, days: out }
  }

  async reportWeather(date: string, tags: string[]): Promise<void> {
    const { WEATHER, canonical } = await import('./vocab')
    const day = v.dateStr(date, 'Date')!
    const clean = canonical(tags, WEATHER)
    await this.mutate((tx) => {
      const existing = tx.find('weather_reports', (r) => r.date === day)
      if (!clean.length) {
        if (existing) tx.delete('weather_reports', existing.id)
      } else if (existing) {
        tx.edit('weather_reports', existing).tags = clean
      } else {
        tx.insert('weather_reports', { id: newId(), date: day, tags: clean, created_at: clock() })
      }
    })
  }

  // --- plan -----------------------------------------------------------------------------------

  private planOut(result: PlanResult, start: string, today: string): Plan {
    const ids = new Set(result.days.flatMap((d) => d.slots.flatMap((s) => s.garmentIds)))
    const garments = new Map(this.garmentsOut(this.store.all('garments').filter((g) => ids.has(g.id))).map((g) => [g.id, g]))
    const days: PlanDayOut[] = result.days.map((day) => ({
      date: day.date,
      forecast: day.forecast ? stripDate(day.forecast) : null,
      reported: day.reported,
      weather: day.effectiveWeather,
      events: day.events.map((e) => this.eventOut(e)),
      slots: day.slots.map((s): PlanSlot => {
        const [source, ...rest] = s.slot.key.split(':')
        const ref = rest.join(':')
        return {
          key: s.slot.key, title: s.slot.title, source: source as PlanSlot['source'],
          routine_id: source === 'routine' ? ref : null, event_id: source === 'event' ? ref : null,
          entry_id: s.entry?.id ?? null, saved: !!s.entry, locked: !!s.entry?.locked, status: s.entry?.status ?? 'planned',
          garments: s.garmentIds.filter((g) => garments.has(g)).map((g) => garments.get(g)!),
          problems: s.problems, prep: [...new Set(s.prep)],
        }
      }),
      issues: day.issues.map(publicIssue),
    }))
    return {
      start, days, issues: result.issues.map(publicIssue), affected_dates: affectedDates(result, today),
      has_plan: days.some((d) => d.slots.some((s) => s.saved)), location: result.location, weather_error: result.weatherError,
    }
  }

  async plan(start: string, days = 7, today?: string): Promise<Plan> {
    await this.idle()
    const day = this.today(today)
    const from = maxDate(start || day, day)
    const result = new Planner(await this.snapshot(day), from, days, { today: day }).run()
    return this.planOut(result, from, day)
  }

  /** Replace unlocked, planned entries on `targets` with freshly generated slots. */
  private regenerate(tx: Tx, snap: Snapshot, start: string, days: number, targets: Set<string>, today: string): void {
    const result = new Planner(snap, start, days, { today, regenerate: targets }).run()
    for (const e of tx.filter('plan_entries', (x) => targets.has(x.date) && !x.locked && x.status === 'planned')) tx.delete('plan_entries', e.id)
    for (const day of result.days) {
      if (!targets.has(day.date)) continue
      for (const ps of day.slots) {
        if (ps.entry || !ps.garmentIds.length) continue // kept (locked/worn) entries stay; empty slots aren't stored
        const now = clock()
        tx.insert('plan_entries', {
          id: newId(), date: day.date, slot_key: ps.slot.key, title: ps.slot.title, garment_ids: ps.garmentIds,
          locked: false, status: 'planned', created_at: now, updated_at: now, rev: 0,
        })
      }
    }
  }

  private replanIfPlanned(tx: Tx, dates: string[], [forecast, weatherError]: [Snapshot['forecast'], string | null]): void {
    const today = this.today()
    const targets = new Set(dates.filter((d) => d >= today))
    if (!targets.size || !tx.find('plan_entries', (e) => targets.has(e.date))) return
    const sorted = [...targets].sort()
    const snap = this.snapshotWith(today, tx, forecast, weatherError)
    const span = Math.round((Date.parse(sorted.at(-1)!) - Date.parse(sorted[0])) / 86_400_000) + 1
    this.regenerate(tx, snap, sorted[0], span, targets, today)
  }

  async generatePlan(start: string, days = 7, today?: string, dates?: string[]): Promise<Plan> {
    const day = this.today(today)
    const from = maxDate(start || day, day)
    const n = Math.min(MAX_DAYS, Math.max(1, days))
    const end = addDays(from, n - 1)
    const all = Array.from({ length: n }, (_, i) => addDays(from, i))
    const targets = new Set((dates?.length ? dates : all).filter((d) => d >= day && d <= end))
    const forecast = await this.currentForecast()
    await this.mutate((tx) => this.regenerate(tx, this.snapshotWith(day, tx, ...forecast), from, n, targets, day))
    return this.plan(from, n, day)
  }

  async saveEntry(body: { date: string; slot_key: string; title: string; garment_ids: string[]; locked?: boolean }): Promise<{ id: string }> {
    const date = v.dateStr(body.date, 'Date')!
    const slotKey = v.required(body.slot_key, 'Slot', 60)
    const title = v.required(body.title, 'Title', 120)
    const garmentIds = v.ids(body.garment_ids, 'Garments', { min: 1, max: 20 })
    return this.mutate((tx) => {
      this.ownedGarments(tx, garmentIds)
      let entry: PlanEntryRow | undefined = tx.find('plan_entries', (e) => e.date === date && e.slot_key === slotKey)
      if (entry) entry = tx.edit('plan_entries', entry)
      else {
        const now = clock()
        entry = tx.insert('plan_entries', { id: newId(), date, slot_key: slotKey, title, garment_ids: [], locked: true, status: 'planned', created_at: now, updated_at: now, rev: 0 })
      }
      Object.assign(entry, { title, garment_ids: garmentIds, locked: body.locked !== false, status: 'planned', updated_at: clock() })
      return { id: entry.id }
    })
  }

  async updateEntry(id: string, body: { locked?: boolean; garment_ids?: string[]; status?: string }): Promise<void> {
    await this.mutate((tx) => {
      const e = tx.get('plan_entries', id)
      if (!e) throw notFound('Plan entry')
      if (body.garment_ids) {
        e.garment_ids = this.ownedGarments(tx, v.ids(body.garment_ids, 'Garments', { max: 20 })).map((g) => g.id)
        e.locked = true // a hand-picked outfit shouldn't be replaced automatically
      }
      if (body.locked !== undefined) e.locked = !!body.locked
      if (body.status) e.status = v.oneOf(body.status, ['planned', 'worn', 'skipped'] as const, 'Status')
      e.updated_at = clock()
    })
  }

  async wearEntry(id: string, today?: string): Promise<Garment[]> {
    const day = this.today(today)
    let garmentIds: string[] = []
    await this.mutate((tx) => {
      const e = tx.get('plan_entries', id)
      if (!e) throw notFound('Plan entry')
      if (e.date > day) throw new LifecycleError("You can only mark today's or past outfits as worn.", 'future')
      if (e.status === 'worn') throw new LifecycleError('Already marked as worn.', 'worn')
      garmentIds = e.garment_ids
      for (const g of this.ownedGarments(tx, e.garment_ids)) lc.markWorn(tx, g, e.date)
      e.status = 'worn'
      e.updated_at = clock()
    })
    return this.garmentsOut(garmentIds.map((g) => this.store.get('garments', g)!).filter(Boolean))
  }

  async simulate(body: { basket_id?: string; garment_ids?: string[]; wash_on?: string; days?: number }, today?: string): Promise<Simulation> {
    await this.idle()
    const day = this.today(today)
    const n = v.int(body.days ?? 7, 'Days', 1, 28) ?? 7
    let idList: string[]
    let washOn: string
    if (body.basket_id) {
      const b = this.store.get('laundry_baskets', body.basket_id)
      if (!b) throw notFound('Basket')
      if (b.kind === 'ironing') throw invalid('Simulation is for laundry baskets.')
      idList = this.store.all('basket_items').filter((i) => i.basket_id === b.id && i.active).map((i) => i.garment_id)
      washOn = body.wash_on || b.scheduled_for || day
    } else {
      idList = v.ids(body.garment_ids ?? [], 'Garments', { max: 200 })
      for (const id of idList) if (!this.store.get('garments', id)) throw new ApiError(404, `Garment not found: ${id}`, 'not_found')
      washOn = body.wash_on || day
    }
    if (!idList.length) throw invalid('Choose some garments (or a basket with garments) to simulate.')
    washOn = maxDate(washOn, day)
    const dates = new Set(Array.from({ length: n }, (_, i) => addDays(day, i)))
    const snap = await this.snapshot(day)
    const baseline = new Planner(snap, day, n, { today: day, regenerate: dates }).run()
    const sim = new Planner(snap, day, n, { today: day, regenerate: dates, washOverrides: new Map(idList.map((g) => [g, washOn])) })
    const scenario = sim.run()
    const returnsOn = addDays(washOn, sim.drying)

    const garments = idList.map((id) => this.store.get('garments', id)!)
    const start = scenario.simsAtStart
    const readyNow = (gid: string) => {
      const s = start.get(gid)
      return !!(s && !s.dirty && s.availableFrom && s.availableFrom <= day)
    }
    const items = this.store.all('pair_items')
    const pairs = this.store.all('pairs')
    const itemsOf = (pid: string) => items.filter((i) => i.pair_id === pid)
    const possible = pairs.filter((p) => itemsOf(p.id).length && itemsOf(p.id).every((i) => readyNow(i.garment_id))).map((p) => ({ id: p.id, name: p.name }))
    const blocked = pairs
      .filter((p) => itemsOf(p.id).some((i) => idList.includes(i.garment_id)) && !itemsOf(p.id).every((i) => readyNow(i.garment_id)))
      .map((p) => ({ id: p.id, name: p.name }))

    const owned = new Map<string, number>()
    const ready = new Map<string, number>()
    for (const [gid, s] of start) {
      owned.set(s.g.category, (owned.get(s.g.category) ?? 0) + 1)
      ready.set(s.g.category, (ready.get(s.g.category) ?? 0) + (readyNow(gid) ? 1 : 0))
    }
    const touched = [...new Set(garments.map((g) => g.category))].sort()
    const scarce = touched
      .filter((c) => (owned.get(c) ?? 0) >= 2 && (ready.get(c) ?? 0) <= 1)
      .map((c) => `Only ${ready.get(c) ?? 0} of your ${owned.get(c)} ${c} will be ready while this washes`)

    const shortages = (r: PlanResult) => new Map(r.issues.filter((i) => i.kind === 'shortage').map((i) => [i.ref ?? i.message, i]))
    const base = shortages(baseline)
    const scen = shortages(scenario)
    const worse = [...scen].filter(([k, i]) => (i.shortfall ?? 0) > (base.get(k)?.shortfall ?? 0)).map(([, i]) => publicIssue(i))
    const better = [...base].filter(([k, i]) => (i.shortfall ?? 0) > (scen.get(k)?.shortfall ?? 0)).map(([, i]) => publicIssue(i))
    const affected: string[] = []
    for (const d of scenario.days) {
      for (const e of d.events) {
        const hit = garments.filter((g) => (e.garment_ids ?? []).includes(g.id)).map((g) => g.name)
        if (hit.length && e.date < returnsOn) affected.push(`${e.title} (${dayLabelPadded(e.date)}) needs ${hit.join(', ')}, back ${dayLabelPadded(returnsOn)}`)
      }
    }
    const toIron = garments.filter((g) => g.ironing_policy === 'required')
    const preparation = toIron.length ? [`${toIron.length} of these will need ironing after washing`] : []
    if (sim.drying) preparation.push(`Allowing ${sim.drying} day(s) to dry`)
    return {
      wash_on: washOn, returns_on: returnsOn, unavailable: this.garmentsOut(garments.filter(lc.isWearable)),
      pairs_possible: possible, pairs_blocked: blocked, scarce, new_issues: worse, resolved_issues: better,
      affected_events: affected, preparation, covered: ![...scen.values()].some((i) => i.severity === 'error'),
    }
  }

  async coverage(today?: string): Promise<Coverage> {
    await this.idle()
    const day = this.today(today)
    return computeCoverage(await this.snapshot(day), day)
  }

  async brief(today?: string): Promise<Brief> {
    await this.idle()
    const day = this.today(today)
    const snap = await this.snapshot(day)
    const cov = computeCoverage(snap, day)
    const result = new Planner(snap, day, Math.min(7, cov.days), { today: day }).run()
    // Colour + category only: no personal garment names leave the device.
    const describe = (gid: string) => {
      const s = result.simsAtStart.get(gid)
      return s ? [s.g.color, s.g.category].filter(Boolean).join(' ') : null
    }
    const facts = {
      coverage: cov.headline,
      checked: cov.horizon,
      shortages: cov.shortages.map((s) => ({ routine: s.routine, category: s.category, missing: s.missing, first_short: s.first_short })),
      suggested_fixes: cov.suggestions.map((s) => s.title),
      days: result.days.map((d) => ({
        date: dayLabelPadded(d.date),
        weather: d.effectiveWeather,
        events: d.events.map((e) => e.title),
        outfits: d.slots.map((s) => ({
          for: s.slot.title,
          wear: s.garmentIds.map(describe).filter(Boolean),
          problems: s.problems,
          prep: s.prep.filter((p) => p.startsWith('Iron')),
        })),
      })),
    }
    return { ...(await ai.weeklyBrief(facts)), status: cov.status }
  }

  // --- insights ----------------------------------------------------------------------------------

  async analytics(days = 90, today?: string): Promise<Analytics> {
    await this.idle()
    const n = v.int(days, 'Days', 7, 365) ?? 90
    return computeAnalytics(this.store.all('garments'), this.store.all('garment_events'), this.store.all('laundry_baskets'), this.store.all('basket_items'), this.today(today), n)
  }

  async packing(body: { start: string; nights: number; activities: string[]; laundry_available: boolean }, today?: string) {
    await this.idle()
    const day = this.today(today)
    const start = maxDate(v.dateStr(body.start, 'Leaving on') ?? day, day)
    const nights = v.int(body.nights, 'Nights', 0, 30) ?? 0
    const snap = await this.snapshot(day)
    const res = packingList(snap, { start, nights, activities: v.tags(body.activities ?? []), laundry_available: !!body.laundry_available }, day, snap.forecast, snap.weatherError)
    return { ...res, sections: res.sections.map((s) => ({ ...s, garments: this.garmentsOut(s.garments) })) }
  }

  async purchase(body: { category: string; color?: string | null; pattern?: string | null; formality?: number | null; weather?: string[]; occasions?: string[] }, today?: string): Promise<PurchaseResult> {
    await this.idle()
    const day = this.today(today)
    return purchaseAnalysis(this.snapshotWith(day, this.store, new Map(), null), {
      category: v.required(body.category, 'Category', 40).toLowerCase(),
      color: v.str(body.color, 'Colour', { max: 40 }),
      pattern: v.str(body.pattern, 'Pattern', { max: 40 }),
      formality: v.int(body.formality, 'Formality', 1, 5),
      occasions: v.tags(body.occasions ?? []),
      weather: v.tags(body.weather ?? []),
    })
  }

  async notifications(today?: string): Promise<Reminder[]> {
    await this.idle()
    const day = this.today(today)
    const snap = await this.snapshot(day)
    const warnings = dashboardWarnings(this.store.all('garments'), this.store.all('laundry_baskets'), this.store.all('basket_items'), day, new Date().toISOString())
    return reminders(snap, day, warnings)
  }

  // --- backup & account --------------------------------------------------------------------------

  async exportData(includePhotos = true): Promise<Record<string, unknown>> {
    await this.idle()
    const data: Record<string, unknown> = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: new Date().toISOString() }
    for (const t of Object.keys(this.store.tables) as TableName[]) {
      if (t === 'photos') continue
      data[t] = this.store.all(t)
    }
    const photos = this.store.all('photos')
    data.photos = photos.map((p) => ({ id: p.id, garment_id: p.garment_id, mime: p.mime, created_at: p.created_at }))
    if (includePhotos && photos.length) {
      const found = await this.backend.loadPhotos(photos.map((p) => p.id))
      data.photo_data = Object.fromEntries([...found].map(([id, p]) => [id, p.data]))
    }
    return data
  }

  /** Replace everything with a backup made by this app (or by the old ClosetIQ server). */
  async importData(data: Record<string, unknown>): Promise<Record<string, number>> {
    if (data?.format === SERVER_BACKUP_FORMAT && data.version === 1) data = fromServerBackup(data)
    if (data?.format !== BACKUP_FORMAT || data.version !== BACKUP_VERSION) {
      throw invalid("This file isn't a ClosetIQ backup (or is from an unsupported version).")
    }
    await this.idle()
    const order: TableName[] = ['garments', 'pairs', 'pair_items', 'laundry_baskets', 'basket_items', 'garment_events', 'outfit_feedback', 'routines', 'events', 'weather_reports', 'plan_entries', 'settings']
    const counts: Record<string, number> = {}
    const ops: Op[] = []
    for (const t of order) {
      const rows = data[t]
      if (rows === undefined) continue
      if (!Array.isArray(rows)) throw invalid(`'${t}' should be a list`)
      counts[t] = rows.length
      for (const row of rows as Record<string, unknown>[]) {
        if (typeof row?.id !== 'string') throw invalid(`A row in '${t}' has no id`)
        const { rev: _rev, ...rest } = row
        void _rev
        ops.push({ op: 'insert', table: t, row: rest })
      }
    }
    const photoData = (data.photo_data ?? {}) as Record<string, string>
    const photoOps: Op[] = ((data.photos ?? []) as Record<string, unknown>[])
      .filter((p) => typeof p.id === 'string' && typeof photoData[p.id as string] === 'string')
      .map((p) => ({ op: 'insert', table: 'photos', row: { ...p, data: photoData[p.id as string] } }))
    // Garments point at photos that are inserted afterwards; set photo_id last.
    const photoIds = new Set(photoOps.map((o) => (o as Extract<Op, { op: 'insert' }>).row.id as string))
    const relink: Op[] = []
    for (const op of ops) {
      if (op.op === 'insert' && op.table === 'garments' && op.row.photo_id) {
        if (photoIds.has(op.row.photo_id as string)) relink.push({ op: 'update', table: 'garments', id: op.row.id as string, set: { photo_id: op.row.photo_id } })
        op.row = { ...op.row, photo_id: null }
      }
    }
    await this.backend.wipe()
    // Big restores go in chunks (each chunk is atomic).
    for (let i = 0; i < ops.length; i += 300) await this.backend.apply(ops.slice(i, i + 300))
    for (let i = 0; i < photoOps.length; i += 5) await this.backend.apply(photoOps.slice(i, i + 5))
    for (let i = 0; i < relink.length; i += 300) await this.backend.apply(relink.slice(i, i + 300))
    this.photoCache.clear()
    await this.reload()
    counts.photos = photoOps.length
    return counts
  }

  /** Delete every piece of wardrobe data in the vault (the setup and passphrase stay). */
  async deleteAllData(): Promise<void> {
    await this.idle()
    await this.backend.wipe()
    this.photoCache.clear()
    await this.reload()
  }
}

const SERVER_BACKUP_FORMAT = 'closetiq-backup'

/**
 * Convert a backup downloaded from the old ClosetIQ server (website version) into this app's
 * format, so an existing wardrobe can move to the phone. Ids are kept; photos keyed by their old
 * storage path become photo rows.
 */
export function fromServerBackup(old: Record<string, unknown>): Record<string, unknown> {
  const list = (k: string) => (Array.isArray(old[k]) ? (old[k] as Record<string, unknown>[]) : [])
  const strip = ({ user_id: _u, ...rest }: Record<string, unknown>) => (void _u, rest)
  const oldPhotos = (old.photos && typeof old.photos === 'object' ? old.photos : {}) as Record<string, unknown>
  const photos: Record<string, unknown>[] = []
  const photoData: Record<string, string> = {}
  const garments = list('garments').map((g) => {
    const { image_path: path, ...rest } = strip(g)
    const blob = typeof path === 'string' ? oldPhotos[path] : undefined
    if (typeof blob !== 'string') return { ...rest, photo_id: null }
    const ext = (path as string).split('.').pop()?.toLowerCase()
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    const id = newId()
    photos.push({ id, garment_id: rest.id, mime, created_at: rest.created_at ?? clock() })
    photoData[id] = blob
    return { ...rest, photo_id: id }
  })
  const settings = old.settings && typeof old.settings === 'object' ? [{ ...strip(old.settings as Record<string, unknown>), id: 'me' }] : []
  const out: Record<string, unknown> = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exported_at: old.exported_at, garments, settings, photos, photo_data: photoData }
  for (const t of ['pairs', 'pair_items', 'basket_items', 'garment_events', 'outfit_feedback', 'routines', 'events', 'weather_reports', 'plan_entries']) {
    out[t] = list(t).map(strip)
  }
  out.laundry_baskets = list('laundry_baskets').map((b) => ({ ...strip(b), kind: b.kind ?? 'laundry' }))
  return out
}

function stripDate<T extends { date: string }>(x: T): Omit<T, 'date'> {
  const { date: _d, ...rest } = x
  void _d
  return rest
}

/** Models shown in the AI status (kept in sync by the connection layer). */
export const aiModels = { vision: ai.DEFAULT_VISION_MODEL, text: ai.DEFAULT_TEXT_MODEL }
