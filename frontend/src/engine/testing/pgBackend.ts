// A Backend over PGlite running the real closetiq.sql, used by the tests. Every call goes
// through the same SQL functions and row-level security as the app's Supabase calls.
import type { PGlite } from '@electric-sql/pglite'
import { type Backend, type RawData, type VaultStatus, mapDbError, normalizeRow } from '../backend'
import { TABLES } from '../rows'
import type { Op } from '../store'
import { request } from './pg'

export class PgBackend implements Backend {
  calls = 0
  constructor(
    private pg: PGlite,
    public passphrase: string,
  ) {}

  private async run<T = Record<string, unknown>>(query: string, params: unknown[] = []): Promise<T[]> {
    this.calls += 1
    try {
      return await request<T>(this.pg, this.passphrase, query, params)
    } catch (e) {
      throw mapDbError(e as { code?: string; message?: string })
    }
  }

  async status(): Promise<VaultStatus> {
    return (await this.run<{ s: VaultStatus }>('select closetiq_status() as s'))[0].s
  }

  async setPassphrase(next: string): Promise<void> {
    await this.run('select closetiq_set_passphrase($1)', [next])
  }

  async loadAll(): Promise<RawData> {
    const out: Partial<RawData> = {}
    for (const t of TABLES) {
      const cols = t === 'photos' ? 'id, garment_id, mime, created_at' : '*'
      const rows = await this.run<{ rows: Record<string, unknown>[] }>(
        `select coalesce(json_agg(x order by x.id), '[]'::json) as rows from (select ${cols} from ${t}) x`,
      )
      out[t] = rows[0].rows.map(normalizeRow)
    }
    return out as RawData
  }

  async apply(ops: Op[]): Promise<void> {
    if (!ops.length) return
    await this.run('select closetiq_apply($1::jsonb)', [JSON.stringify(ops)])
  }

  async loadPhotos(ids: string[]): Promise<Map<string, { mime: string; data: string }>> {
    const rows = await this.run<{ id: string; mime: string; data: string }>('select id, mime, data from photos where id = any($1)', [ids])
    return new Map(rows.map((r) => [r.id, { mime: r.mime, data: r.data }]))
  }

  async wipe(): Promise<void> {
    await this.run('select closetiq_wipe()')
  }
}
