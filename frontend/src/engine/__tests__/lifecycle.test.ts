// Garments, wear rules, laundry baskets and the ironing basket: ported from the server's
// test suite and run against the real SQL (PGlite) through the vault passphrase.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { type Harness, createHarness, failure, reset } from '../testing/harness'

let h: Harness
beforeAll(async () => {
  h = await createHarness()
}, 60_000)
beforeEach(async () => reset(h))
afterAll(async () => h.pg.close())

const wear = (...ids: string[]) => h.svc.wear(ids)
const ironing = async () => {
  const found = (await h.svc.baskets()).filter((b) => b.kind === 'ironing')
  expect(found.length).toBeLessThanOrEqual(1)
  return found[0] ?? null
}

describe('garments', () => {
  it('applies category defaults', async () => {
    const shirt = await h.garment('White shirt', 'Shirt')
    expect([shirt.category, shirt.max_wears_before_wash, shirt.ironing_policy]).toEqual(['shirt', 1, 'required'])
    expect((await h.garment('Office shoes', 'shoes')).max_wears_before_wash).toBeNull()
  })

  it('lets explicit settings override defaults', async () => {
    const g = await h.garment('Jeans', 'jeans', { max_wears_before_wash: 2, ironing_policy: 'optional' })
    expect([g.max_wears_before_wash, g.ironing_policy]).toEqual([2, 'optional'])
  })

  it('cleans labels, filters and edits', async () => {
    const g = await h.garment('White shirt', 'shirt', { labels: ['Office', 'office', ' Favorite '] })
    expect(g.labels).toEqual(['Office', 'Favorite'])
    await h.garment('Tee', 't-shirt', { labels: ['Casual'] })
    expect((await h.svc.garments({ label: 'office' })).map((x) => x.name)).toEqual(['White shirt'])
    expect(await h.svc.labels()).toEqual(['Casual', 'Favorite', 'Office'])
    const edited = await h.svc.updateGarment(g.id, { color: 'white', labels: ['Party'] })
    expect([edited.labels, edited.color]).toEqual([['Party'], 'white'])
    expect((await failure(h.svc.updateGarment(g.id, { name: null as unknown as string }))).status).toBe(422)
  })

  it('tracks wears and reuse rules, all-or-nothing', async () => {
    const trousers = await h.garment('Grey trousers', 'trousers')
    const socks = await h.garment('Black socks', 'socks')
    const shoes = await h.garment('Office shoes', 'shoes')
    const ids = [trousers.id, socks.id, shoes.id]
    const byName = Object.fromEntries((await h.svc.wear(ids, '2026-10-12')).map((g) => [g.name, g]))
    expect(byName['Grey trousers'].state).toBe('worn_reusable')
    expect(byName['Grey trousers'].wearable).toBe(true)
    expect(byName['Black socks'].state).toBe('needs_laundry')
    expect(byName['Office shoes'].state).toBe('worn_reusable')
    expect(byName['Grey trousers'].last_worn_on).toBe('2026-10-12')

    expect((await failure(h.svc.wear(ids))).status).toBe(409)
    expect((await h.svc.garment(trousers.id)).total_wears).toBe(1)
    for (let i = 0; i < 2; i++) await h.svc.wear([trousers.id, shoes.id])
    const t = await h.svc.garment(trousers.id)
    expect([t.state, t.total_wears, t.wears_since_wash]).toEqual(['needs_laundry', 3, 3])
    expect(await h.state(shoes.id)).toBe('worn_reusable')
  })

  it('archives but keeps history', async () => {
    const g = await h.garment()
    await wear(g.id)
    const a = await h.svc.archive(g.id, 'no_longer_owned')
    expect([a.archived, a.wearable]).toEqual([true, false])
    expect(await h.svc.garments()).toEqual([])
    expect((await h.svc.garments({ include_archived: true })).length).toBe(1)
    const kinds = (await h.svc.history(g.id)).map((e) => e.kind)
    expect(kinds).toContain('worn')
    expect(kinds).toContain('archived')
    expect((await failure(wear(g.id))).status).toBe(409)
  })

  it('refuses manual basket states', async () => {
    const g = await h.garment()
    expect((await failure(h.svc.setState(g.id, 'in_laundry'))).code).toBe('basket_state')
    expect((await h.svc.setState(g.id, 'unavailable', 'Lent to Sam')).state).toBe('unavailable')
  })

  it("ironing doesn't reset wear counts", async () => {
    const g = await h.garment('Linen trousers', 'trousers')
    await wear(g.id)
    const [n] = await h.svc.needsIroning([g.id])
    expect([n.state, n.wearable]).toEqual(['needs_ironing', false])
    const [out] = await h.svc.ironed([g.id])
    expect([out.state, out.wears_since_wash, out.last_washed_at]).toEqual(['ready', 1, null])
  })

  it('handles manual wash, drying, then ironing', async () => {
    const g = await h.garment()
    await wear(g.id)
    const [out] = await h.svc.wash([g.id], false)
    expect([out.state, out.wears_since_wash, out.iron_after_drying]).toEqual(['drying', 0, true])
    expect(out.last_washed_at).not.toBeNull()
    expect((await h.svc.dried([g.id]))[0].state).toBe('needs_ironing')
    await h.svc.ironed([g.id])
    expect(await h.state(g.id)).toBe('ready')
  })

  it('stores photos in the vault and serves them', async () => {
    const g = await h.garment()
    expect((await failure(h.svc.savePhoto(g.id, 'text/plain', 'aGk='))).status).toBe(415)
    const withPhoto = await h.svc.savePhoto(g.id, 'image/png', 'iVBORw0KGgo=')
    expect(withPhoto.photo_id).toBeTruthy()
    // A fresh device loads it from the database, not the cache.
    const { WardrobeService } = await import('../service')
    const other = new WardrobeService(h.backend)
    await other.reload()
    expect(await other.photoUrl(withPhoto.photo_id!)).toBe('data:image/png;base64,iVBORw0KGgo=')
    const replaced = await h.svc.savePhoto(g.id, 'image/jpeg', '/9j/AA==')
    expect(replaced.photo_id).not.toBe(withPhoto.photo_id)
    expect((await h.backend.loadPhotos([withPhoto.photo_id!])).size).toBe(0) // old one deleted
    expect((await h.svc.deleteImage(g.id)).photo_id).toBeNull()
  })

  it('re-checks the wear limit when it is edited', async () => {
    const g = await h.garment('Jeans', 'jeans', { max_wears_before_wash: 5 })
    await wear(g.id)
    await wear(g.id)
    expect((await h.svc.updateGarment(g.id, { max_wears_before_wash: 2 })).state).toBe('needs_laundry')
    expect((await h.svc.updateGarment(g.id, { max_wears_before_wash: 4 })).state).toBe('worn_reusable')
    // A garment the user marked dirty stays dirty when the limit goes up.
    await h.svc.setState(g.id, 'needs_laundry', 'stain')
    expect((await h.svc.updateGarment(g.id, { max_wears_before_wash: 10 })).state).toBe('needs_laundry')
  })

  it('treats "Ready" as freshly clean', async () => {
    const g = await h.garment()
    await wear(g.id)
    const r = await h.svc.setState(g.id, 'ready')
    expect([r.state, r.wears_since_wash, r.total_wears]).toEqual(['ready', 0, 1])
    expect((await wear(g.id))[0].state).toBe('needs_laundry')
  })
})

