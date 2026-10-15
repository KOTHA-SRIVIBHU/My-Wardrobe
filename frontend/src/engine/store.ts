// In-memory copy of the user's data, plus transactions that turn edits into a list of
// operations. The operations are sent to the database in one atomic call
// (closetiq_apply); only when that succeeds are they applied to this local copy.
import { TABLES, VERSIONED, type TableName, type Tables } from './rows'

export type Op =
  | { op: 'insert'; table: TableName; row: Record<string, unknown> }
  | { op: 'update'; table: TableName; id: string; set: Record<string, unknown>; rev?: number }
  | { op: 'delete'; table: TableName; id: string }

type AnyRow = { id: string } & Record<string, unknown>

export class Store {
  readonly tables: { [T in TableName]: Map<string, Tables[T]> }

  constructor() {
    this.tables = Object.fromEntries(TABLES.map((t) => [t, new Map()])) as Store['tables']
  }

  all<T extends TableName>(table: T): Tables[T][] {
    return [...this.tables[table].values()]
  }

  get<T extends TableName>(table: T, id: string): Tables[T] | undefined {
    return this.tables[table].get(id)
  }

  load<T extends TableName>(table: T, rows: Tables[T][]): void {
    const map = this.tables[table]
    map.clear()
    for (const r of rows) map.set(r.id, Object.freeze({ ...r }) as unknown as Tables[T])
  }
}

// Foreign keys, mirrored locally (the database does the same with ON DELETE).
const CASCADES: { parent: TableName; child: TableName; column: string; action: 'delete' | 'null' }[] = [
  { parent: 'garments', child: 'photos', column: 'garment_id', action: 'delete' },
  { parent: 'garments', child: 'pair_items', column: 'garment_id', action: 'delete' },
  { parent: 'garments', child: 'basket_items', column: 'garment_id', action: 'delete' },
  { parent: 'garments', child: 'garment_events', column: 'garment_id', action: 'delete' },
  { parent: 'pairs', child: 'pair_items', column: 'pair_id', action: 'delete' },
  { parent: 'pairs', child: 'garment_events', column: 'pair_id', action: 'null' },
  { parent: 'laundry_baskets', child: 'basket_items', column: 'basket_id', action: 'delete' },
  { parent: 'laundry_baskets', child: 'garment_events', column: 'basket_id', action: 'null' },
]

function deleteCascade(store: Store, table: TableName, id: string): void {
  if (!store.tables[table].delete(id)) return
  for (const c of CASCADES) {
    if (c.parent !== table) continue
    const map = store.tables[c.child] as unknown as Map<string, AnyRow>
    for (const row of [...map.values()]) {
      if (row[c.column] !== id) continue
      if (c.action === 'delete') deleteCascade(store, c.child, row.id)
      else map.set(row.id, Object.freeze({ ...row, [c.column]: null }))
    }
  }
}

/** Apply operations that the database has accepted to the local copy. */
export function applyOps(store: Store, ops: Op[]): void {
  for (const op of ops) {
    const map = store.tables[op.table] as unknown as Map<string, AnyRow>
    if (op.op === 'insert') {
      const row = { ...op.row } as AnyRow
      if (VERSIONED.has(op.table) && row.rev === undefined) row.rev = 0
      map.set(row.id, Object.freeze(row))
    } else if (op.op === 'update') {
      const cur = map.get(op.id)
      if (!cur) continue
      const next: AnyRow = { ...cur, ...op.set }
      if (VERSIONED.has(op.table)) next.rev = (cur.rev as number) + 1
      map.set(op.id, Object.freeze(next))
    } else {
      deleteCascade(store, op.table, op.id)
    }
  }
}

interface Draft {
  table: TableName
  original: AnyRow | null // null = inserted in this transaction
  row: AnyRow
  deleted: boolean
}

/**
 * A unit of work. Read with get/all/find; to change a row, get it with `edit()` (or
 * `get()`, which returns an editable draft) and assign fields. `ops()` produces the
 * minimal operations, in the order rows were first touched.
 */
