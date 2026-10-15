// Pairs, dashboard, outfit engine, AI sanitising, insights and backups (ported).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Requirement } from '../../lib/types'
import * as ai from '../ai'
import { colorPairScore, MAX_REUSE } from '../outfits'
import { addDays } from '../time'
import { type Harness, createHarness, failure, reset } from '../testing/harness'

const MON = '2030-01-07'
let h: Harness
beforeAll(async () => {
  h = await createHarness()
}, 60_000)
beforeEach(async () => {
  await reset(h)
  vi.restoreAllMocks()
  ai.setAiConfig({ apiKey: null, visionModel: ai.DEFAULT_VISION_MODEL, textModel: ai.DEFAULT_TEXT_MODEL })
})
afterAll(async () => h.pg.close())

function groq(...replies: { content?: string; status?: number; retryAfter?: string }[]) {
  ai.setAiConfig({ apiKey: 'test-key', visionModel: ai.DEFAULT_VISION_MODEL, textModel: ai.DEFAULT_TEXT_MODEL })
  const sent: Record<string, unknown>[] = []
  vi.spyOn(ai.transport, 'post').mockImplementation(async (body) => {
    sent.push(body as Record<string, unknown>)
    const r = replies.shift()!
    return {
      status: r.status ?? 200,
      headers: { get: (n: string) => (n === 'retry-after' ? (r.retryAfter ?? null) : null) },
      json: async () => ({ choices: [{ message: { content: r.content ?? '' } }] }),
    }
  })
  return sent
}

const generate = async (body: Record<string, unknown> = {}) => h.svc.generateOutfits({ ...body } as never)
const names = (o: { garments: { name: string }[] }) => new Set(o.garments.map((g) => g.name))

describe('pairs', () => {
  it('shows availability, edits, duplicates and deletes', async () => {
    const shirt = await h.garment('Blue shirt', 'shirt')
    const trousers = await h.garment('Navy trousers', 'trousers')
    const shoes = await h.garment('Brown shoes', 'shoes')
    let pair = await h.svc.createPair({ name: 'Monday office', garment_ids: [shirt.id, trousers.id, shoes.id], labels: ['Office'] })
    expect(pair.garments.map((g) => g.name)).toEqual(['Blue shirt', 'Navy trousers', 'Brown shoes'])
    expect([pair.wearable, pair.blockers]).toEqual([true, []])
    await h.basket('Wash', [shirt.id])
    pair = (await h.svc.pairs())[0]
    expect(pair.wearable).toBe(false)
    expect(pair.blockers).toEqual([{ garment_id: shirt.id, garment_name: 'Blue shirt', reason: 'In Laundry Basket' }])
    const edited = await h.svc.updatePair(pair.id, { garment_ids: [trousers.id], favorite: true })
    expect([edited.wearable, edited.favorite, edited.garments.length]).toEqual([true, true, 1])
    const dup = await h.svc.duplicatePair(pair.id)
    expect([dup.name, dup.favorite]).toEqual(['Monday office (copy)', false])
    await h.svc.deletePair(pair.id)
    expect((await h.svc.pairs()).map((p) => p.name)).toEqual(['Monday office (copy)'])
    expect((await failure(h.svc.createPair({ name: 'X', garment_ids: ['nope'] }))).status).toBe(404)
  })

  it('wears a whole pair or nothing', async () => {
    const shirt = await h.garment('Shirt', 'shirt')
    const jeans = await h.garment('Jeans', 'jeans')
    const pair = await h.svc.createPair({ name: 'Casual', garment_ids: [shirt.id, jeans.id] })
    await h.svc.wearPair(pair.id, '2026-10-13')
    expect(await h.state(shirt.id)).toBe('needs_laundry')
    expect(await h.state(jeans.id)).toBe('worn_reusable')
    expect((await failure(h.svc.wearPair(pair.id))).status).toBe(409)
    expect((await h.svc.garment(jeans.id)).total_wears).toBe(1)
    const hist = await h.svc.history(jeans.id)
    expect([hist[0].kind, hist[0].pair_id]).toEqual(['worn', pair.id])
  })
})

