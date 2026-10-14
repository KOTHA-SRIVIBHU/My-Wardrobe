import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMeta } from '../App'
import { GarmentForm } from '../components/GarmentForm'
import { Icon } from '../components/Icon'
import { ColorSwatch, Empty, ErrorBanner, GarmentThumb, Modal, Notice, PageHeader, Spinner, StateDot } from '../components/ui'
import { api } from '../lib/api'
import { capitalize, categoryTitle, fmtDate, groupByCategory, localToday, plural, useLoad } from '../lib/format'
import type { Garment, GarmentState } from '../lib/types'

const STATE_FILTERS: { key: string; label: string; states: GarmentState[] }[] = [
  { key: 'all', label: 'All', states: [] },
  { key: 'ready', label: 'Ready', states: ['ready', 'worn_reusable'] },
  { key: 'dirty', label: 'Needs wash', states: ['needs_laundry'] },
  { key: 'laundry', label: 'In laundry', states: ['in_basket', 'in_laundry', 'drying'] },
  { key: 'iron', label: 'To iron', states: ['needs_ironing'] },
  { key: 'away', label: 'Reserved / away', states: ['reserved', 'unavailable'] },
]

/** A small localStorage-backed preference (falls back to memory if storage is blocked). */
function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* not persisted */
    }
  }, [key, value])
  return [value, setValue]
}

