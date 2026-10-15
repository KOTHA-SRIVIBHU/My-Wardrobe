// Routines, calendar, weather, the weekly planner, laundry simulation and the clothes
// coverage check (ported from the server's suite). Fixed 2030 dates keep it timeless.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Plan, PlanSlot, Requirement, RoutineInput } from '../../lib/types'
import * as ai from '../ai'
import { addDays } from '../time'
import { type Harness, createHarness, failure, reset } from '../testing/harness'
import * as weather from '../weather'

const MON = '2030-01-07'
const day = (n: number) => addDays(MON, n)
const WEEKDAYS = [0, 1, 2, 3, 4]
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6]

let h: Harness
beforeAll(async () => {
  h = await createHarness()
}, 60_000)
beforeEach(async () => {
  await reset(h)
  vi.restoreAllMocks()
})
afterAll(async () => h.pg.close())

function routine(name = 'Office', weekdays = WEEKDAYS, requirements: Partial<Requirement>[] = [{ category: 'shirt', quantity: 1 }], extra: Partial<RoutineInput> = {}) {
  return h.svc.createRoutine({
    name, kind: 'day', weekdays, start_date: null, end_date: null, occasion: null, formality: null,
    requirements: requirements as Requirement[], mandatory: true, active: true, notes: null, source_text: null, ...extra,
  })
}
const event = (body: Record<string, unknown>) =>
  h.svc.createEvent({ kind: 'custom', start_time: null, end_time: null, occasion: null, formality: null, labels: [], notes: null, skip_day_routines: null, garment_ids: [], ...body } as never)
const getPlan = (days = 5, start = MON) => h.svc.plan(start, days, MON)
const generate = (days = 5, dates?: string[]) => h.svc.generatePlan(MON, days, MON, dates)
const slot = (plan: Plan, n: number, title: string) => plan.days[n].slots.find((s) => s.title === title)!
const names = (s: PlanSlot) => s.garments.map((g) => g.name)

describe('routines', () => {
  it('validates input', async () => {
    expect((await failure(routine('X', [7]))).status).toBe(422)
    expect((await failure(routine('X', [1], []))).status).toBe(422)
    const made = await routine('Office', [4, 0, 0], [{ category: ' Socks ', quantity: 2 }])
    expect(made.weekdays).toEqual([0, 4])
    expect(made.requirements[0].category).toBe('socks')
    expect((await h.svc.updateRoutine(made.id, { ...made, active: false })).active).toBe(false)
    await h.svc.deleteRoutine(made.id)
    expect(await h.svc.routines()).toEqual([])
  })

  it('checks a draft without saving it', async () => {
    await h.garment('Only socks', 'socks')
    const draft = { name: 'Daily', kind: 'day', weekdays: EVERY_DAY, requirements: [{ category: 'socks', quantity: 1 }] } as unknown as RoutineInput
    const out = await h.svc.checkRoutines(draft, undefined, 3)
    expect(out.ok).toBe(false)
    expect(out.issues.map((i) => i.message)).toContain('Daily: 3 clean socks needed over these 3 days, but only 1 can be planned.')
    expect(await h.svc.routines()).toEqual([])
  })
})