describe('dashboard', () => {
  it('summarises and warns', async () => {
    const s1 = await h.garment('Shirt 1')
    const s2 = await h.garment('Shirt 2')
    const tee = await h.garment('Tee', 't-shirt')
    await h.basket('Monday Laundry', [s1.id, s2.id], { scheduled_for: '2026-10-13' })
    await h.basket('Old', [tee.id], { scheduled_for: '2026-10-01' })
    const d = await h.svc.dashboard('2026-10-13')
    expect([d.garments_total, d.garments_wearable, d.state_counts.in_basket]).toEqual([3, 0, 3])
    expect(d.baskets_due_today.map((b) => b.name)).toEqual(['Monday Laundry'])
    const kinds = new Set(d.warnings.map((w) => w.kind))
    for (const k of ['basket_due', 'basket_overdue', 'shortage']) expect(kinds.has(k)).toBe(true)
    const messages = d.warnings.map((w) => w.message)
    expect(messages).toContain('Your Monday Laundry basket is due today.')
    expect(messages).toContain('No shirt ready to wear (you own 2).')
  })
})

describe('outfits', () => {
  it('never uses unavailable garments', async () => {
    const s1 = await h.garment('White shirt', 'shirt', { color: 'white' })
    const s2 = await h.garment('Blue shirt', 'shirt', { color: 'blue' })
    await h.garment('Navy trousers', 'trousers', { color: 'navy' })
    await h.garment('Brown shoes', 'shoes', { color: 'brown' })
    await h.basket('Wash', [s1.id])
    await h.svc.needsIroning([s2.id])
    let out = await generate()
    expect(out.outfits).toEqual([])
    expect(out.notes).toContain('None of your tops are ready to wear right now.')
    await h.svc.ironed([s2.id])
    out = await generate()
    expect(out.outfits.map(names)).toEqual([new Set(['Blue shirt', 'Navy trousers', 'Brown shoes'])])
    expect(out.outfits.every((o) => o.garments.every((g) => g.wearable))).toBe(true)
  })

  it('ranks by occasion and formality', async () => {
    await h.garment('Formal shirt', 'shirt', { color: 'white', formality: 5, labels: ['Office'] })
    await h.garment('Band tee', 't-shirt', { color: 'black', formality: 1, labels: ['Casual'] })
    await h.garment('Suit trousers', 'trousers', { color: 'charcoal', formality: 5, labels: ['Office'] })
    await h.garment('Ripped jeans', 'jeans', { color: 'blue', formality: 1, labels: ['Casual'] })
    let best = (await generate({ occasion: 'Office', formality: 5 })).outfits[0]
    expect(names(best)).toEqual(new Set(['Formal shirt', 'Suit trousers']))
    expect(best.reasons).toContain('Every piece is tagged Office')
    best = (await generate({ occasion: 'Casual', formality: 1 })).outfits[0]
    expect(names(best)).toEqual(new Set(['Band tee', 'Ripped jeans']))
  })

  it('scores colour harmony', () => {
    expect(colorPairScore('Navy', 'red')).toBe(1)
    expect(colorPairScore('light blue', 'blue')).toBe(0.85)
    expect(colorPairScore('red', 'green')).toBeLessThan(colorPairScore('blue', 'teal'))
    expect(colorPairScore(null, 'red')).toBe(0.75)
  })

  it('learns from feedback and avoids recent repeats', async () => {
    const a = await h.garment('Shirt A', 'shirt', { color: 'white' })
    const b = await h.garment('Shirt B', 'shirt', { color: 'white' })
    const t = await h.garment('Trousers', 'trousers', { color: 'navy' })
    const first = (await generate({ count: 2 })).outfits
    expect(first.length).toBe(2)
    expect(first[0].score).toBe(first[1].score)
    await h.svc.outfitFeedback([b.id, t.id], 1)
    await h.svc.outfitFeedback([a.id, t.id], -1)
    const ranked = (await generate({ count: 2 })).outfits
    expect(names(ranked[0])).toEqual(new Set(['Shirt B', 'Trousers']))
    expect(ranked[0].reasons).toContain('Similar to outfits you liked')
    expect(ranked[1].cautions).toContain('Similar to outfits you disliked')
    expect((await failure(h.svc.outfitFeedback([a.id, 'nope'], 1))).status).toBe(404)

    await reset(h)
    const a2 = await h.garment('Shirt A', 'shirt', { color: 'white', max_wears_before_wash: 5 })
    await h.garment('Shirt B', 'shirt', { color: 'white' })
    const t2 = await h.garment('Trousers', 'trousers', { color: 'navy', max_wears_before_wash: 5 })
    await h.svc.wear([a2.id, t2.id], '2026-10-10')
    const r2 = (await generate({ count: 2, today: '2026-10-13' })).outfits
    expect(names(r2[0])).toEqual(new Set(['Shirt B', 'Trousers']))
    expect(r2[1].cautions.some((c) => c.startsWith('Worn together recently'))).toBe(true)
  })

  it('adds layers for cold weather and limits reuse', async () => {
    await h.garment('Shirt', 'shirt', { color: 'white' })
    await h.garment('Jeans', 'jeans', { color: 'blue' })
    await h.garment('Wool jacket', 'jacket', { color: 'grey', weather: ['Cold'] })
    expect(names((await generate({ weather: ['Cold'] })).outfits[0])).toEqual(new Set(['Shirt', 'Jeans', 'Wool jacket']))
    expect(names((await generate({ weather: ['Hot'] })).outfits[0])).toEqual(new Set(['Shirt', 'Jeans']))

    await reset(h)
    await h.garment('Star shirt', 'shirt', { color: 'white', labels: ['Office'] })
    await h.garment('Other shirt', 'shirt', { color: 'white' })
    for (let i = 0; i < 4; i++) await h.garment(`Trousers ${i}`, 'trousers', { color: 'navy', labels: ['Office'] })
    const out = (await generate({ occasion: 'Office', count: 5 })).outfits
    expect(out.filter((o) => names(o).has('Star shirt')).length).toBe(MAX_REUSE)
  })
})

