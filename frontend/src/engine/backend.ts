// Where the data lives. The app only ever: checks status, loads everything, applies an
// atomic list of operations, and fetches photos on demand.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { ApiError } from './errors'
import { TABLES, TIMESTAMP_COLUMNS, type TableName } from './rows'
import type { Op } from './store'

export interface VaultStatus {
  installed: boolean
  schema_version: number | null
  has_passphrase: boolean
  authorized: boolean
}

export type RawData = Record<TableName, Record<string, unknown>[]>

export interface Backend {
  status(): Promise<VaultStatus>
  setPassphrase(next: string): Promise<void>
  loadAll(): Promise<RawData>
  apply(ops: Op[]): Promise<void>
  loadPhotos(ids: string[]): Promise<Map<string, { mime: string; data: string }>>
  wipe(): Promise<void>
}

export const SCHEMA_VERSION = 1
export const PASSPHRASE_HEADER = 'x-closetiq-passphrase'

/** Turn a database error into something to show the user. */
export function mapDbError(e: { code?: string; message?: string } | null | undefined): ApiError {
  const msg = e?.message ?? 'Unknown database error'
  const code = e?.code ?? ''
  if (code === '40001' || msg.includes('conflict:')) {
    return new ApiError(409, 'This changed on another device. Your data was refreshed; please try again.', 'stale')
  }
  if (code === '28000') return new ApiError(401, 'The vault passphrase is wrong (it may have been changed on another device).', 'passphrase')
  if (code === '23505') return new ApiError(409, 'That change conflicts with another one. Refresh and try again.', 'integrity')
  if (code === '22023') return new ApiError(422, msg, 'invalid')
  if (code === 'PGRST202' || code === '42883') return new ApiError(503, 'The ClosetIQ setup script has not been run in this Supabase project yet.', 'not_installed')
  return new ApiError(500, msg, 'database')
}

/** Postgres/PostgREST timestamps ('...+00:00') -> ISO 'Z' strings; numbers stay numbers. */
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const k of Object.keys(out)) {
    const v = out[k]
    if (typeof v === 'string' && TIMESTAMP_COLUMNS.has(k)) out[k] = new Date(v).toISOString()
    if (k === 'purchase_price' && typeof v === 'string') out[k] = Number(v)
  }
  return out
}

const PAGE = 1000

export class SupabaseBackend implements Backend {
  private client: SupabaseClient

  constructor(url: string, anonKey: string, passphrase: string) {
    this.client = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: { [PASSPHRASE_HEADER]: passphrase } },
    })
  }

  async status(): Promise<VaultStatus> {
    const { data, error } = await this.client.rpc('closetiq_status')
    if (error) {
      if (error.code === 'PGRST202' || error.code === '42883' || /could not find the function/i.test(error.message)) {
        return { installed: false, schema_version: null, has_passphrase: false, authorized: false }
      }
      throw mapDbError(error)
    }
    return data as VaultStatus
  }

  async setPassphrase(next: string): Promise<void> {
    const { error } = await this.client.rpc('closetiq_set_passphrase', { new_passphrase: next })
    if (error) throw mapDbError(error)
  }

  private async loadTable(table: TableName): Promise<Record<string, unknown>[]> {
    const columns = table === 'photos' ? 'id,garment_id,mime,created_at' : '*'
    const rows: Record<string, unknown>[] = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await this.client.from(table).select(columns).order('id').range(from, from + PAGE - 1)
      if (error) throw mapDbError(error)
      rows.push(...(data as unknown as Record<string, unknown>[]))
      if (!data || data.length < PAGE) break
    }
    return rows.map(normalizeRow)
  }

  async loadAll(): Promise<RawData> {
    const results = await Promise.all(TABLES.map((t) => this.loadTable(t)))
    return Object.fromEntries(TABLES.map((t, i) => [t, results[i]])) as RawData
  }

  async apply(ops: Op[]): Promise<void> {
    if (!ops.length) return
    const { error } = await this.client.rpc('closetiq_apply', { ops })
    if (error) throw mapDbError(error)
  }

  async loadPhotos(ids: string[]): Promise<Map<string, { mime: string; data: string }>> {
    const out = new Map<string, { mime: string; data: string }>()
    for (let i = 0; i < ids.length; i += 20) {
      const { data, error } = await this.client.from('photos').select('id,mime,data').in('id', ids.slice(i, i + 20))
      if (error) throw mapDbError(error)
      for (const p of (data ?? []) as { id: string; mime: string; data: string }[]) out.set(p.id, { mime: p.mime, data: p.data })
    }
    return out
  }

  async wipe(): Promise<void> {
    const { error } = await this.client.rpc('closetiq_wipe')
    if (error) throw mapDbError(error)
  }
}