describe('planner', () => {
  it('reports shortages instead of inventing clothes', async () => {
    for (let i = 0; i < 3; i++) await h.garment(`Shirt ${i}`, 'shirt')
    await routine()
    const plan = await getPlan()
    const planned = [0, 1, 2, 3, 4].map((n) => slot(plan, n, 'Office'))
    expect(planned.map((s) => s.garments.length)).toEqual([1, 1, 1, 0, 0])
    expect(planned[3].problems).toEqual(['Missing 1 shirt'])
    const messages = plan.issues.map((i) => i.message)
    expect(messages).toContain('Office: 5 clean shirts needed over these 5 days, but only 3 can be planned.')
    expect(messages.some((m) => m.startsWith('Tip: set your usual laundry days'))).toBe(true)
    const worn = planned.flatMap(names)
    expect(new Set(worn).size).toBe(3)
  })

  it('counts on laundry days', async () => {
    for (let i = 0; i < 2; i++) await h.garment(`Shirt ${i}`, 'shirt', { ironing_policy: 'not_required' })
    await routine()
    await h.svc.updateSettings({ laundry_weekdays: [2], drying_days: 0 })
    const plan = await getPlan()
    expect([0, 1, 2, 3].every((n) => slot(plan, n, 'Office').garments.length === 1)).toBe(true)
    expect(slot(plan, 4, 'Office').garments).toEqual([])
    expect(slot(plan, 2, 'Office').prep.some((p) => p.includes('after your Wednesday laundry'))).toBe(true)
  })

  it('brings basket clothes back with ironing prep', async () => {
    const shirt = await h.garment('Blue shirt', 'shirt')
    await h.basket('Monday Laundry', [shirt.id], { scheduled_for: MON })
    await routine('Office', EVERY_DAY)
    const plan = await getPlan(3)
    expect(slot(plan, 0, 'Office').garments).toEqual([])
    const tue = slot(plan, 1, 'Office')
    expect(names(tue)).toEqual(['Blue shirt'])
    expect(tue.prep).toContain('Iron Blue shirt before Tue 8 Jan')
    expect(tue.prep.some((p) => p.includes("after 'Monday Laundry'"))).toBe(true)
  })

  it('warns about unscheduled baskets', async () => {
    const shirt = await h.garment('Blue shirt', 'shirt')
    await h.basket('Someday', [shirt.id])
    await routine()
    expect((await getPlan()).issues.some((i) => i.kind === 'unscheduled' && i.message.includes('Someday'))).toBe(true)
  })

  it('reuses fixed items and filters by formality', async () => {
    await h.garment('Office shoes', 'shoes')
    await h.garment('Other shoes', 'shoes')
    for (let i = 0; i < 5; i++) await h.garment(`Shirt ${i}`, 'shirt')
    await routine('Office', WEEKDAYS, [{ category: 'shirt', quantity: 1 }, { category: 'shoes', quantity: 1, reuse: 'fixed' }])
    const plan = await getPlan()
    const shoes = new Set([0, 1, 2, 3, 4].flatMap((d) => names(slot(plan, d, 'Office')).filter((n) => n.includes('shoes'))))
    expect(shoes.size).toBe(1)

    await reset(h)
    await h.garment('Formal shirt', 'shirt', { formality: 5 })
    await h.garment('Casual shirt', 'shirt', { formality: 2 })
    await routine('Office', WEEKDAYS, [{ category: 'shirt', quantity: 1, min_formality: 4 }])
    const p2 = await getPlan(2)
    expect(names(slot(p2, 0, 'Office'))).toEqual(['Formal shirt'])
    expect(slot(p2, 1, 'Office').problems).toEqual(['Missing 1 shirt'])
  })

  it('skips day routines on holidays but not night ones', async () => {
    await h.garment('Shirt', 'shirt')
    await h.garment('PJs', 'nightwear')
    await routine()
    await routine('Night', EVERY_DAY, [{ category: 'nightwear', quantity: 1 }], { kind: 'night' })
    expect((await event({ title: 'Holiday', kind: 'holiday', date: MON })).skip_day_routines).toBe(true)
    expect((await getPlan(1)).days[0].slots.map((s) => s.title)).toEqual(['Night'])
  })

  it('plans event outfits and protects reserved ones', async () => {
    await h.garment('Party shirt', 'shirt', { labels: ['Party'], color: 'black' })
    await h.garment('Office shirt', 'shirt', { labels: ['Office'], color: 'white' })
    await h.garment('Jeans', 'jeans', { labels: ['Party'], color: 'blue' })
    await event({ title: 'Birthday', kind: 'party', date: MON, occasion: 'Party' })
    expect(new Set(names(slot(await getPlan(1), 0, 'Birthday')))).toEqual(new Set(['Party shirt', 'Jeans']))

    await reset(h)
    const best = await h.garment('Wedding shirt', 'shirt')
    await h.garment('Spare shirt', 'shirt')
    await routine('Office', EVERY_DAY)
    await event({ title: 'Wedding', date: day(2), garment_ids: [best.id] })
    const plan = await getPlan(3)
    expect([0, 1].flatMap((d) => names(slot(plan, d, 'Office')))).not.toContain('Wedding shirt')
    expect(names(slot(plan, 2, 'Wedding'))).toEqual(['Wedding shirt'])
  })

  it('reports problems with a reserved outfit', async () => {
    const shirt = await h.garment('Wedding shirt', 'shirt')
    await h.basket('Later', [shirt.id], { scheduled_for: day(5) })
    await event({ title: 'Wedding', date: day(1), garment_ids: [shirt.id] })
    const s = slot(await getPlan(2), 1, 'Wedding')
    expect(s.problems[0]).toBe('Reserved outfit has a problem')
    expect(s.problems[1]).toContain("isn't back until")
  })

  it('saves, locks and partially re-plans', async () => {
    for (let i = 0; i < 5; i++) await h.garment(`Shirt ${i}`, 'shirt')
    await routine()
    let plan = await generate()
    expect(plan.has_plan).toBe(true)
    expect(plan.affected_dates).toEqual([])
    const mon = slot(plan, 0, 'Office')
    expect([mon.saved, mon.locked]).toEqual([true, false])
    const other = slot(plan, 4, 'Office').garments[0].id
    await h.svc.updateEntry(mon.entry_id!, { garment_ids: [other] })
    plan = await generate()
    const mon2 = slot(plan, 0, 'Office')
    expect([mon2.locked, mon2.garments[0].id]).toEqual([true, other])
    const all = [0, 1, 2, 3, 4].flatMap((d) => slot(plan, d, 'Office').garments.map((g) => g.id))
    expect(new Set(all).size).toBe(5)
  })

  it('flags days affected by a basket change', async () => {
    for (let i = 0; i < 3; i++) await h.garment(`Shirt ${i}`, 'shirt')
    await routine('Office', [0, 1, 2])
    let plan = await generate(3)
    const wed = slot(plan, 2, 'Office').garments[0]
    await h.basket('Oops', [wed.id])
    plan = await getPlan(3)
    expect(slot(plan, 2, 'Office').problems).toEqual([`${wed.name} will need washing first`, 'Missing 1 shirt'])
    expect(plan.affected_dates).toEqual([day(2)])
    expect((await generate(3, [day(2)])).affected_dates).toEqual([])
  })

  it('keeps reporting shortages on a saved plan', async () => {
    await h.garment('Shirt', 'shirt')
    await h.garment('Socks', 'socks')
    await routine('Office', WEEKDAYS, [{ category: 'shirt', quantity: 1 }, { category: 'socks', quantity: 1 }])
    const plan = await generate(2)
    const tue = slot(plan, 1, 'Office')
    expect(tue.saved).toBe(false)
    expect(tue.problems).toEqual(['Missing 1 shirt', 'Missing 1 socks'])
    expect(plan.affected_dates).toEqual([])
    expect(plan.issues.some((i) => i.message.includes('2 clean shirts needed'))).toBe(true)
    const mon = slot(plan, 0, 'Office')
    await h.svc.updateEntry(mon.entry_id!, { garment_ids: mon.garments.filter((g) => g.category === 'shirt').map((g) => g.id) })
    expect(slot(await getPlan(1), 0, 'Office').problems).toEqual(['Missing 1 socks'])
  })

  it('re-plans saved days when the calendar changes', async () => {
    await h.garment('Shirt', 'shirt', { max_wears_before_wash: 10 })
    await routine()
    await generate()
    await event({ title: 'Day off', kind: 'holiday', date: day(1) })
    const plan = await getPlan()
    expect(plan.days[1].slots).toEqual([])
    expect(plan.affected_dates).toEqual([])
  })

  it('wears a planned outfit (only today or earlier)', async () => {
    await h.garment('Shirt', 'shirt')
    await routine()
    const entry = slot(await generate(1), 0, 'Office')
    await h.svc.wearEntry(entry.entry_id!, MON)
    expect(await h.state(entry.garments[0].id)).toBe('needs_laundry')
    expect(slot(await getPlan(1), 0, 'Office').status).toBe('worn')
    expect((await failure(h.svc.wearEntry(entry.entry_id!, MON))).status).toBe(409)

    await reset(h)
    await h.garment('Shirt', 'shirt', { max_wears_before_wash: 10 })
    await routine()
    const tue = slot(await generate(2), 1, 'Office')
    expect((await failure(h.svc.wearEntry(tue.entry_id!, MON))).status).toBe(409)
  })
})

