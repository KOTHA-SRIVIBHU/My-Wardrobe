// Deterministic garment lifecycle rules: every state change goes through here so
// availability, wear counts, history and the ironing basket stay consistent.
import type { GarmentState, IroningPolicy } from '../lib/types'
import { LifecycleError } from './errors'
import type { BasketItemRow, BasketRow, GarmentRow } from './rows'
import { type Tx, newId } from './store'
import { clock } from './time'

export const WEARABLE_STATES: ReadonlySet<GarmentState> = new Set(['ready', 'worn_reusable'])
export const BASKET_STATES: ReadonlySet<GarmentState> = new Set(['in_basket', 'in_laundry'])

export const STATE_LABELS: Record<GarmentState, string> = {
  ready: 'Ready to Wear',
  worn_reusable: 'Worn — Reusable',
  needs_laundry: 'Needs Laundry',
  in_basket: 'In Laundry Basket',
  in_laundry: 'In Laundry',
  drying: 'Drying',
  needs_ironing: 'Needs Ironing',
  reserved: 'Reserved',
  unavailable: 'Unavailable',
}

/** category -> [wears before it needs washing (null = never), ironing policy] */
export const CATEGORY_DEFAULTS: Record<string, [number | null, IroningPolicy]> = {
  shirt: [1, 'required'],
  't-shirt': [1, 'not_required'],
  trousers: [3, 'optional'],
  jeans: [5, 'not_required'],
  shorts: [2, 'not_required'],
  skirt: [3, 'optional'],
  dress: [1, 'optional'],
  vest: [1, 'not_required'],
  underwear: [1, 'not_required'],
  socks: [1, 'not_required'],
  nightwear: [3, 'not_required'],
  sweater: [4, 'not_required'],
  jacket: [10, 'not_required'],
  suit: [5, 'optional'],
  activewear: [1, 'not_required'],
  shoes: [null, 'not_required'],
  accessories: [null, 'not_required'],
  other: [1, 'not_required'],
}

export const IRONING_BASKET_NAME = 'Ironing basket'

export const label = (s: GarmentState) => STATE_LABELS[s]
export const isWearable = (g: GarmentRow) => !g.archived && WEARABLE_STATES.has(g.state)

export function blockerReason(g: GarmentRow): string | null {
  if (g.archived) return 'archived'
  return WEARABLE_STATES.has(g.state) ? null : label(g.state)
}

interface RecordOpts {
  from_state?: GarmentState | null
  to_state?: GarmentState | null
  basket_id?: string | null
  pair_id?: string | null
  worn_on?: string | null
  note?: string | null
  at?: string
}

function record(tx: Tx, g: GarmentRow, kind: string, o: RecordOpts = {}): void {
  tx.insert('garment_events', {
    id: newId(),
    garment_id: g.id,
    kind,
    from_state: o.from_state ?? null,
    to_state: o.to_state ?? null,
    basket_id: o.basket_id ?? null,
    pair_id: o.pair_id ?? null,
    worn_on: o.worn_on ?? null,
    note: o.note ?? null,
    at: o.at ?? clock(),
  })
}

interface TransitionOpts {
  kind?: string
  basket_id?: string | null
  note?: string | null
  at?: string
}

function transition(tx: Tx, g: GarmentRow, next: GarmentState, o: TransitionOpts = {}): void {
  const old = g.state
  if (old === next) return
  const kind = o.kind ?? 'state_change'
  // The ironing basket follows the Needs Ironing state automatically.
  if (old === 'needs_ironing') leaveIroning(tx, g, kind === 'ironed')
  g.state = next
  g.updated_at = clock()
  record(tx, g, kind, { from_state: old, to_state: next, basket_id: o.basket_id, note: o.note, at: o.at })
  if (next === 'needs_ironing') joinIroning(tx, g, old)
}

// --- Basket membership --------------------------------------------------------------

export function basketOf(tx: Tx, item: BasketItemRow): BasketRow {
  return tx.get('laundry_baskets', item.basket_id)!
}

