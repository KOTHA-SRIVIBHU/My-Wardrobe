// Test harness: the real supabase/closetiq.sql running in PGlite (Postgres compiled to
// WebAssembly). `request()` mimics one Supabase API call: it runs as the `anon` role with
// the request headers set, inside its own transaction, exactly like PostgREST does.
import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SQL_PATH = fileURLToPath(new URL('../../../../supabase/closetiq.sql', import.meta.url))

export async function startPg(): Promise<PGlite> {
  const pg = await PGlite.create({ extensions: { pgcrypto } })
  // What every Supabase project already has. No default table grants: newer projects don't give
  // anon access to new tables, so the setup script must grant what it needs itself.
  await pg.exec(`
    create schema if not exists extensions;
    create role anon nologin;
    create role authenticated nologin;
    grant usage on schema public to anon, authenticated;
  `)
  await pg.exec(readFileSync(SQL_PATH, 'utf8'))
  return pg
}

export async function request<T = Record<string, unknown>>(
  pg: PGlite,
  passphrase: string | null,
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  return pg.transaction(async (tx) => {
    await tx.exec('set local role anon')
    const headers = passphrase ? { 'x-closetiq-passphrase': passphrase } : {}
    await tx.query(`select set_config('request.headers', $1, true)`, [JSON.stringify(headers)])
    const res = await tx.query<T>(query, params)
    return res.rows
  })
}

export async function rejects(promise: Promise<unknown>, contains: string): Promise<boolean> {
  try {
    await promise
    return false
  } catch (e) {
    return String((e as Error).message).toLowerCase().includes(contains.toLowerCase())
  }
}