describe('laundry simulation', () => {
  it('compares washing a basket earlier', async () => {
    const a = await h.garment('Shirt A', 'shirt', { ironing_policy: 'not_required' })
    const b = await h.garment('Shirt B', 'shirt', { ironing_policy: 'not_required' })
    const t = await h.garment('Trousers', 'trousers')
    await h.svc.createPair({ name: 'A look', garment_ids: [a.id, t.id] })
    await h.svc.createPair({ name: 'B look', garment_ids: [b.id, t.id] })
    await routine('Office', EVERY_DAY)
    const basket = await h.basket('Whites', [a.id], { scheduled_for: day(3) })
    const out = await h.svc.simulate({ basket_id: basket.id, wash_on: MON, days: 4 }, MON)
    expect(out.returns_on).toBe(day(1))
    expect(out.pairs_possible.map((p) => p.name)).toEqual(['B look'])
    expect(out.pairs_blocked.map((p) => p.name)).toEqual(['A look'])
    expect(out.resolved_issues.length).toBeGreaterThan(0)
    expect(out.new_issues).toEqual([])
  })

  it('reports what becomes unavailable', async () => {
    const a = await h.garment('Shirt A', 'shirt')
    await h.garment('Shirt B', 'shirt')
    const out = await h.svc.simulate({ garment_ids: [a.id], wash_on: day(2) }, MON)
    expect(out.unavailable.map((g) => g.name)).toEqual(['Shirt A'])
    expect(out.returns_on).toBe(day(3))
    expect(out.scarce).toEqual(['Only 1 of your 2 shirt will be ready while this washes'])
    expect(out.preparation[0]).toBe('1 of these will need ironing after washing')
  })
})