export function activeBasketItem(tx: Tx, garmentId: string): BasketItemRow | undefined {
  return tx.find('basket_items', (i) => i.garment_id === garmentId && i.active)
}

export function activeLaundryItem(tx: Tx, garmentId: string): BasketItemRow | undefined {
  const item = activeBasketItem(tx, garmentId)
  return item && tx.get('laundry_baskets', item.basket_id)?.kind !== 'ironing' ? item : undefined
}

export function activeItems(tx: Tx, basketId: string): BasketItemRow[] {
  return tx.filter('basket_items', (i) => i.basket_id === basketId && i.active).sort((a, b) => a.added_at.localeCompare(b.added_at))
}

// --- Ironing basket -------------------------------------------------------------------

export function ironingBasket(tx: Tx): BasketRow | undefined {
  return tx.find('laundry_baskets', (b) => b.kind === 'ironing')
}

export function ensureIroningBasket(tx: Tx): BasketRow {
  const existing = ironingBasket(tx)
  if (existing) return existing
  return tx.insert('laundry_baskets', {
    id: newId(),
    name: IRONING_BASKET_NAME,
    kind: 'ironing',
    description: 'Clean clothes waiting to be ironed. Filled automatically after laundry.',
    scheduled_for: null,
    expected_completion_at: null,
    status: 'pending',
    notes: null,
    created_at: clock(),
    started_at: null,
    completed_at: null,
    rev: 0,
  })
}

function joinIroning(tx: Tx, g: GarmentRow, previous: GarmentState): void {
  const item = activeBasketItem(tx, g.id)
  if (item && tx.get('laundry_baskets', item.basket_id)?.kind === 'ironing') return
  const basket = ensureIroningBasket(tx)
  tx.insert('basket_items', {
    id: newId(),
    basket_id: basket.id,
    garment_id: g.id,
    added_at: clock(),
    previous_state: previous,
    active: true,
    outcome: null,
    resolved_at: null,
  })
}

/** The ironing basket itself stays, even when empty: there is only ever one. */
export function leaveIroning(tx: Tx, g: GarmentRow, ironed: boolean): void {
  const found = activeBasketItem(tx, g.id)
  if (!found || tx.get('laundry_baskets', found.basket_id)?.kind !== 'ironing') return
  const item = tx.edit('basket_items', found)
  item.active = false
  item.outcome = ironed ? 'ironed' : 'removed'
  item.resolved_at = clock()
}

// --- Wear limits ------------------------------------------------------------------------

/** Re-check a garment against its wear limit (after the limit was edited). */
export function applyWearLimit(tx: Tx, g: GarmentRow): void {
  if (g.archived || activeBasketItem(tx, g.id)) return
  const limit = g.max_wears_before_wash
  if (WEARABLE_STATES.has(g.state) && limit !== null && g.wears_since_wash >= limit) {
    transition(tx, g, 'needs_laundry', { kind: 'worn_limit', note: `Worn ${g.wears_since_wash} times; limit is ${limit}` })
  } else if (g.state === 'needs_laundry' && g.wears_since_wash > 0 && (limit === null || g.wears_since_wash < limit)) {
    // Only undo it if wearing (not the user) made it dirty, e.g. not after a stain.
    const last = tx
      .filter('garment_events', (e) => e.garment_id === g.id && e.to_state === 'needs_laundry')
      .sort((a, b) => b.at.localeCompare(a.at))[0]
    if (last && (last.kind === 'worn' || last.kind === 'worn_limit')) {
      transition(tx, g, 'worn_reusable', { note: 'Wear limit raised' })
    }
  }
}

function requireNotArchived(g: GarmentRow): void {
  if (g.archived) throw new LifecycleError(`'${g.name}' is archived.`, 'archived')
}

// --- Creation & manual control ------------------------------------------------------------

export function recordCreated(tx: Tx, g: GarmentRow): void {
  record(tx, g, 'created', { to_state: g.state })
}