describe('AI (Groq, mocked)', () => {
  it('is off without a key', async () => {
    expect((await h.svc.aiStatus()).enabled).toBe(false)
    expect((await failure(h.svc.classify('data:image/png;base64,AA=='))).code).toBe('ai_not_configured')
  })

  it('sanitises photo classification', async () => {
    const sent = groq({
      content: JSON.stringify({
        name: '  Light blue   Oxford shirt ', category: 'Shirt', color: 'Light Blue', pattern: 'Striped', formality: '9',
        occasions: ['office', 'Spaceship', 'Office'], labels: ['favorite', 'made-up'], seasons: ['summer', 'monsoon'], weather: ['HOT'],
      }),
    })
    const out = await h.svc.classify('data:image/png;base64,AA==')
    expect(out).toEqual({
      name: 'Light blue Oxford shirt', category: 'shirt', subcategory: null, color: 'light blue', pattern: 'striped', fabric: null,
      formality: 5, occasions: ['Office'], labels: ['Favorite'], seasons: ['Summer'], weather: ['Hot'],
    })
    expect(sent[0].model).toBe(ai.DEFAULT_VISION_MODEL)
    expect(sent[0].response_format).toEqual({ type: 'json_object' })
    expect(sent[0].reasoning_effort).toBe('none')
  })

  it('handles odd replies, not-clothing, quota and garbage', async () => {
    groq({ content: '<think>hmm</think>{"name": "Cape", "category": "cape"}' })
    expect((await h.svc.classify('data:x')).category).toBe('other')
    groq({ content: '{"error": "not_clothing"}' })
    expect((await failure(h.svc.classify('data:x'))).status).toBe(422)
    groq({ status: 429, retryAfter: '17' })
    const q = await failure(h.svc.classify('data:x'))
    expect([q.status, q.code, q.retryAfter]).toEqual([503, 'ai_quota', 17])
    groq({ content: "I think it's a shirt!" })
    expect((await failure(h.svc.classify('data:x'))).code).toBe('ai_bad_output')
  })

  it('explains outfits with styling attributes only', async () => {
    const shirt = await h.garment("Dad's lucky shirt", 'shirt', { color: 'white', notes: 'private note' })
    const jeans = await h.garment('Jeans', 'jeans', { color: 'blue' })
    const sent = groq({ content: '{"summary": "Classic and clean.", "tips": ["Roll the sleeves", "", 3]}' })
    expect(await h.svc.explainOutfit([shirt.id, jeans.id], 'Casual')).toEqual({ summary: 'Classic and clean.', tips: ['Roll the sleeves'] })
    const msg = (sent[0].messages as { content: string }[])[1].content
    expect(msg).not.toContain('lucky')
    expect(msg).not.toContain('private')
    expect(msg).toContain('white')
    expect(msg).toContain('Casual')
  })

  it('interprets routines into reviewable drafts', async () => {
    groq({
      content: JSON.stringify({
        routines: [
          { name: 'Office', kind: 'day', weekdays: [0, 1, 2, 'thu', 'Friday', 9], occasion: 'office', formality: 4, requirements: [
            { category: 'shirt', quantity: 1, min_formality: 4 }, { category: 'socks', quantity: '1' },
            { category: 'shoes', quantity: 1, reuse: 'fixed' }, { category: 'cravat', quantity: 1 }] },
          { name: 'Night', kind: 'night', weekdays: [], requirements: [{ category: 'nightwear' }] },
        ],
        questions: ['Do you wear a tie?'],
      }),
    })
    const out = await h.svc.interpretRoutines('Mon-Fri office...')
    const [office, night] = out.routines
    expect(office.weekdays).toEqual([0, 1, 2, 3, 4])
    expect(office.occasion).toBe('Office')
    expect(office.requirements.map((q: Requirement) => q.category)).toEqual(['shirt', 'socks', 'shoes'])
    expect(office.requirements[2].reuse).toBe('fixed')
    expect([night.kind, night.weekdays]).toEqual(['night', []])
    expect(out.questions).toEqual([
      'Do you wear a tie?',
      "'cravat' in Office isn't one of your categories. Which category should it use?",
      "Which days of the week does 'Night' apply to?",
    ])
  })
})