describe('weather', () => {
  it('turns forecasts into tags', () => {
    expect(weather.tagsFor(32, 10, 5, 80)).toEqual(['Hot', 'Humid'])
    expect(weather.tagsFor(8, 70, 40, 90)).toEqual(['Cold', 'Rainy', 'Windy'])
    expect(weather.tagsFor(null, null, null, null)).toEqual([])
  })

  it('drives the plan; your own report wins', async () => {
    vi.spyOn(weather.http, 'getJson').mockResolvedValue({
      daily: {
        time: [day(0), day(1), day(2)],
        temperature_2m_max: [33, 10, 20], temperature_2m_min: [25, 2, 12], apparent_temperature_max: [35, 6, 20],
        precipitation_probability_max: [0, 80, 10], wind_speed_10m_max: [5, 10, 5], relative_humidity_2m_mean: [40, 60, 50],
      },
    })
    await h.svc.updateSettings({ location_name: 'Testville', latitude: 1, longitude: 2 })
    await h.garment('Linen shirt', 'shirt', { weather: ['Hot'], max_wears_before_wash: 10 })
    await h.garment('Flannel shirt', 'shirt', { weather: ['Cold'], max_wears_before_wash: 10 })
    await routine('Office', EVERY_DAY)
    await h.svc.reportWeather(day(2), ['cold', 'bogus'])
    const plan = await getPlan(3)
    expect(plan.location).toBe('Testville')
    expect(plan.days[0].weather).toEqual(['Hot'])
    expect(plan.days[1].weather).toEqual(['Cold', 'Rainy'])
    expect(plan.days[2].forecast?.tags).toEqual(['Mild'])
    expect(plan.days[2].weather).toEqual(['Cold'])
    expect(names(slot(plan, 0, 'Office'))).toEqual(['Linen shirt'])
    expect(names(slot(plan, 1, 'Office'))).toEqual(['Flannel shirt'])
  })

  it('keeps planning when the forecast fails', async () => {
    vi.spyOn(weather.http, 'getJson').mockRejectedValue(new Error('offline'))
    await h.svc.updateSettings({ latitude: 1, longitude: 2 })
    await h.garment('Shirt', 'shirt')
    await routine()
    const plan = await getPlan(1)
    expect(plan.weather_error).toBeTruthy()
    expect(slot(plan, 0, 'Office').garments.length).toBe(1)
  })
})

