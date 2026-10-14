import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAi, useMeta } from '../App'
import { Chip, ErrorBanner, GarmentThumb, Spinner } from '../components/ui'
import { api, downloadBackup } from '../lib/api'
import { supabase } from '../lib/auth'
import { addDays, capitalize, categoryTitle, fmtDate, fmtDateTime, localToday, useLoad } from '../lib/format'
import type { Analytics, PackingResult, PurchaseResult } from '../lib/types'

const TABS = ['Stats', 'Declutter', 'Pack for a trip', 'Before you buy', 'Account'] as const
type Tab = (typeof TABS)[number]

export default function Insights() {
  const [tab, setTab] = useState<Tab>('Stats')
  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Insights</h1>
      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium whitespace-nowrap ${tab === t ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === 'Stats' && <Stats />}
      {tab === 'Declutter' && <Declutter />}
      {tab === 'Pack for a trip' && <Packing />}
      {tab === 'Before you buy' && <BeforeYouBuy />}
      {tab === 'Account' && <Backup />}
    </div>
  )
}

// --- Stats ------------------------------------------------------------------------

function Stats() {
  const [days, setDays] = useState(90)
  const today = localToday()
  const a = useLoad(() => api.analytics(days, today), [days, today])
  if (a.loading && !a.data) return <Spinner />
  if (!a.data) return <ErrorBanner message={a.error} />
  const d: Analytics = a.data
  const maxWeek = Math.max(1, ...d.weekly_wears.map((w) => w.wears))

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-600">Period:</span>
        {[30, 90, 365].map((n) => (
          <Chip key={n} on={days === n} onClick={() => setDays(n)}>
            {n === 365 ? '1 year' : `${n} days`}
          </Chip>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Ready to wear" value={`${d.garments_ready} / ${d.garments_total}`} />
        <Tile label="Wears logged" value={d.wears_in_period} />
        <Tile label="Laundry runs" value={d.laundry_runs} hint={d.last_laundry ? `last ${fmtDateTime(d.last_laundry)}` : undefined} />
        <Tile label="Never worn" value={d.never_worn} />
      </div>

      <section className="card p-4">
        <h2 className="mb-3 text-sm font-semibold">Wears per week</h2>
        <div className="flex h-32 items-end gap-1.5" role="img" aria-label="Wears per week for the last 12 weeks">
          {d.weekly_wears.map((w) => (
            <div key={w.week} className="flex flex-1 flex-col items-center justify-end gap-1" title={`Week of ${fmtDate(w.week)}: ${w.wears} wears`}>
              <span className="text-[10px] text-slate-500 tabular-nums">{w.wears || ''}</span>
              <div className="w-full rounded-t bg-indigo-500" style={{ height: `${(w.wears / maxWeek) * 100}%`, minHeight: w.wears ? 2 : 0 }} />
            </div>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-slate-500">
          <span>{fmtDate(d.weekly_wears[0]?.week ?? null)}</span>
          <span>this week</span>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <StatList title="Most worn" items={d.most_worn} unit="wears" empty="No wears logged in this period." />
        <StatList title="Least worn" items={d.least_worn} unit="wears" empty="—" />
        <StatList
          title="Highest cost per wear"
          items={d.cost_per_wear}
          unit="per wear"
          empty="Add purchase prices to garments to see cost per wear."
          footer={d.average_cost_per_wear !== null ? `Average: ${d.average_cost_per_wear.toFixed(2)} per wear` : undefined}
        />
        <section className="card p-4">
          <h2 className="mb-2 text-sm font-semibold">Repeated outfits</h2>
          {d.repeated_outfits.length === 0 ? (
            <p className="text-sm text-slate-500">No outfit worn more than once in this period.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {d.repeated_outfits.map((r, i) => (
                <li key={i} className="flex justify-between gap-3">
                  <span className="truncate">{r.garments.join(' + ')}</span>
                  <span className="shrink-0 text-slate-500 tabular-nums">{r.times}×</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card p-4">
        <h2 className="mb-2 text-sm font-semibold">By category</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="py-1 font-medium">Category</th>
              <th className="py-1 text-right font-medium">Owned</th>
              <th className="py-1 text-right font-medium">Ready</th>
              <th className="py-1 text-right font-medium">Wears</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {Object.entries(d.categories).map(([c, v]) => (
              <tr key={c} className={d.shortages.includes(c) ? 'text-red-700' : ''}>
                <td className="py-1.5">{categoryTitle(c)}</td>
                <td className="py-1.5 text-right tabular-nums">{v.total}</td>
                <td className="py-1.5 text-right tabular-nums">{v.ready}</td>
                <td className="py-1.5 text-right tabular-nums">{v.wears}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.awaiting_ironing > 0 && <p className="mt-2 text-sm text-amber-800">{d.awaiting_ironing} garment(s) waiting to be ironed.</p>}
      </section>
    </div>
  )
}

function Tile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  )
}

function StatList({
  title,
  items,
  unit,
  empty,
  footer,
}: {
  title: string
  items: { id: string; name: string; value: number }[]
  unit: string
  empty: string
  footer?: string
}) {
  return (
    <section className="card p-4">
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {items.map((i) => (
            <li key={i.id} className="flex justify-between gap-3">
              <Link to={`/garments/${i.id}`} className="truncate hover:text-indigo-700">{i.name}</Link>
              <span className="shrink-0 text-slate-500 tabular-nums">
                {unit === 'per wear' ? i.value.toFixed(2) : i.value} {unit}
              </span>
            </li>
          ))}
        </ul>
      )}
      {footer && <p className="mt-2 text-xs text-slate-500">{footer}</p>}
    </section>
  )
}

// --- Declutter ------------------------------------------------------------------------

function Declutter() {
  const today = localToday()
  const a = useLoad(() => api.analytics(90, today), [today])
  const [done, setDone] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)

  async function retire(id: string, reason: string, label: string) {
    try {
      await api.archive(id, reason)
      setDone((d) => ({ ...d, [id]: label }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (a.loading && !a.data) return <Spinner />
  if (!a.data) return <ErrorBanner message={a.error} />
  const items = a.data.declutter
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Clothes you've owned for 2+ months but haven't worn in the last 3. Archiving keeps their history but takes them out of plans and suggestions.
      </p>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      {items.length === 0 ? (
        <p className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">✓ Everything you own has been worn recently. Nice!</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {items.map((g) => (
            <li key={g.id} className="card flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <Link to={`/garments/${g.id}`} className="block truncate font-medium hover:text-indigo-700">{g.name}</Link>
                <p className="text-xs text-slate-500">
                  {categoryTitle(g.category)} · {g.never_worn ? `never worn (${g.idle_days} days)` : `last worn ${fmtDate(g.last_worn_on)} (${g.idle_days} days ago)`}
                </p>
              </div>
              {done[g.id] ? (
                <span className="text-sm text-emerald-700">✓ {done[g.id]}</span>
              ) : (
                <div className="flex gap-1.5">
                  <button className="btn btn-secondary px-2 py-1 text-xs" onClick={() => retire(g.id, 'archived', 'Archived')}>Archive</button>
                  <button className="btn btn-secondary px-2 py-1 text-xs" onClick={() => retire(g.id, 'donated', 'Donated')}>Donated</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// --- Packing --------------------------------------------------------------------------

function Packing() {
  const meta = useMeta()
  const today = localToday()
  const [start, setStart] = useState(addDays(today, 1))
  const [nights, setNights] = useState(3)
  const [activities, setActivities] = useState<string[]>([])
  const [laundry, setLaundry] = useState(false)
  const [result, setResult] = useState<PackingResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [packed, setPacked] = useState<string[]>([])

  async function run() {
    setBusy(true)
    setError(null)
    try {
      setResult(await api.packing({ start, nights, activities, laundry_available: laundry }, today))
      setPacked([])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="card grid gap-3 p-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="p-start">Leaving on</label>
          <input id="p-start" type="date" className="input" min={today} value={start} onChange={(e) => setStart(e.target.value || today)} />
        </div>
        <div>
          <label className="label" htmlFor="p-nights">Nights away</label>
          <input id="p-nights" type="number" min={0} max={30} className="input" value={nights} onChange={(e) => setNights(Math.max(0, Math.min(30, Number(e.target.value) || 0)))} />
        </div>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" className="accent-indigo-600" checked={laundry} onChange={(e) => setLaundry(e.target.checked)} />
          I can do laundry there
        </label>
        <div className="sm:col-span-3">
          <span className="label">Activities</span>
          <div className="flex flex-wrap gap-1.5">
            {meta.occasions.map((o) => (
              <Chip key={o} on={activities.includes(o)} onClick={() => setActivities(activities.includes(o) ? activities.filter((x) => x !== o) : [...activities, o])}>
                {o}
              </Chip>
            ))}
          </div>
        </div>
        <div className="sm:col-span-3">
          <button className="btn btn-primary" disabled={busy} onClick={run}>
            {busy ? 'Packing…' : 'Make packing list'}
          </button>
          <span className="ml-3 text-xs text-slate-500">Uses your plan-settings location for the forecast.</span>
        </div>
      </div>
      <ErrorBanner message={error} />
      {result && (
        <div className="space-y-3">
          {result.notes.map((n) => (
            <p key={n} className="text-sm text-slate-600">{n}</p>
          ))}
          {result.sections.map((s) => (
            <section key={s.title} className="card p-4">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <h3 className="font-semibold">{s.title}</h3>
                <span className="text-xs text-slate-500">
                  {s.garments.length} of {s.needed}
                </span>
              </div>
              {s.shortfall && <p className="mb-2 text-sm text-amber-800">{s.shortfall}</p>}
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {s.garments.map((g) => (
                  <li key={g.id}>
                    <label className={`flex items-center gap-2 text-sm ${packed.includes(g.id) ? 'text-slate-400 line-through' : ''}`}>
                      <input
                        type="checkbox"
                        className="accent-indigo-600"
                        checked={packed.includes(g.id)}
                        onChange={() => setPacked(packed.includes(g.id) ? packed.filter((x) => x !== g.id) : [...packed, g.id])}
                      />
                      <GarmentThumb garment={g} size="sm" />
                      {g.name}
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

// --- Before you buy -----------------------------------------------------------------

function BeforeYouBuy() {
  const meta = useMeta()
  const [category, setCategory] = useState('trousers')
  const [color, setColor] = useState('')
  const [pattern, setPattern] = useState('')
  const [formality, setFormality] = useState('')
  const [result, setResult] = useState<PurchaseResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function run() {
    setError(null)
    try {
      setResult(
        await api.purchase(
          { category, color: color || null, pattern: pattern || null, formality: formality ? Number(formality) : null },
          localToday(),
        ),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">Thinking of buying something? See how it would fit with what you already own.</p>
      <div className="card grid gap-3 p-4 sm:grid-cols-4">
        <div>
          <label className="label" htmlFor="b-cat">Category</label>
          <select id="b-cat" className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            {meta.categories.map((c) => (
              <option key={c.value} value={c.value}>{capitalize(c.value)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="b-color">Colour</label>
          <input id="b-color" className="input" value={color} onChange={(e) => setColor(e.target.value)} placeholder="navy" />
        </div>
        <div>
          <label className="label" htmlFor="b-pattern">Pattern</label>
          <select id="b-pattern" className="input" value={pattern} onChange={(e) => setPattern(e.target.value)}>
            <option value="">Any</option>
            {meta.patterns.map((p) => (
              <option key={p} value={p}>{capitalize(p)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="b-form">Formality</label>
          <select id="b-form" className="input" value={formality} onChange={(e) => setFormality(e.target.value)}>
            <option value="">Not sure</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-4">
          <button className="btn btn-primary" onClick={run}>Check it</button>
        </div>
      </div>
      <ErrorBanner message={error} />
      {result && (
        <div className="card space-y-3 p-4">
          <p className="font-medium">{result.verdict}</p>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <p className="text-2xl font-semibold tabular-nums">{result.new_outfits}</p>
              <p className="text-xs text-slate-500">new outfits</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums">{result.strong_outfits}</p>
              <p className="text-xs text-slate-500">strong matches</p>
            </div>
            <div>
              <p className="text-2xl font-semibold tabular-nums">{result.category_owned}</p>
              <p className="text-xs text-slate-500">already owned in this category</p>
            </div>
          </div>
          {result.examples.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-semibold">It would go with</h3>
              <ul className="text-sm text-slate-700">
                {result.examples.map((e, i) => (
                  <li key={i}>• {e.garments.join(' + ')} <span className="text-slate-400">({e.score})</span></li>
                ))}
              </ul>
            </div>
          )}
          {result.similar_owned.length > 0 && (
            <p className="text-sm text-amber-800">Similar items you own: {result.similar_owned.join(', ')}</p>
          )}
        </div>
      )}
    </div>
  )
}

// --- Backup ---------------------------------------------------------------------------

function Backup() {
  const ai = useAi()
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [email, setEmail] = useState<string | null>(null)
  useEffect(() => {
    supabase?.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null))
  }, [])

  async function exportNow() {
    setBusy(true)
    setError(null)
    try {
      await downloadBackup()
      setMessage('Backup downloaded. Keep it somewhere safe.')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function restore(file: File) {
    if (!confirm('Restoring replaces EVERYTHING currently in ClosetIQ (garments, baskets, plans…) with the backup. Continue?')) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.importBackup(file)
      setMessage(`Restored ${r.restored.garments ?? 0} garments, ${r.restored.pairs ?? 0} pairs, ${r.restored.laundry_baskets ?? 0} baskets and ${r.restored.routines ?? 0} routines.`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function deleteAccount() {
    if (confirmText !== 'DELETE') return
    setBusy(true)
    setError(null)
    try {
      await api.deleteAccount()
      if (supabase) await supabase.auth.signOut()
      else window.location.assign('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      {message && <p className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{message}</p>}
      <section className="card p-4">
        <h2 className="mb-1 font-semibold">Your account</h2>
        <p className="text-sm text-slate-600">{email ?? 'Local mode (no sign-in)'}</p>
        {ai?.enabled && (
          <p className="mt-1 text-sm text-slate-600">
            AI requests today: {ai.used_today} of {ai.daily_limit}
          </p>
        )}
      </section>
      <section className="card p-4">
        <h2 className="mb-1 font-semibold">Export</h2>
        <p className="mb-3 text-sm text-slate-600">
          Download everything as one file: garments with photos, pairs, laundry history, routines, calendar, plans and settings.
        </p>
        <button className="btn btn-primary" disabled={busy} onClick={exportNow}>Download backup</button>
      </section>
      <section className="card p-4">
        <h2 className="mb-1 font-semibold">Restore</h2>
        <p className="mb-3 text-sm text-slate-600">Replace your current data with a backup file. This can't be undone, so export first if unsure.</p>
        <label className="btn btn-danger cursor-pointer">
          Choose backup file…
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) restore(f)
            }}
          />
        </label>
      </section>
      <section className="card border-red-200 p-4">
        <h2 className="mb-1 font-semibold text-red-800">Delete account</h2>
        <p className="mb-3 text-sm text-slate-600">
          Permanently deletes your wardrobe, photos, plans and history{supabase ? ', and your login' : ''}. Export a backup first if
          you might want it later. Type <strong>DELETE</strong> to confirm.
        </p>
        <div className="flex gap-2">
          <input className="input max-w-40" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="DELETE" aria-label="Type DELETE to confirm" />
          <button className="btn btn-danger" disabled={busy || confirmText !== 'DELETE'} onClick={deleteAccount}>
            Delete everything
          </button>
        </div>
      </section>
    </div>
  )
}