describe('laundry baskets', () => {
  it('makes garments unavailable', async () => {
    const g = await h.garment()
    const b = await h.basket()
    expect((await h.svc.addToBasket(b.id, [g.id])).basket.garment_count).toBe(1)
    const got = await h.svc.garment(g.id)
    expect([got.state, got.wearable, got.active_basket?.name]).toEqual(['in_basket', false, 'Monday Laundry'])
    expect(await h.svc.garments({ wearable: true })).toEqual([])
    expect((await failure(wear(g.id))).status).toBe(409)
  })

  it('keeps a garment in one active basket', async () => {
    const g = await h.garment()
    const first = await h.basket('Monday Laundry', [g.id])
    const second = await h.basket('Whites')
    const e = await failure(h.svc.addToBasket(second.id, [g.id]))
    expect(e.code).toBe('in_other_basket')
    expect(e.message).toContain('Monday Laundry')
    expect((await failure(h.svc.addToBasket(first.id, [g.id]))).code).toBe('duplicate')
  })

  it('adds in bulk all-or-nothing', async () => {
    const a = await h.garment('A')
    const b = await h.garment('B')
    await h.basket('Other', [b.id])
    const basket = await h.basket()
    expect((await failure(h.svc.addToBasket(basket.id, [a.id, b.id]))).status).toBe(409)
    expect(await h.state(a.id)).toBe('ready')
  })

  it('restores previous states on removal', async () => {
    const clean = await h.garment('Clean shirt')
    const dirty = await h.garment('Dirty shirt')
    await wear(dirty.id)
    const b = await h.basket('Monday Laundry', [clean.id, dirty.id])
    await h.svc.removeFromBasket(b.id, clean.id)
    expect(await h.state(clean.id)).toBe('ready')
    await h.svc.removeFromBasket(b.id, dirty.id)
    expect(await h.state(dirty.id)).toBe('needs_laundry')
    expect((await h.svc.basket(b.id)).garment_count).toBe(0)
    const g = await h.garment()
    const b2 = await h.basket('X', [g.id])
    await h.svc.removeFromBasket(b2.id, g.id, false, 'needs_laundry')
    expect(await h.state(g.id)).toBe('needs_laundry')
  })

  it('needs confirmation to remove from an in-progress basket', async () => {
    const g = await h.garment()
    await wear(g.id)
    const b = await h.basket('Wash', [g.id])
    const started = await h.svc.startBasket(b.id)
    expect(started.status).toBe('in_progress')
    expect(started.started_at).toBeTruthy()
    expect(await h.state(g.id)).toBe('in_laundry')
    expect((await failure(h.svc.removeFromBasket(b.id, g.id))).code).toBe('confirmation_required')
    await h.svc.removeFromBasket(b.id, g.id, true)
    expect(await h.state(g.id)).toBe('needs_laundry')
  })

  it('sends late additions straight to the wash', async () => {
    const a = await h.garment('A')
    const b = await h.garment('B')
    const basket = await h.basket('Wash', [a.id])
    await h.svc.startBasket(basket.id)
    await h.svc.addToBasket(basket.id, [b.id])
    expect(await h.state(b.id)).toBe('in_laundry')
  })

  it('resets counts on completion and respects ironing', async () => {
    const shirt = await h.garment('Formal shirt', 'shirt')
    const tee = await h.garment('Tee', 't-shirt')
    await wear(shirt.id, tee.id)
    const b = await h.basket('Wash', [shirt.id, tee.id])
    await h.svc.startBasket(b.id)
    const done = await h.svc.completeBasket(b.id, 'dry')
    expect(done.status).toBe('completed')
    expect(done.garment_count).toBe(2)
    expect(done.items.every((i) => i.outcome === 'washed' && !i.active)).toBe(true)
    const s = await h.svc.garment(shirt.id)
    const t = await h.svc.garment(tee.id)
    expect(s.state).toBe('needs_ironing')
    expect(t.state).toBe('ready')
    for (const g of [s, t]) expect([g.wears_since_wash, g.total_wears, !!g.last_washed_at]).toEqual([0, 1, true])
    expect(t.active_basket).toBeNull()
    expect(s.active_basket?.kind).toBe('ironing')
  })

  it('records per-garment outcomes', async () => {
    const shirt = await h.garment('Shirt', 'shirt')
    const tee = await h.garment('Tee', 't-shirt')
    const jeans = await h.garment('Jeans', 'jeans')
    const sweater = await h.garment('Sweater', 'sweater')
    await wear(jeans.id, sweater.id)
    const b = await h.basket('Wash', [shirt.id, tee.id, jeans.id, sweater.id])
    await h.svc.completeBasket(b.id, 'drying', [
      { garment_id: tee.id, result: 'dry', needs_ironing: true },
      { garment_id: jeans.id, result: 'not_processed' },
      { garment_id: sweater.id, result: 'unavailable' },
    ])
    expect(await h.state(shirt.id)).toBe('drying')
    expect(await h.state(tee.id)).toBe('needs_ironing')
    const j = await h.svc.garment(jeans.id)
    expect([j.state, j.wears_since_wash, j.last_washed_at]).toEqual(['worn_reusable', 1, null])
    const sw = await h.svc.garment(sweater.id)
    expect([sw.state, sw.wears_since_wash]).toEqual(['unavailable', 0])
    expect((await h.svc.dried([shirt.id]))[0].state).toBe('needs_ironing')
  })

  it('closes completed baskets', async () => {
    const g = await h.garment('Tee', 't-shirt')
    const b = await h.basket('Wash', [g.id])
    await h.svc.completeBasket(b.id)
    expect((await failure(h.svc.addToBasket(b.id, [g.id]))).status).toBe(409)
    expect((await failure(h.svc.completeBasket(b.id))).status).toBe(409)
    expect((await failure(h.svc.startBasket(b.id))).status).toBe(409)
    expect((await h.basket('Next', [g.id])).garment_count).toBe(1)
    expect((await h.svc.basket(b.id)).status).toBe('completed')
  })

  it('rejects outcomes for other garments', async () => {
    const a = await h.garment('A')
    const b = await h.garment('B')
    const basket = await h.basket('Wash', [a.id])
    expect((await failure(h.svc.completeBasket(basket.id, 'dry', [{ garment_id: b.id, result: 'dry' }]))).status).toBe(409)
    expect(await h.state(a.id)).toBe('in_basket')
  })

  it('releases garments when a pending basket is deleted, not an in-progress one', async () => {
    const g = await h.garment()
    const b = await h.basket('Wash', [g.id])
    await h.svc.deleteBasket(b.id)
    expect(await h.state(g.id)).toBe('ready')
    const b2 = await h.basket('Wash 2', [g.id])
    await h.svc.startBasket(b2.id)
    expect((await failure(h.svc.deleteBasket(b2.id))).status).toBe(409)
  })

  it('warns about reserved garments and restores them', async () => {
    const g = await h.garment()
    await h.svc.setState(g.id, 'reserved')
    const r = await h.svc.createBasket({ name: 'Urgent', garment_ids: [g.id] })
    expect(r.warnings.some((w) => w.includes('reserved'))).toBe(true)
    await h.svc.removeFromBasket(r.basket.id, g.id)
    expect(await h.state(g.id)).toBe('reserved')
  })

  it('blocks overriding, archiving or deleting a garment in a basket', async () => {
    const g = await h.garment()
    await h.basket('Wash', [g.id])
    expect((await failure(h.svc.setState(g.id, 'ready'))).status).toBe(409)
    expect((await failure(h.svc.archive(g.id))).status).toBe(409)
    expect((await failure(h.svc.deleteGarment(g.id))).status).toBe(409)
  })

  it('sorts and filters baskets', async () => {
    await h.basket('Weekend', [], { scheduled_for: '2026-10-18' })
    await h.basket('Monday', [], { scheduled_for: '2026-10-12' })
    await h.basket('Someday')
    expect((await h.svc.baskets()).map((b) => b.name)).toEqual(['Monday', 'Weekend', 'Someday'])
    expect((await h.svc.baskets(undefined, 'name')).map((b) => b.name)).toEqual(['Monday', 'Someday', 'Weekend'])
    expect(await h.svc.baskets('completed')).toEqual([])
  })
})

