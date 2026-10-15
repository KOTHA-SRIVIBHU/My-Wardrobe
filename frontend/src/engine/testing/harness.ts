// Shared test setup: a service over the real SQL (PGlite), wiped between tests.
import type { PGlite } from '@electric-sql/pglite'
import type { Basket, Garment } from '../../lib/types'
import { ApiError } from '../errors'
import { type GarmentInput, WardrobeService } from '../service'
import { clearWeatherCache } from '../weather'
import { request, startPg } from './pg'
import { PgBackend } from './pgBackend'

export const PASS = 'test vault passphrase'

export interface Harness {
  pg: PGlite
  backend: PgBackend
  svc: WardrobeService
  garment(name?: string, category?: string, extra?: Partial<GarmentInput>): Promise<Garment>
  basket(name?: string, garmentIds?: string[], extra?: Partial<Basket>): Promise<Basket>
  state(id: string): Promise<string>
}

export async function createHarness(): Promise<Harness> {
  const pg = await startPg()
  await request(pg, null, 'select closetiq_set_passphrase($1)', [PASS])
  const backend = new PgBackend(pg, PASS)
  const svc = new WardrobeService(backend)
  await svc.reload()
  return {
    pg,
    backend,
    svc,
    garment: (name = 'White shirt', category = 'shirt', extra = {}) => svc.createGarment({ name, category, ...extra }),
    basket: async (name = 'Monday Laundry', garmentIds = [], extra = {}) =>
      (await svc.createBasket({ name, garment_ids: garmentIds, ...extra })).basket,
    state: async (id) => (await svc.garment(id)).state,
  }
}

/** Fresh, empty vault for the next test. */
export async function reset(h: Harness): Promise<void> {
  await h.backend.wipe()
  h.svc.todayFn = () => new Date().toISOString().slice(0, 10)
  await h.svc.reload()
  clearWeatherCache()
}

/** The ApiError a promise rejects with (fails the test if it resolves). */
export async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p
  } catch (e) {
    if (e instanceof ApiError) return e
    throw e
  }
  throw new Error('expected the call to fail')
}