describe('coverage', () => {
  const coverage = () => h.svc.coverage(MON)
  const office = (weekdays = WEEKDAYS, req: Partial<Requirement> = {}) => routine('Office', weekdays, [{ category: 'shirt', quantity: 1, ...req }])

  it('needs routines', async () => {
    expect((await coverage()).status).toBe('none')
  })

  it('confirms a covered week', async () => {
    for (let i = 0; i < 5; i++) await h.garment(`Shirt ${i}`, 'shirt')
    await office()
    const c = await coverage()
    expect([c.status, c.days]).toEqual(['ok', 7])
    expect(c.headline).toBe("You're covered: your clean clothes meet every routine for the next 7 days.")
  })

  it('alerts with the first short day and a tested wash suggestion', async () => {
    const shirts = []
    for (let i = 0; i < 5; i++) shirts.push(await h.garment(`Shirt ${i}`, 'shirt'))
    await h.svc.wear([shirts[0].id, shirts[1].id], day(-3))
    await office()
    let c = await coverage()
    expect(c.status).toBe('alert')
    expect(c.headline).toBe("Not enough clean shirts: you'll run short from Thu 10 Jan.")
    expect(c.shortages).toEqual([{ routine: 'Office', category: 'shirt', required: 5, available: 3, missing: 2, first_short: day(3), mandatory: true }])
    const wash = c.suggestions.find((s) => s.kind === 'wash')!
    expect(wash.title).toBe('Wash 2 shirts on Wed 9 Jan')
    expect(new Set(wash.garment_ids)).toEqual(new Set([shirts[0].id, shirts[1].id]))
    expect(wash.detail).toContain('fixes 2 of 2')
    await h.svc.createBasket({ name: 'Fix', garment_ids: wash.garment_ids, scheduled_for: wash.wash_on })
    c = await coverage()
    expect([c.status, c.days, c.next_laundry]).toEqual(['ok', 7, day(3)])
  })

  it('extends the horizon to the next laundry', async () => {
    for (let i = 0; i < 12; i++) await h.garment(`Shirt ${i}`, 'shirt')
    await office(EVERY_DAY)
    const dirty = await h.garment('Dirty', 'shirt')
    await h.svc.wear([dirty.id], MON)
    await h.basket('Big wash', [dirty.id], { scheduled_for: day(10) })
    const c = await coverage()
    expect(c.days).toBe(12)
    expect(c.horizon).toBe("until 'Big wash' is back (Fri 18 Jan)")
    expect(c.status).toBe('ok')
  })

  it('suggests scheduling and stock', async () => {
    const a = await h.garment('Shirt A', 'shirt')
    await h.garment('Shirt B', 'shirt')
    await h.svc.wear([a.id], day(-1))
    const basket = await h.basket('Someday', [a.id])
    await office()
    const c = await coverage()
    expect(c.suggestions.map((s) => s.kind)).toEqual(['schedule', 'stock'])
    expect(c.suggestions[0].basket_id).toBe(basket.id)
    expect(c.stock[0]).toEqual({ routine: 'Office', category: 'shirt', needed: 6, owned: 2, ok: false, cycle_days: 8 })
  })

  it('uses laundry days for stock', async () => {
    for (let i = 0; i < 3; i++) await h.garment(`Shirt ${i}`, 'shirt')
    await h.garment('Shoes', 'shoes')
    await h.svc.updateSettings({ laundry_weekdays: [2, 5], drying_days: 1 })
    await routine('Office', WEEKDAYS, [{ category: 'shirt', quantity: 1 }, { category: 'shoes', quantity: 1, reuse: 'fixed' }])
    const stock = Object.fromEntries((await coverage()).stock.map((s) => [s.category, s]))
    expect([stock.shirt.cycle_days, stock.shirt.needed]).toEqual([5, 4])
    expect([stock.shoes.needed, stock.shoes.ok]).toEqual([1, true])
  })

  it('reaches the reminders', async () => {
    await h.garment('Only shirt', 'shirt')
    await office()
    const notes = await h.svc.notifications(MON)
    expect(notes[0].message.startsWith('Clothes alert: Not enough clean shirts')).toBe(true)
    expect(notes[0].link).toBe('/plan')
  })

  it('writes a brief from planner facts only', async () => {
    await h.garment("Dad's lucky shirt", 'shirt', { color: 'white' })
    await office()
    ai.setAiConfig({ apiKey: 'test', visionModel: ai.DEFAULT_VISION_MODEL, textModel: ai.DEFAULT_TEXT_MODEL })
    const sent: { messages: { content: string }[] }[] = []
    vi.spyOn(ai.transport, 'post').mockImplementation(async (body) => {
      sent.push(body as never)
      const content = JSON.stringify({ summary: 'Short on shirts this week.', bullets: ['Mon: white shirt'], tips: ['Wash on Wed', ''] })
      return { status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content } }] }) }
    })
    try {
      expect(await h.svc.brief(MON)).toEqual({ summary: 'Short on shirts this week.', bullets: ['Mon: white shirt'], tips: ['Wash on Wed'], status: 'alert' })
      const facts = sent[0].messages[1].content
      expect(facts).not.toContain('lucky')
      expect(facts).toContain('white shirt')
      expect(facts).toContain('Not enough clean shirts')
    } finally {
      ai.setAiConfig({ apiKey: null, visionModel: ai.DEFAULT_VISION_MODEL, textModel: ai.DEFAULT_TEXT_MODEL })
    }
  })
})