describe('insights', () => {
  it('computes statistics', async () => {
    const shirt = await h.garment('Shirt', 'shirt', { purchase_price: '40.00', max_wears_before_wash: 10 })
    const jeans = await h.garment('Jeans', 'jeans', { purchase_price: '60.00', max_wears_before_wash: 10 })
    await h.garment('Never worn', 't-shirt')
    for (let i = 0; i < 3; i++) await h.svc.wear([shirt.id, jeans.id], addDays(MON, -i))
    await h.svc.completeBasket((await h.basket('Wash', [shirt.id])).id)
    const a = await h.svc.analytics(30, MON)
    expect([a.garments_total, a.wears_in_period, a.never_worn]).toEqual([3, 6, 1])
    expect(a.least_worn[0].name).toBe('Never worn')
    expect(a.repeated_outfits).toEqual([{ garments: ['Jeans', 'Shirt'], times: 3 }])
    expect(a.awaiting_ironing).toBe(1)
    expect(a.cost_per_wear[0]).toEqual({ id: jeans.id, name: 'Jeans', category: 'jeans', value: 20 })
    expect(a.weekly_wears.reduce((s, w) => s + w.wears, 0)).toBe(6)
    const real = await h.svc.analytics(30)
    expect([real.laundry_runs, real.garments_washed]).toEqual([1, 1])
  })

  it('packs for a trip from clothes clean by departure', async () => {
    for (let i = 0; i < 4; i++) {
      await h.garment(`Tee ${i}`, 't-shirt')
      await h.garment(`Socks ${i}`, 'socks')
    }
    await h.garment('Underwear', 'underwear')
    await h.garment('Jeans', 'jeans')
    await h.garment('Sneakers', 'shoes')
    await h.garment('PJs', 'nightwear')
    const dirty = await h.garment('Dirty tee', 't-shirt')
    await h.svc.wear([dirty.id])
    let out = await h.svc.packing({ start: addDays(MON, 2), nights: 4, activities: [], laundry_available: false }, MON)
    expect(out.days).toBe(5)
    const by = Object.fromEntries(out.sections.map((s) => [s.title, s]))
    expect([by.Tops.needed, by.Tops.garments.length, by.Tops.shortfall]).toEqual([5, 4, 'Only 4 of 5 will be clean by departure'])
    expect(by.Tops.garments.map((g) => g.name)).not.toContain('Dirty tee')
    expect(by.Underwear.shortfall).toBe('Only 1 of 5 will be clean by departure')
    expect(by.Bottoms.needed).toBe(2)
    expect(by.Nightwear.garments.map((g) => g.name)).toEqual(['PJs'])
    out = await h.svc.packing({ start: MON, nights: 9, activities: [], laundry_available: true }, MON)
    expect(Object.fromEntries(out.sections.map((s) => [s.title, s.needed])).Tops).toBe(4)
    expect(out.notes.some((n) => n.includes('assuming you can do laundry'))).toBe(true)
  })

  it('analyses a purchase without saving it', async () => {
    await h.garment('White shirt', 'shirt', { color: 'white' })
    await h.garment('Blue shirt', 'shirt', { color: 'light blue' })
    await h.garment('Navy chinos', 'trousers', { color: 'navy' })
    let out = await h.svc.purchase({ category: 'trousers', color: 'black' })
    expect([out.new_outfits, out.strong_outfits, out.category_owned]).toEqual([2, 2, 1])
    out = await h.svc.purchase({ category: 'Shirt', color: 'white' })
    expect(out.similar_owned).toEqual(['White shirt'])
    await h.garment('White linen shirt', 'shirt', { color: 'white' })
    expect((await h.svc.purchase({ category: 'shirt', color: 'white' })).verdict.startsWith('You already own 2 similar')).toBe(true)
    expect((await h.svc.purchase({ category: 'socks', color: 'black' })).verdict).toContain("isn't used in outfit suggestions")
    expect((await h.svc.garments()).length).toBe(4)
  })

  it('lists reminders and respects preferences', async () => {
    const shirt = await h.garment('Blue shirt', 'shirt')
    await h.svc.needsIroning([shirt.id])
    await h.garment('Spare', 'socks')
    const s2 = await h.garment('Grey shirt', 'shirt')
    await h.basket('Monday Laundry', [s2.id], { scheduled_for: MON })
    await h.svc.createRoutine({ name: 'Office', kind: 'day', weekdays: [1], requirements: [{ category: 'shirt', quantity: 1 }] } as never)
    await h.svc.createEvent({ title: 'Wedding', date: addDays(MON, 1), occasion: 'Wedding' } as never)
    const messages = (await h.svc.notifications(MON)).map((n) => n.message)
    expect(messages).toContain('Your Monday Laundry basket is due today.')
    expect(messages).toContain('1 washed garment still needs ironing.')
    expect(messages.some((m) => m.startsWith('Tomorrow: Wedding.'))).toBe(true)
    expect(messages.some((m) => m.includes('needs ironing') && m.includes('tomorrow'))).toBe(true)
    await h.svc.updateSettings({ notification_prefs: { laundry: false, ironing: false, events: false, plan: false } })
    expect(await h.svc.notifications(MON)).toEqual([])
    await h.svc.updateSettings({ drying_days: 2 })
    expect((await h.svc.settings()).notification_prefs?.laundry).toBe(false)
  })

  it('lists declutter candidates', async () => {
    const old = await h.garment('Old jumper', 'sweater')
    await h.garment('New tee', 't-shirt')
    // Pretend the jumper was added 200 days ago.
    await h.backend.apply([{ op: 'update', table: 'garments', id: old.id, set: { created_at: new Date(Date.now() - 200 * 86_400_000).toISOString() } }])
    await h.svc.reload()
    const d = (await h.svc.analytics()).declutter
    expect(d.map((x) => x.name)).toEqual(['Old jumper'])
    expect(d[0].never_worn).toBe(true)
  })
})