describe('ironing basket', () => {
  it('is created automatically after laundry and reused', async () => {
    const shirt = await h.garment('Formal shirt', 'shirt')
    const tee = await h.garment('Tee', 't-shirt')
    expect(await ironing()).toBeNull()
    await h.svc.completeBasket((await h.basket('Wash', [shirt.id, tee.id])).id)
    const ib = (await ironing())!
    expect([ib.name, ib.garment_count]).toEqual(['Ironing basket', 1])
    expect((await h.svc.garment(shirt.id)).active_basket).toEqual({ id: ib.id, name: 'Ironing basket', status: 'pending', kind: 'ironing' })
    expect((await h.svc.baskets())[0].id).toBe(ib.id)
    const d = await h.svc.dashboard()
    expect(d.ironing_basket?.id).toBe(ib.id)
    expect(d.baskets_pending.map((b) => b.id)).not.toContain(ib.id)
    const shirt2 = await h.garment('Second shirt', 'shirt')
    await h.svc.completeBasket((await h.basket('Wash 2', [shirt2.id])).id)
    expect((await ironing())!.id).toBe(ib.id)
    expect((await ironing())!.garment_count).toBe(2)
  })

  it('stays one permanent basket across rounds (regression)', async () => {
    const shirt = await h.garment('Shirt', 'shirt')
    let first: string | null = null
    for (let round = 0; round < 3; round++) {
      await h.svc.completeBasket((await h.basket(`Wash ${round}`, [shirt.id])).id)
      await h.svc.ironed([shirt.id])
      const ib = (await ironing())!
      first ??= ib.id
      expect([ib.id, ib.status, ib.garment_count]).toEqual([first, 'pending', 0])
      await wear(shirt.id)
    }
    expect((await h.svc.basket(first!)).items.map((i) => i.outcome)).toEqual(['ironed', 'ironed', 'ironed'])
  })

  it('joins once dry; leaves on "no ironing needed"', async () => {
    const shirt = await h.garment('Shirt', 'shirt')
    await h.svc.completeBasket((await h.basket('Wash', [shirt.id])).id, 'drying')
    expect(await ironing()).toBeNull()
    await h.svc.dried([shirt.id])
    const ib = (await ironing())!
    expect(ib.garment_count).toBe(1)
    await h.svc.removeFromBasket(ib.id, shirt.id)
    expect(await h.state(shirt.id)).toBe('ready')
    expect((await ironing())!.garment_count).toBe(0)
  })

  it('moves to laundry when rewashed and back when removed', async () => {
    const g = await h.garment('Shirt', 'shirt')
    await h.svc.needsIroning([g.id])
    const laundry = await h.basket('Rewash', [g.id])
    const got = await h.svc.garment(g.id)
    expect([got.state, got.active_basket?.id]).toEqual(['in_basket', laundry.id])
    expect((await ironing())!.garment_count).toBe(0)
    await h.svc.removeFromBasket(laundry.id, g.id)
    expect(await h.state(g.id)).toBe('needs_ironing')
    expect((await ironing())!.garment_count).toBe(1)
  })

  it('is left by override, archive and delete; has its own rules', async () => {
    const a = await h.garment('A', 'shirt')
    const b = await h.garment('B', 'shirt')
    const c = await h.garment('C', 'shirt')
    await h.svc.needsIroning([a.id, b.id])
    await h.svc.setState(a.id, 'unavailable')
    await h.svc.archive(b.id)
    expect((await ironing())!.garment_count).toBe(0)
    await h.svc.needsIroning([c.id])
    const ib = (await ironing())!
    expect((await failure(h.svc.startBasket(ib.id))).code).toBe('ironing_basket')
    expect((await failure(h.svc.completeBasket(ib.id))).code).toBe('ironing_basket')
    expect((await failure(h.svc.deleteBasket(ib.id))).status).toBe(409)
    const d = await h.garment('D', 'shirt')
    expect((await h.svc.addToBasket(ib.id, [d.id])).basket.garment_count).toBe(2)
    expect(await h.state(d.id)).toBe('needs_ironing')
    await h.svc.deleteGarment(d.id)
    expect((await ironing())!.garment_count).toBe(1)
  })
})