export function overrideState(tx: Tx, g: GarmentRow, next: GarmentState, note: string | null): void {
  requireNotArchived(g)
  if (BASKET_STATES.has(next)) {
    throw new LifecycleError('Add the garment to a laundry basket instead of setting this state directly.', 'basket_state')
  }
  const item = activeLaundryItem(tx, g.id)
  if (item) {
    throw new LifecycleError(`'${g.name}' is in the basket '${basketOf(tx, item).name}'. Remove it from the basket first.`, 'in_basket')
  }
  if (next !== 'drying') g.iron_after_drying = false
  // "Ready to Wear" means clean and fresh; "Worn — Reusable" keeps the count.
  if (next === 'ready' && g.wears_since_wash) g.wears_since_wash = 0
  transition(tx, g, next, { note: note || 'Manual override' })
}

export function archive(tx: Tx, g: GarmentRow, reason: string): void {
  if (activeLaundryItem(tx, g.id)) {
    throw new LifecycleError(`'${g.name}' is in a laundry basket. Remove it before archiving.`, 'in_basket')
  }
  leaveIroning(tx, g, false)
  g.archived = true
  g.archived_reason = reason
  record(tx, g, 'archived', { note: reason })
}

export function prepareDelete(tx: Tx, g: GarmentRow): void {
  if (activeLaundryItem(tx, g.id)) {
    throw new LifecycleError(`'${g.name}' is in a laundry basket. Remove it before deleting.`, 'in_basket')
  }
  leaveIroning(tx, g, false)
}

export function unarchive(tx: Tx, g: GarmentRow): void {
  g.archived = false
  g.archived_reason = null
  record(tx, g, 'unarchived')
}

// --- Wearing ------------------------------------------------------------------------------

export function markWorn(tx: Tx, g: GarmentRow, wornOn: string, pairId: string | null = null): void {
  requireNotArchived(g)
  if (!WEARABLE_STATES.has(g.state) && g.state !== 'reserved') {
    throw new LifecycleError(`'${g.name}' is ${label(g.state)} and can't be worn.`, 'not_wearable')
  }
  const old = g.state
  g.total_wears += 1
  g.wears_since_wash += 1
  if (g.last_worn_on === null || wornOn > g.last_worn_on) g.last_worn_on = wornOn
  const limit = g.max_wears_before_wash
  g.state = limit !== null && g.wears_since_wash >= limit ? 'needs_laundry' : 'worn_reusable'
  g.updated_at = clock()
  record(tx, g, 'worn', { from_state: old, to_state: g.state, pair_id: pairId, worn_on: wornOn })
}

// --- Washing, drying, ironing -------------------------------------------------------------

const wantsIroning = (g: GarmentRow, choice: boolean | null | undefined) =>
  choice !== null && choice !== undefined ? choice : g.ironing_policy === 'required'

/** Washing is the only operation that resets wears-since-wash. */
export function applyWash(
  tx: Tx,
  g: GarmentRow,
  o: { dry: boolean; needsIroning?: boolean | null; basketId?: string | null; at?: string },
): void {
  const at = o.at ?? clock()
  g.wears_since_wash = 0
  g.last_washed_at = at
  record(tx, g, 'washed', { basket_id: o.basketId, at })
  const iron = wantsIroning(g, o.needsIroning)
  let target: GarmentState
  if (o.dry) {
    g.iron_after_drying = false
    target = iron ? 'needs_ironing' : 'ready'
  } else {
    g.iron_after_drying = iron
    target = 'drying'
  }
  transition(tx, g, target, { basket_id: o.basketId, at })
}

export function manualWash(tx: Tx, g: GarmentRow, dry: boolean, needsIroning: boolean | null | undefined): void {
  requireNotArchived(g)
  if (activeLaundryItem(tx, g.id)) {
    throw new LifecycleError(`'${g.name}' is in a laundry basket; complete or remove it there.`, 'in_basket')
  }
  applyWash(tx, g, { dry, needsIroning })
}

export function finishDrying(tx: Tx, g: GarmentRow): void {
  if (g.state !== 'drying') throw new LifecycleError(`'${g.name}' is not drying.`, 'invalid_state')
  const target: GarmentState = g.iron_after_drying ? 'needs_ironing' : 'ready'
  g.iron_after_drying = false
  transition(tx, g, target, { note: 'Finished drying' })
}