describe('backup', () => {
  it('exports and restores everything, photos included', async () => {
    const shirt = await h.garment('Shirt', 'shirt', { labels: ['Office'], purchase_price: '25.50' })
    await h.svc.savePhoto(shirt.id, 'image/png', 'iVBORw0KGgo=')
    const jeans = await h.garment('Jeans', 'jeans')
    const pair = await h.svc.createPair({ name: 'Classic', garment_ids: [shirt.id, jeans.id] })
    await h.svc.wearPair(pair.id, MON)
    await h.basket('Wash', [shirt.id], { scheduled_for: MON })
    const routine = await h.svc.createRoutine({ name: 'Office', kind: 'day', weekdays: [0], requirements: [{ category: 'shirt', quantity: 1 }] } as never)
    await h.svc.createEvent({ title: 'Party', date: MON, garment_ids: [jeans.id] } as never)
    await h.svc.saveEntry({ date: MON, slot_key: `routine:${routine.id}`, title: 'Office', garment_ids: [jeans.id] })
    await h.svc.updateSettings({ laundry_weekdays: [5], drying_days: 2 })
    const backup = JSON.parse(JSON.stringify(await h.svc.exportData()))
    expect(backup.format).toBe('closetiq-app-backup')
    expect(Object.keys(backup.photo_data).length).toBe(1)

    await h.svc.deleteAllData()
    expect(await h.svc.garments()).toEqual([])
    expect((await failure(h.svc.importData({ format: 'other' }))).status).toBe(422)
    const counts = await h.svc.importData(backup)
    expect([counts.garments, counts.photos]).toEqual([2, 1])

    const garments = Object.fromEntries((await h.svc.garments()).map((g) => [g.name, g]))
    const s = garments.Shirt
    expect([s.state, s.active_basket?.name, s.labels, s.purchase_price]).toEqual(['in_basket', 'Wash', ['Office'], '25.50'])
    expect(await h.svc.photoUrl(s.photo_id!)).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(garments.Jeans.total_wears).toBe(1)
    expect((await h.svc.pairs())[0].garments.map((g) => g.name)).toEqual(['Shirt', 'Jeans'])
    expect((await h.svc.events(MON))[0].garment_ids).toEqual([jeans.id])
    const plan = await h.svc.plan(MON, 1, MON)
    expect(plan.days[0].slots.find((x) => x.title === 'Office')?.saved).toBe(true)
    expect((await h.svc.settings()).drying_days).toBe(2)
    await h.svc.completeBasket((await h.svc.baskets())[0].id)
    expect(await h.state(s.id)).toBe('needs_ironing')
  })
  it('restores a backup downloaded from the old ClosetIQ server', async () => {
    const t = '2030-01-01T09:00:00'
    const garment = (id: string, name: string, category: string, extra: object = {}) => ({
      id, user_id: 'local', name, category, subcategory: null, color: 'white', pattern: null, labels: [], occasions: [], formality: 2,
      seasons: [], weather: [], fabric: null, comfort_notes: null, max_wears_before_wash: 2, ironing_policy: 'never', purchase_date: null,
      purchase_price: null, notes: null, image_path: null, state: 'ready', iron_after_drying: false, total_wears: 0, wears_since_wash: 0,
      last_worn_on: null, last_washed_at: null, archived: false, archived_reason: null, created_at: t, updated_at: t, ...extra,
    })
    const old = {
      format: 'closetiq-backup', version: 1, exported_at: t,
      garments: [
        garment('g1', 'Linen shirt', 'shirt', { image_path: 'local/g1/abc.png', state: 'needs_ironing', ironing_policy: 'always' }),
        garment('g2', 'Chinos', 'trousers', { state: 'worn_reusable', total_wears: 3, wears_since_wash: 1, last_worn_on: '2030-01-05' }),
      ],
      pairs: [{ id: 'p1', user_id: 'local', name: 'Smart', description: null, labels: [], occasion: null, favorite: true, notes: null, created_at: t, updated_at: t }],
      pair_items: [{ id: 'pi1', pair_id: 'p1', garment_id: 'g1', position: 0 }, { id: 'pi2', pair_id: 'p1', garment_id: 'g2', position: 1 }],
      laundry_baskets: [{ id: 'b1', user_id: 'local', name: 'Ironing', kind: 'ironing', description: null, scheduled_for: null, expected_completion_at: null, status: 'pending', notes: null, created_at: t, started_at: null, completed_at: null }],
      basket_items: [{ id: 'bi1', user_id: 'local', basket_id: 'b1', garment_id: 'g1', added_at: t, previous_state: 'ready', active: true, outcome: null, resolved_at: null }],
      garment_events: [{ id: 'e1', user_id: 'local', garment_id: 'g2', kind: 'worn', from_state: 'ready', to_state: 'worn_reusable', basket_id: null, pair_id: null, worn_on: '2030-01-05', note: null, at: t }],
      routines: [], events: [], plan_entries: [], weather_reports: [], outfit_feedback: [],
      settings: { user_id: 'local', location_name: 'Pune', latitude: 18.5, longitude: 73.9, laundry_weekdays: [6], drying_days: 1, notification_prefs: {}, updated_at: t },
      photos: { 'local/g1/abc.png': 'iVBORw0KGgo=' },
    }
    const counts = await h.svc.importData(JSON.parse(JSON.stringify(old)))
    expect([counts.garments, counts.photos]).toEqual([2, 1])
    const garments = Object.fromEntries((await h.svc.garments()).map((g) => [g.name, g]))
    expect([garments['Linen shirt'].state, garments.Chinos.state, garments.Chinos.total_wears]).toEqual(['needs_ironing', 'worn_reusable', 3])
    expect(await h.svc.photoUrl(garments['Linen shirt'].photo_id!)).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect((await h.svc.pairs())[0].garments.map((g) => g.name)).toEqual(['Linen shirt', 'Chinos'])
    expect((await h.svc.settings()).location_name).toBe('Pune')
    const ironing = (await h.svc.baskets()).find((b) => b.kind === 'ironing')!
    expect((await h.svc.basket(ironing.id)).items.map((i) => i.garment.name)).toEqual(['Linen shirt'])
  })
})