export default function Wardrobe() {
  const meta = useMeta()
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const [stateFilter, setStateFilter] = useState('all')
  const [label, setLabel] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [view, setView] = usePref<'grid' | 'list'>('wardrobe.view', 'grid')
  const [collapsed, setCollapsed] = usePref<string[]>('wardrobe.collapsed', [])
  const [selected, setSelected] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [basketPicker, setBasketPicker] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notices, setNotices] = useState<string[]>([])

  // Load once and filter in the browser: instant filters and accurate counts.
  const garments = useLoad(() => api.garments({ include_archived: showArchived }), [showArchived])
  const all = garments.data ?? []
  const labels = useMemo(
    () => [...new Set(all.flatMap((g) => g.labels))].sort((a, b) => a.localeCompare(b)),
    [all],
  )
  const categories = useMemo(() => [...new Set(all.map((g) => g.category))], [all])

  const matchesText = (g: Garment) =>
    (!q || [g.name, g.category, g.subcategory, g.color, g.pattern, ...g.labels].join(' ').toLowerCase().includes(q.toLowerCase())) &&
    (!category || g.category === category) &&
    (!label || g.labels.some((l) => l.toLowerCase() === label.toLowerCase()))
  const base = all.filter(matchesText)
  const activeFilter = STATE_FILTERS.find((f) => f.key === stateFilter)!
  const shown = activeFilter.states.length ? base.filter((g) => activeFilter.states.includes(g.state)) : base
  const counts = Object.fromEntries(
    STATE_FILTERS.map((f) => [f.key, f.states.length ? base.filter((g) => f.states.includes(g.state)).length : base.length]),
  )
  const readyCount = all.filter((g) => g.wearable).length

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))

  async function bulk(action: () => Promise<unknown>, done: string) {
    setError(null)
    try {
      await action()
      setNotices([done])
      setSelected([])
      garments.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const filtersActive = q || category || label || stateFilter !== 'all'

  return (
    <div className="pb-20">
      <PageHeader
        title="Wardrobe"
        subtitle={garments.data ? `${plural(all.filter((g) => !g.archived).length, 'garment')} · ${readyCount} ready to wear` : undefined}
        actions={
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <Icon name="plus" className="h-4 w-4" /> Add garment
          </button>
        }
      />

      <div className="card mb-3 flex flex-wrap items-center gap-2 p-2">
        <label className="relative min-w-48 flex-1">
          <span className="sr-only">Search</span>
          <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input className="input border-transparent bg-slate-50 pl-9" placeholder="Search name, colour, label…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <select className="input w-auto" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {categories.sort().map((c) => (
            <option key={c} value={c}>{capitalize(c)}</option>
          ))}
        </select>
        {labels.length > 0 && (
          <select className="input w-auto" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label">
            <option value="">Any label</option>
            {labels.map((l) => (
              <option key={l} value={l}>{l}</option>
            ))}
          </select>
        )}
        <label className="flex items-center gap-1.5 px-2 text-sm text-slate-600">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} className="accent-indigo-600" />
          Archived
        </label>
        <div className="ml-auto flex rounded-lg bg-slate-100 p-0.5" role="group" aria-label="View">
          {(['grid', 'list'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-pressed={view === v}
              aria-label={v === 'grid' ? 'Grid view' : 'List view'}
              className={`rounded-md p-1.5 ${view === v ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
            >
              <Icon name={v} className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>

      <div className="mb-5 flex gap-1.5 overflow-x-auto pb-1">
        {STATE_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setStateFilter(f.key)}
            aria-pressed={stateFilter === f.key}
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-sm font-medium transition ${stateFilter === f.key ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'}`}
          >
            {f.label}
            <span className={`rounded-full px-1.5 text-xs tabular-nums ${stateFilter === f.key ? 'bg-white/20' : 'bg-slate-100 text-slate-500'}`}>{counts[f.key]}</span>
          </button>
        ))}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-xs text-slate-500">
          <span className="h-3 w-3 rounded-sm bg-amber-100 ring-2 ring-amber-300" /> worn since last wash
        </span>
      </div>

      <ErrorBanner message={error ?? garments.error} onDismiss={() => setError(null)} />
      <Notice messages={notices} onDismiss={() => setNotices([])} />

      {garments.loading && !garments.data ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <Empty>
          {filtersActive ? 'No garments match these filters.' : 'Your wardrobe is empty. Add your first garment to get started.'}
        </Empty>
      ) : (
        <div className="space-y-6">
          {groupByCategory(shown, meta.categories.map((c) => c.value)).map(({ category: cat, items }) => {
            const ready = items.filter((g) => g.wearable).length
            const selectable = items.filter((g) => !g.archived).map((g) => g.id)
            const allSelected = selectable.length > 0 && selectable.every((id) => selected.includes(id))
            const isCollapsed = collapsed.includes(cat)
            return (
              <section key={cat} aria-labelledby={`cat-${cat}`}>
                <div className="mb-2.5 flex items-center gap-3">
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => setCollapsed(isCollapsed ? collapsed.filter((c) => c !== cat) : [...collapsed, cat])}
                    aria-expanded={!isCollapsed}
                  >
                    <Icon name="right" className={`h-4 w-4 text-slate-400 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} />
                    <h2 id={`cat-${cat}`} className="font-semibold">{categoryTitle(cat)}</h2>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 tabular-nums">
                      {ready}/{items.length} ready
                    </span>
                  </button>
                  {selectable.length > 0 && !isCollapsed && (
                    <label className="flex items-center gap-1.5 text-xs text-slate-500">
                      <input
                        type="checkbox"
                        className="accent-indigo-600"
                        checked={allSelected}
                        onChange={() =>
                          setSelected(allSelected ? selected.filter((id) => !selectable.includes(id)) : [...new Set([...selected, ...selectable])])
                        }
                      />
                      Select all
                    </label>
                  )}
                </div>
                {!isCollapsed &&
                  (view === 'grid' ? (
                    <ul className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7">
                      {items.map((g) => (
                        <GarmentCard key={g.id} g={g} selected={selected.includes(g.id)} selecting={selected.length > 0} onToggle={() => toggle(g.id)} />
                      ))}
                    </ul>
                  ) : (
                    <GarmentTable items={items} selected={selected} onToggle={toggle} />
                  ))}
              </section>
            )
          })}
        </div>
      )}

      {selected.length > 0 && (
        <div className="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
          <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-slate-900 px-3 py-2 text-white shadow-xl">
            <span className="px-2 text-sm font-medium">{selected.length} selected</span>
            <BarButton onClick={() => bulk(() => api.wear(selected, localToday()), 'Marked as worn today.')}>Wore today</BarButton>
            <BarButton onClick={() => setBasketPicker(true)}>Add to basket…</BarButton>
            <BarButton onClick={() => bulk(() => api.needsIroning(selected), 'Moved to the ironing basket.')}>Needs ironing</BarButton>
            <BarButton onClick={() => bulk(() => api.ironed(selected), 'Marked as ironed.')}>Ironed</BarButton>
            <button className="rounded-lg px-2 py-1.5 text-sm text-slate-300 hover:text-white" onClick={() => setSelected([])} aria-label="Clear selection">
              ✕
            </button>
          </div>
        </div>
      )}

      {adding && (
        <GarmentForm
          meta={meta}
          labels={labels}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            garments.reload()
          }}
        />
      )}
      {basketPicker && (
        <AddToBasket
          garmentIds={selected}
          onClose={() => setBasketPicker(false)}
          onDone={(warnings, name) => {
            setBasketPicker(false)
            setSelected([])
            setNotices([`Added to ${name}.`, ...warnings])
            garments.reload()
          }}
        />
      )}
    </div>
  )
}

function BarButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button className="rounded-lg bg-white/10 px-3 py-1.5 text-sm font-medium hover:bg-white/20" onClick={onClick}>
      {children}
    </button>
  )
}

/** Worn at least once since its last wash, but still wearable ("Worn — Reusable"). */
export const isUsed = (g: Garment) => !g.archived && g.state === 'worn_reusable'

export function wearCount(g: Garment): string {
  return g.max_wears_before_wash ? `${g.wears_since_wash}/${g.max_wears_before_wash}` : `${g.wears_since_wash}×`
}

function GarmentCard({ g, selected, selecting, onToggle }: { g: Garment; selected: boolean; selecting: boolean; onToggle: () => void }) {
  const used = isUsed(g)
  const notReady = !g.archived && !g.wearable
  const frame = selected
    ? 'border-indigo-500 ring-2 ring-indigo-500 bg-white'
    : used
      ? 'border-amber-300 bg-amber-50 ring-2 ring-amber-200/80 shadow-amber-200/70 shadow-md'
      : 'border-slate-200 bg-white'
  return (
    <li className="group relative">
      <Link
        to={`/garments/${g.id}`}
        className={`block overflow-hidden rounded-xl border shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${frame} ${g.archived ? 'opacity-60' : ''}`}
      >
        <div className={`relative ${notReady ? 'opacity-75 saturate-50' : ''}`}>
          <GarmentThumb garment={g} size="card" />
          {used && (
            <span
              className="absolute top-1.5 right-1.5 rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-semibold text-amber-950 shadow-sm"
              title={g.max_wears_before_wash ? `Worn ${g.wears_since_wash} of ${g.max_wears_before_wash} times before it needs washing` : `Worn ${g.wears_since_wash} times since washing`}
            >
              {wearCount(g)}
            </span>
          )}
          {g.active_basket && (
            <span className="absolute right-1.5 bottom-1.5 rounded-md bg-white/90 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 shadow-sm">
              {g.active_basket.kind === 'ironing' ? '♨ Ironing' : '🧺 Basket'}
            </span>
          )}
          {g.archived && <span className="absolute bottom-1.5 left-1.5 rounded bg-black/60 px-1.5 text-[10px] text-white">Archived</span>}
        </div>
        <div className="px-2 py-1.5">
          <p className="truncate text-xs font-medium text-slate-900" title={g.name}>{g.name}</p>
          <div className="mt-0.5 flex items-center justify-between gap-1">
            <StateDot state={g.state} />
            <span className="flex items-center gap-1 text-[10px] text-slate-400" title={`${g.total_wears} wears`}>
              <ColorSwatch color={g.color} />
              {g.total_wears > 0 && `${g.total_wears}×`}
            </span>
          </div>
        </div>
      </Link>
      {!g.archived && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${g.name}`}
          className={`absolute top-1.5 left-1.5 h-4 w-4 cursor-pointer accent-indigo-600 transition ${selecting || selected ? 'opacity-100' : 'opacity-60 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100'}`}
        />
      )}
    </li>
  )
}