export function markNeedsIroning(tx: Tx, g: GarmentRow): void {
  requireNotArchived(g)
  if (g.state === 'drying') {
    g.iron_after_drying = true
    record(tx, g, 'state_change', { note: 'Will need ironing once dry' })
    return
  }
  if (!WEARABLE_STATES.has(g.state) && g.state !== 'reserved') {
    throw new LifecycleError(`'${g.name}' is ${label(g.state)}; only clean garments can be queued for ironing.`, 'invalid_state')
  }
  transition(tx, g, 'needs_ironing')
}

/** Ironing never touches wear counts or the last washed date. */
export function markIroned(tx: Tx, g: GarmentRow): void {
  if (g.state !== 'needs_ironing') throw new LifecycleError(`'${g.name}' doesn't need ironing.`, 'invalid_state')
  transition(tx, g, 'ready', { kind: 'ironed' })
}

// --- Laundry baskets -----------------------------------------------------------------------

/** Assign a garment to a basket. Returns non-blocking warnings. */
export function addToBasket(tx: Tx, basket: BasketRow, g: GarmentRow): string[] {
  if (basket.status === 'completed') throw new LifecycleError(`'${basket.name}' is already completed.`, 'basket_completed')
  requireNotArchived(g)
  let existing = activeBasketItem(tx, g.id)
  if (basket.kind === 'ironing') {
    if (existing && existing.basket_id === basket.id) throw new LifecycleError(`'${g.name}' is already in this basket.`, 'duplicate')
    markNeedsIroning(tx, g) // joins the ironing basket
    return []
  }
  if (existing && tx.get('laundry_baskets', existing.basket_id)?.kind === 'ironing') {
    // Going back into the wash: it no longer waits for ironing.
    leaveIroning(tx, g, false)
    existing = undefined
  }
  if (existing) {
    if (existing.basket_id === basket.id) throw new LifecycleError(`'${g.name}' is already in this basket.`, 'duplicate')
    throw new LifecycleError(
      `'${g.name}' is already in the basket '${basketOf(tx, existing).name}'. Remove it from there first.`,
      'in_other_basket',
    )
  }
  const warnings: string[] = []
  if (g.state === 'reserved') warnings.push(`'${g.name}' is reserved for an upcoming event.`)
  tx.insert('basket_items', {
    id: newId(),
    basket_id: basket.id,
    garment_id: g.id,
    added_at: clock(),
    previous_state: g.state,
    active: true,
    outcome: null,
    resolved_at: null,
  })
  transition(tx, g, basket.status === 'pending' ? 'in_basket' : 'in_laundry', { basket_id: basket.id, note: `Added to '${basket.name}'` })
  return warnings
}

export function removeFromBasket(
  tx: Tx,
  basket: BasketRow,
  garmentId: string,
  o: { confirm?: boolean; restoreTo?: GarmentState | null } = {},
): GarmentRow {
  const found = activeItems(tx, basket.id).find((i) => i.garment_id === garmentId)
  if (!found) throw new LifecycleError('That garment is not in this basket.', 'not_in_basket')
  const restoreTo = o.restoreTo ?? null
  if (restoreTo && BASKET_STATES.has(restoreTo)) throw new LifecycleError("Can't restore a garment to a basket state.", 'basket_state')
  const g = tx.get('garments', garmentId)!
  if (basket.kind === 'ironing') {
    // "Doesn't need ironing after all": it's clean, so it's ready unless told otherwise.
    transition(tx, g, restoreTo ?? 'ready', { note: `Removed from '${basket.name}'` })
    return g
  }
  if (basket.status === 'in_progress' && !o.confirm) {
    throw new LifecycleError(`'${basket.name}' is already in progress — the garment may already be washing.`, 'confirmation_required')
  }
  let target = restoreTo ?? found.previous_state
  if (BASKET_STATES.has(target)) target = 'needs_laundry' // never leave a garment orphaned in a basket state
  const item = tx.edit('basket_items', found)
  item.active = false
  item.outcome = 'removed'
  item.resolved_at = clock()
  if (target !== 'drying') g.iron_after_drying = false
  transition(tx, g, target, { basket_id: basket.id, note: `Removed from '${basket.name}'` })
  return g
}

