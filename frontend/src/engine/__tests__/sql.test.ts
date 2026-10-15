// The database script itself: passphrase protection, atomic changes, constraints.
import type { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'
import { rejects, request, startPg } from '../testing/pg'

const PASS = 'correct horse battery'
let pg: PGlite

const apply = (pass: string | null, ops: unknown[]) => request(pg, pass, 'select closetiq_apply($1::jsonb) as r', [JSON.stringify(ops)])
const status = async (pass: string | null) => (await request<{ s: Record<string, unknown> }>(pg, pass, 'select closetiq_status() as s'))[0].s

describe('closetiq.sql', () => {
  beforeAll(async () => {
    pg = await startPg()
  }, 60_000)

  it('can be run twice', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const sql = readFileSync(fileURLToPath(new URL('../../../../supabase/closetiq.sql', import.meta.url)), 'utf8')
    await pg.exec(sql)
  })

  it('sets the passphrase once, then requires it to change', async () => {
    expect(await status(null)).toEqual({ installed: true, schema_version: 1, has_passphrase: false, authorized: false })
    expect(await rejects(request(pg, null, `select closetiq_set_passphrase('short')`), 'at least 8')).toBe(true)
    await request(pg, null, 'select closetiq_set_passphrase($1)', [PASS])
    expect(await status(PASS)).toMatchObject({ has_passphrase: true, authorized: true })
    expect((await status('wrong passphrase'))!.authorized).toBe(false)
    expect(await rejects(request(pg, null, `select closetiq_set_passphrase('hijacked!!')`), 'current passphrase')).toBe(true)
    expect(await rejects(request(pg, PASS, 'select * from closetiq_meta'), 'permission')).toBe(true)
  })

  it('applies changes only with the passphrase, and reads only with it', async () => {
    const ops = [
      { op: 'insert', table: 'garments', row: { id: 'g1', name: 'Shirt', category: 'shirt', labels: ['Office'] } },
      { op: 'insert', table: 'laundry_baskets', row: { id: 'b1', name: 'Wash' } },
      { op: 'insert', table: 'basket_items', row: { id: 'i1', basket_id: 'b1', garment_id: 'g1', previous_state: 'ready' } },
    ]
    expect(await rejects(apply(null, ops), 'passphrase')).toBe(true)
    expect(await apply(PASS, ops)).toEqual([{ r: { applied: 3 } }])
    const rows = await request(pg, PASS, 'select id, labels, state, rev from garments')
    expect(rows).toEqual([{ id: 'g1', labels: ['Office'], state: 'ready', rev: 0 }])
    expect(await request(pg, null, 'select * from garments')).toEqual([])
    expect(await request(pg, 'nope nope nope', 'select * from garments')).toEqual([])
    expect(await rejects(request(pg, PASS, `insert into garments (id, name, category) values ('x','x','x')`), 'permission')).toBe(true)
    expect(await rejects(request(pg, PASS, `update garments set name = 'x'`), 'permission')).toBe(true)
  })

  it('detects changes made on another device (rev) and rolls back atomically', async () => {
    const upd = [{ op: 'update', table: 'garments', id: 'g1', set: { state: 'in_basket', total_wears: 2 }, rev: 0 }]
    await apply(PASS, upd)
    expect(await request(pg, PASS, `select state, total_wears, rev from garments where id = 'g1'`)).toEqual([
      { state: 'in_basket', total_wears: 2, rev: 1 },
    ])
    expect(await rejects(apply(PASS, upd), 'conflict')).toBe(true)

    const atomic = [
      { op: 'update', table: 'garments', id: 'g1', set: { name: 'Renamed' }, rev: 1 },
      { op: 'insert', table: 'basket_items', row: { id: 'i2', basket_id: 'b1', garment_id: 'g1', previous_state: 'ready' } },
    ]
    expect(await rejects(apply(PASS, atomic), 'one_active_basket')).toBe(true)
    expect((await request<{ name: string }>(pg, PASS, 'select name from garments'))[0].name).toBe('Shirt')
  })

  it('enforces one ironing basket and known tables', async () => {
    const two = [
      { op: 'insert', table: 'laundry_baskets', row: { id: 'ib1', name: 'Ironing', kind: 'ironing' } },
      { op: 'insert', table: 'laundry_baskets', row: { id: 'ib2', name: 'Ironing', kind: 'ironing' } },
    ]
    expect(await rejects(apply(PASS, two), 'one_ironing')).toBe(true)
    expect(await rejects(apply(PASS, [{ op: 'insert', table: 'closetiq_meta', row: {} }]), 'unknown table')).toBe(true)
  })

  it('cascades deletes, changes passphrase and wipes', async () => {
    await apply(PASS, [{ op: 'insert', table: 'settings', row: { id: 'me', laundry_weekdays: [5], drying_days: 2 } }])
    expect(await request(pg, PASS, 'select laundry_weekdays, drying_days from settings')).toEqual([{ laundry_weekdays: [5], drying_days: 2 }])
    await apply(PASS, [{ op: 'delete', table: 'garments', id: 'g1' }])
    expect(await request(pg, PASS, 'select count(*)::int as n from basket_items')).toEqual([{ n: 0 }])

    const NEW = 'a brand new passphrase'
    await request(pg, PASS, 'select closetiq_set_passphrase($1)', [NEW])
    expect((await status(PASS))!.authorized).toBe(false)
    expect((await status(NEW))!.authorized).toBe(true)

    expect(await rejects(request(pg, null, 'select closetiq_wipe()'), 'passphrase')).toBe(true)
    await request(pg, NEW, 'select closetiq_wipe()')
    expect(await request(pg, NEW, 'select (select count(*) from laundry_baskets) + (select count(*) from settings) as n')).toEqual([{ n: 0 }])
  })
})