function GarmentTable({ items, selected, onToggle }: { items: Garment[]; selected: string[]; onToggle: (id: string) => void }) {
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-100 text-left text-xs text-slate-500">
            <th className="w-8 py-2 pl-3" />
            <th className="py-2 font-medium">Garment</th>
            <th className="hidden py-2 font-medium sm:table-cell">Colour</th>
            <th className="py-2 font-medium">Status</th>
            <th className="hidden py-2 text-right font-medium md:table-cell">Wears</th>
            <th className="hidden py-2 pr-3 text-right font-medium md:table-cell">Last worn</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((g) => (
            <tr key={g.id} className={`${isUsed(g) ? 'bg-amber-50 hover:bg-amber-100/70' : 'hover:bg-slate-50'} ${g.archived ? 'opacity-60' : ''}`}>
              <td className="py-1.5 pl-3">
                {!g.archived && (
                  <input type="checkbox" className="accent-indigo-600" checked={selected.includes(g.id)} onChange={() => onToggle(g.id)} aria-label={`Select ${g.name}`} />
                )}
              </td>
              <td className="py-1.5">
                <Link to={`/garments/${g.id}`} className="flex items-center gap-2.5 hover:text-indigo-700">
                  <GarmentThumb garment={g} size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{g.name}</span>
                    {g.subcategory && <span className="block truncate text-xs text-slate-500">{g.subcategory}</span>}
                  </span>
                </Link>
              </td>
              <td className="hidden py-1.5 sm:table-cell">
                <span className="flex items-center gap-1.5 text-slate-600">
                  <ColorSwatch color={g.color} />
                  {g.color ?? '—'}
                </span>
              </td>
              <td className="py-1.5">
                <StateDot state={g.state} />
              </td>
              <td className="hidden py-1.5 text-right text-slate-600 tabular-nums md:table-cell">
                {g.wears_since_wash}
                {g.max_wears_before_wash ? `/${g.max_wears_before_wash}` : ''} · {g.total_wears}
              </td>
              <td className="hidden py-1.5 pr-3 text-right text-slate-600 md:table-cell">{fmtDate(g.last_worn_on)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Pick an open basket (or create one) for a set of garments. */
export function AddToBasket({
  garmentIds,
  onClose,
  onDone,
}: {
  garmentIds: string[]
  onClose: () => void
  onDone: (warnings: string[], basketName: string) => void
}) {
  const baskets = useLoad(() => api.baskets(), [])
  const open = (baskets.data ?? []).filter((b) => b.status !== 'completed' && b.kind !== 'ironing')
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function addTo(id: string, name: string) {
    try {
      const r = await api.addToBasket(id, garmentIds)
      onDone(r.warnings, name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  async function createAndAdd() {
    try {
      const r = await api.createBasket({ name: newName.trim(), garment_ids: garmentIds })
      onDone(r.warnings, r.basket.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal title={`Add ${plural(garmentIds.length, 'garment')} to a laundry basket`} onClose={onClose}>
      <ErrorBanner message={error ?? baskets.error} />
      {baskets.loading ? (
        <Spinner />
      ) : (
        <ul className="mb-4 space-y-2">
          {open.length === 0 && <li className="text-sm text-slate-500">No open laundry baskets yet.</li>}
          {open.map((b) => (
            <li key={b.id}>
              <button className="card flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50" onClick={() => addTo(b.id, b.name)}>
                <span>
                  <span className="block text-sm font-medium">{b.name}</span>
                  <span className="text-xs text-slate-500">
                    {plural(b.garment_count, 'garment')}
                    {b.status === 'in_progress' ? ' · in progress' : ''}
                    {b.scheduled_for ? ` · ${fmtDate(b.scheduled_for)}` : ''}
                  </span>
                </span>
                <span className="text-indigo-600">Add →</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <input className="input" placeholder="New basket name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button className="btn btn-primary" disabled={!newName.trim()} onClick={createAndAdd}>
          Create
        </button>
      </div>
    </Modal>
  )
}