function notIroning(basket: BasketRow): void {
  if (basket.kind === 'ironing') {
    throw new LifecycleError("The ironing basket empties as you mark clothes ironed; it isn't started or completed.", 'ironing_basket')
  }
}

export function startBasket(tx: Tx, basket: BasketRow): void {
  notIroning(basket)
  if (basket.status !== 'pending') throw new LifecycleError(`'${basket.name}' has already been started.`, 'invalid_status')
  const items = activeItems(tx, basket.id)
  if (!items.length) throw new LifecycleError(`'${basket.name}' is empty.`, 'empty_basket')
  const now = clock()
  basket.status = 'in_progress'
  basket.started_at = now
  for (const item of items) transition(tx, tx.get('garments', item.garment_id)!, 'in_laundry', { basket_id: basket.id, at: now })
}

export type WashResult = 'dry' | 'drying' | 'unavailable' | 'not_processed'
const RESULTS: WashResult[] = ['dry', 'drying', 'unavailable', 'not_processed']

export function completeBasket(
  tx: Tx,
  basket: BasketRow,
  defaultResult: string,
  outcomes: Map<string, [string, boolean | null]>,
): void {
  notIroning(basket)
  if (basket.status === 'completed') throw new LifecycleError(`'${basket.name}' is already completed.`, 'invalid_status')
  const items = activeItems(tx, basket.id)
  if (!items.length) throw new LifecycleError(`'${basket.name}' is empty.`, 'empty_basket')
  if (defaultResult !== 'dry' && defaultResult !== 'drying') {
    throw new LifecycleError("default_result must be 'dry' or 'drying'.", 'invalid_result')
  }
  const activeIds = new Set(items.map((i) => i.garment_id))
  if ([...outcomes.keys()].some((id) => !activeIds.has(id))) {
    throw new LifecycleError('Some outcomes refer to garments not in this basket.', 'not_in_basket')
  }
  for (const [result] of outcomes.values()) {
    if (!RESULTS.includes(result as WashResult)) throw new LifecycleError(`Unknown result '${result}'.`, 'invalid_result')
  }

  const now = clock()
  if (basket.started_at === null) basket.started_at = now
  for (const found of items) {
    const g = tx.get('garments', found.garment_id)!
    const [result, iron] = outcomes.get(g.id) ?? [defaultResult, null]
    const item = tx.edit('basket_items', found)
    item.active = false
    item.resolved_at = now
    if (result === 'not_processed') {
      item.outcome = 'not_processed'
      const target = BASKET_STATES.has(item.previous_state) ? 'needs_laundry' : item.previous_state
      transition(tx, g, target, { basket_id: basket.id, note: 'Not processed', at: now })
      continue
    }
    item.outcome = 'washed'
    applyWash(tx, g, { dry: result !== 'drying', needsIroning: iron, basketId: basket.id, at: now })
    if (result === 'unavailable') {
      g.iron_after_drying = false
      transition(tx, g, 'unavailable', { basket_id: basket.id, note: 'Unavailable after laundry', at: now })
    }
  }
  basket.status = 'completed'
  basket.completed_at = now
}

/** Deleting a pending basket returns its garments to their previous states. */
export function releasePendingBasket(tx: Tx, basket: BasketRow): void {
  const items = activeItems(tx, basket.id)
  if (basket.kind === 'ironing' && items.length) {
    throw new LifecycleError('Iron the clothes in this basket (or remove them) before deleting it.', 'ironing_basket')
  }
  if (basket.status === 'in_progress') {
    throw new LifecycleError(`'${basket.name}' is in progress; complete it or remove its garments first.`, 'invalid_status')
  }
  for (const item of items) removeFromBasket(tx, basket, item.garment_id)
}
