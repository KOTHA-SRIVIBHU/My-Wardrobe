import { useMemo, useState } from 'react'
import { useMeta } from '../App'
import { capitalize, categoryTitle, groupByCategory } from '../lib/format'
import type { Garment } from '../lib/types'
import { GarmentThumb, StateBadge } from './ui'

/**
 * Multi-select list of garments. `disabledReason` returns why a garment can't be
 * picked (shown instead of a checkbox), or null if it can.
 */
export function GarmentPicker({
  garments,
  selected,
  onChange,
  disabledReason = () => null,
}: {
  garments: Garment[]
  selected: string[]
  onChange: (ids: string[]) => void
  disabledReason?: (g: Garment) => string | null
}) {
  const meta = useMeta()
  const [q, setQ] = useState('')
  const [category, setCategory] = useState('')
  const categories = useMemo(() => [...new Set(garments.map((g) => g.category))].sort(), [garments])
  const shown = garments.filter(
    (g) =>
      (!category || g.category === category) &&
      (!q || `${g.name} ${g.color ?? ''} ${g.labels.join(' ')}`.toLowerCase().includes(q.toLowerCase())),
  )
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id])

  return (
    <div>
      <div className="mb-2 flex gap-2">
        <input className="input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input max-w-40" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
          <option value="">All</option>
          {categories.map((c) => (
            <option key={c} value={c}>{capitalize(c)}</option>
          ))}
        </select>
      </div>
      <p className="mb-2 text-xs text-slate-500">{selected.length} selected</p>
      <div className="max-h-80 overflow-y-auto rounded-lg border border-slate-200">
        {shown.length === 0 && <p className="px-3 py-6 text-center text-sm text-slate-500">No garments match.</p>}
        {groupByCategory(shown, meta.categories.map((c) => c.value)).map(({ category: cat, items }) => (
          <div key={cat}>
            <h3 className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold tracking-wide text-slate-600 uppercase">
              {categoryTitle(cat)} <span className="font-normal text-slate-400">({items.length})</span>
            </h3>
            <ul className="divide-y divide-slate-100">
              {items.map((g) => {
                const reason = disabledReason(g)
                const isOn = selected.includes(g.id)
                return (
                  <li key={g.id}>
                    <label className={`flex items-center gap-3 px-3 py-2 ${reason ? 'opacity-60' : 'cursor-pointer hover:bg-slate-50'}`}>
                      <input type="checkbox" checked={isOn} disabled={!!reason && !isOn} onChange={() => toggle(g.id)} className="h-4 w-4 accent-indigo-600" />
                      <GarmentThumb garment={g} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-slate-900">{g.name}</span>
                        <span className="block truncate text-xs text-slate-500">{reason ?? ([g.subcategory, g.color].filter(Boolean).join(' · ') || ' ')}</span>
                      </span>
                      <StateBadge state={g.state} />
                    </label>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  )
}