export class Tx {
  private drafts = new Map<string, Draft>()
  private order: string[] = []

  constructor(private readonly store: Store) {}

  private key(table: TableName, id: string): string {
    return `${table}:${id}`
  }

  /** Editable draft of a row (undefined if it doesn't exist or was deleted). */
  get<T extends TableName>(table: T, id: string): Tables[T] | undefined {
    const k = this.key(table, id)
    const d = this.drafts.get(k)
    if (d) return d.deleted ? undefined : (d.row as unknown as Tables[T])
    const original = this.store.get(table, id) as unknown as AnyRow | undefined
    if (!original) return undefined
    const draft: Draft = { table, original, row: structuredClone(original) as AnyRow, deleted: false }
    this.drafts.set(k, draft)
    this.order.push(k)
    return draft.row as unknown as Tables[T]
  }

  edit<T extends TableName>(table: T, row: Tables[T]): Tables[T] {
    const draft = this.get(table, row.id)
    if (!draft) throw new Error(`${table} ${row.id} no longer exists`)
    return draft
  }

  /** Rows as they are in this transaction. Untouched rows are read-only. */
  all<T extends TableName>(table: T): Tables[T][] {
    const out: Tables[T][] = []
    for (const r of this.store.all(table)) {
      const d = this.drafts.get(this.key(table, r.id))
      if (!d) out.push(r)
      else if (!d.deleted) out.push(d.row as unknown as Tables[T])
    }
    for (const k of this.order) {
      const d = this.drafts.get(k)!
      if (d.table === table && d.original === null && !d.deleted) out.push(d.row as unknown as Tables[T])
    }
    return out
  }

  find<T extends TableName>(table: T, pred: (r: Tables[T]) => boolean): Tables[T] | undefined {
    return this.all(table).find(pred)
  }

  filter<T extends TableName>(table: T, pred: (r: Tables[T]) => boolean): Tables[T][] {
    return this.all(table).filter(pred)
  }

  insert<T extends TableName>(table: T, row: Tables[T]): Tables[T] {
    const k = this.key(table, row.id)
    const draft: Draft = { table, original: null, row: row as unknown as AnyRow, deleted: false }
    this.drafts.set(k, draft)
    this.order.push(k)
    return row
  }

  delete(table: TableName, id: string): void {
    const k = this.key(table, id)
    const d = this.drafts.get(k)
    if (d) {
      d.deleted = true
      // A delete happens when it's requested: after the changes made to dependent rows
      // so far (which its cascade would otherwise remove first).
      this.order = this.order.filter((x) => x !== k)
      this.order.push(k)
      return
    }
    const original = this.store.get(table, id) as unknown as AnyRow | undefined
    if (!original) return
    this.drafts.set(k, { table, original, row: { ...original }, deleted: true })
    this.order.push(k)
  }

  /**
   * Operations in the order rows were first touched. The rules always touch a row before
   * anything that depends on it, so this keeps the database's checks happy: a released
   * unique slot (basket item, plan entry) is freed before it's taken again, and a basket
   * is deleted only after the history rows that mention it are written.
   */
  ops(): Op[] {
    const out: Op[] = []
    for (const k of this.order) {
      const d = this.drafts.get(k)!
      if (d.original === null) {
        if (!d.deleted) out.push({ op: 'insert', table: d.table, row: { ...d.row } })
      } else if (d.deleted) {
        out.push({ op: 'delete', table: d.table, id: d.original.id })
      } else {
        const set: Record<string, unknown> = {}
        for (const [field, value] of Object.entries(d.row)) {
          if (field === 'rev') continue
          if (JSON.stringify(value) !== JSON.stringify(d.original[field])) set[field] = value
        }
        if (Object.keys(set).length) {
          const op: Op = { op: 'update', table: d.table, id: d.original.id, set }
          if (VERSIONED.has(d.table)) op.rev = d.original.rev as number
          out.push(op)
        }
      }
    }
    return out
  }
}

export const newId = (): string => crypto.randomUUID()
export const nowIso = (): string => new Date().toISOString()
