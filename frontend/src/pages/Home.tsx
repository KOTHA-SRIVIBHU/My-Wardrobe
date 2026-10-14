import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CoveragePanel } from '../components/CoveragePanel'
import { BasketBadge, Empty, ErrorBanner, GarmentThumb, PageHeader, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { capitalize, localToday, plural, useLoad } from '../lib/format'
import type { Garment, PlanSlot } from '../lib/types'
import { basketWhen } from './Laundry'

export default function Home() {
  const today = localToday()
  const dash = useLoad(() => api.dashboard(today), [today])
  const plan = useLoad(() => api.plan(today, 2, today), [today])
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<unknown>) {
    setError(null)
    try {
      await action()
      dash.reload()
      plan.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (dash.loading && !dash.data) return <Spinner />
  if (!dash.data) return <ErrorBanner message={dash.error} />
  const d = dash.data
  const active = [...d.baskets_in_progress, ...d.baskets_pending]

  if (d.garments_total === 0)
    return (
      <Empty>
        <p className="mb-3 text-base font-medium text-slate-700">Welcome to ClosetIQ</p>
        <p className="mb-4">Start by adding the clothes you own. Everything else — pairs, laundry and planning — builds on your wardrobe.</p>
        <Link to="/wardrobe" className="btn btn-primary">Go to wardrobe</Link>
      </Empty>
    )

  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  // Today's planned outfit in one tap: saves the suggestion if needed, then marks it worn.
  const wear = (date: string, s: PlanSlot) =>
    run(async () => {
      const id = s.entry_id ?? (await api.saveEntry({ date, slot_key: s.key, title: s.title, garment_ids: s.garments.map((g) => g.id), locked: false })).id
      await api.wearEntry(id, today)
    })

  return (
    <div className="space-y-6">
      <PageHeader title={greeting} subtitle="Here's your wardrobe at a glance." />
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Ready to wear" value={`${d.garments_wearable} / ${d.garments_total}`} />
        <Tile label="Needs laundry" value={d.state_counts.needs_laundry} />
        <Tile label="In laundry" value={d.state_counts.in_basket + d.state_counts.in_laundry} />
        <Tile label="Drying / ironing" value={d.state_counts.drying + d.state_counts.needs_ironing} />
      </div>

      <CoveragePanel compact />

      {plan.data && plan.data.days.some((day) => day.slots.length > 0) && (
        <Section title="Your plan" action={<Link to="/plan" className="text-sm text-indigo-700 hover:underline">Full week</Link>}>
          <div className="grid gap-3 md:grid-cols-2">
            {plan.data.days.map((day, i) => (
              <div key={day.date} className="card p-4">
                <p className="mb-2 text-sm font-semibold">
                  {i === 0 ? 'Today' : 'Tomorrow'}
                  {day.weather.length > 0 && <span className="ml-2 font-normal text-slate-500">{day.weather.join(', ')}</span>}
                </p>
                {day.slots.length === 0 && <p className="text-sm text-slate-500">Nothing planned.</p>}
                <ul className="space-y-3">
                  {day.slots.map((s) => (
                    <li key={s.key}>
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium text-slate-600">
                          {s.title}
                          {s.status === 'worn' ? ' · ✓ worn' : ''}
                        </p>
                        {i === 0 && s.status === 'planned' && s.garments.length > 0 && s.problems.length === 0 && (
                          <button className="rounded-md bg-indigo-600 px-2 py-0.5 text-xs font-medium text-white hover:bg-indigo-700" onClick={() => wear(day.date, s)}>
                            Wear it
                          </button>
                        )}
                      </div>
                      {s.garments.length > 0 ? (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {s.garments.map((g) => (
                            <Link key={g.id} to={`/garments/${g.id}`} title={g.name}>
                              <GarmentThumb garment={g} size="sm" />
                            </Link>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-slate-400">—</p>
                      )}
                      {[...s.prep, ...s.problems].map((t) => (
                        <p key={t} className={`mt-0.5 text-xs ${s.problems.includes(t) ? 'text-red-700' : 'text-amber-800'}`}>• {t}</p>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      )}

      {d.warnings.length > 0 && (
        <section className="card divide-y divide-slate-100">
          {d.warnings.map((w, i) => (
            <div key={i} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <span>⚠️ {w.message}</span>
              {w.basket_id && (
                <Link to={`/laundry/${w.basket_id}`} className="shrink-0 text-indigo-700 hover:underline">
                  Open
                </Link>
              )}
            </div>
          ))}
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Section title="Laundry baskets" action={<Link to="/laundry" className="text-sm text-indigo-700 hover:underline">All baskets</Link>}>
          {active.length === 0 ? (
            <p className="text-sm text-slate-500">No open baskets.</p>
          ) : (
            <ul className="space-y-2">
              {active.map((b) => (
                <li key={b.id}>
                  <Link to={`/laundry/${b.id}`} className="card flex items-center justify-between gap-3 px-4 py-3 hover:border-indigo-300">
                    <span>
                      <span className="block text-sm font-medium">{b.name}</span>
                      <span className="text-xs text-slate-500">
                        {plural(b.garment_count, 'garment')} · {basketWhen(b, today)}
                      </span>
                    </span>
                    <BasketBadge status={b.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {d.needs_laundry.length > 0 && (
            <p className="mt-3 text-sm text-slate-600">
              {plural(d.needs_laundry.length, 'garment')} need washing and aren't in a basket yet.{' '}
              <Link to="/wardrobe" className="text-indigo-700 hover:underline">Choose them in your wardrobe</Link>.
            </p>
          )}
        </Section>

        <Section title="Ready by category">
          <ul className="space-y-1.5">
            {Object.entries(d.category_counts).map(([cat, c]) => (
              <li key={cat} className="flex items-center gap-3 text-sm">
                <span className="w-28 shrink-0">{capitalize(cat)}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                  <span className="block h-full rounded-full bg-emerald-500" style={{ width: `${(c.wearable / c.total) * 100}%` }} />
                </span>
                <span className="w-12 text-right text-slate-600 tabular-nums">
                  {c.wearable}/{c.total}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title={`Drying (${d.drying.length})`}
          action={
            d.drying.length > 1 && (
              <button className="text-sm text-indigo-700 hover:underline" onClick={() => run(() => api.dried(d.drying.map((g) => g.id)))}>
                All dry
              </button>
            )
          }
        >
          <GarmentRows garments={d.drying} empty="Nothing drying." actionLabel="Dry" onAction={(g) => run(() => api.dried([g.id]))} />
        </Section>

        <Section
          title={`Needs ironing (${d.needs_ironing.length})`}
          action={
            d.needs_ironing.length > 1 && (
              <button className="text-sm text-indigo-700 hover:underline" onClick={() => run(() => api.ironed(d.needs_ironing.map((g) => g.id)))}>
                All ironed
              </button>
            )
          }
        >
          <GarmentRows garments={d.needs_ironing} empty="Nothing to iron." actionLabel="Ironed" onAction={(g) => run(() => api.ironed([g.id]))} />
        </Section>
      </div>
    </div>
  )
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="card px-4 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

function GarmentRows({
  garments,
  empty,
  actionLabel,
  onAction,
}: {
  garments: Garment[]
  empty: string
  actionLabel: string
  onAction: (g: Garment) => void
}) {
  if (!garments.length) return <p className="text-sm text-slate-500">{empty}</p>
  return (
    <ul className="card divide-y divide-slate-100">
      {garments.map((g) => (
        <li key={g.id} className="flex items-center gap-3 px-4 py-2">
          <GarmentThumb garment={g} size="sm" />
          <Link to={`/garments/${g.id}`} className="min-w-0 flex-1 truncate text-sm font-medium">
            {g.name}
            {g.state === 'drying' && g.iron_after_drying && <span className="ml-1 text-xs font-normal text-slate-500">(iron after)</span>}
          </Link>
          <button className="btn btn-secondary px-2 py-1" onClick={() => onAction(g)}>
            {actionLabel}
          </button>
        </li>
      ))}
    </ul>
  )
}
