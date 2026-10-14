import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { GarmentPicker } from '../components/GarmentPicker'
import { Icon } from '../components/Icon'
import { BasketBadge, Empty, ErrorBanner, GarmentThumb, IssueList, Modal, Notice, Spinner, StateBadge } from '../components/ui'
import { ApiError, api } from '../lib/api'
import { STATE_LABELS, fmtDate, fmtDateTime, localToday, plural, useLoad } from '../lib/format'
import type { Basket, BasketItem, WashResult } from '../lib/types'
import { BasketForm, basketBlocker, basketWhen } from './Laundry'

const OUTCOME_LABELS = { washed: 'Washed', not_processed: 'Not processed', removed: 'Removed', ironed: 'Ironed' }

export default function BasketDetail() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const basket = useLoad(() => api.basket(id), [id])
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [completing, setCompleting] = useState(false)
  const [simulating, setSimulating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notices, setNotices] = useState<string[]>([])

  if (basket.loading && !basket.data) return <Spinner />
  if (!basket.data) return <ErrorBanner message={basket.error} />
  const b = basket.data
  if (b.kind === 'ironing') return <IroningBasket basket={b} reload={basket.reload} />
  const active = b.items.filter((i) => i.active)
  const past = b.items.filter((i) => !i.active)

  async function run(action: () => Promise<Basket | void>) {
    setError(null)
    try {
      const r = await action()
      if (r) basket.setData(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function remove(item: BasketItem) {
    setError(null)
    try {
      basket.setData(await api.removeFromBasket(b.id, item.garment.id))
    } catch (e) {
      if (e instanceof ApiError && e.code === 'confirmation_required') {
        if (confirm(`${e.message}\n\nRemove "${item.garment.name}" anyway? It will be marked Needs Laundry.`))
          run(() => api.removeFromBasket(b.id, item.garment.id, true, 'needs_laundry'))
      } else setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <Link to="/laundry" className="text-sm text-indigo-700 hover:underline">
        ← Laundry
      </Link>
      <div className="mt-3 mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{b.name}</h1>
            <BasketBadge status={b.status} />
          </div>
          {b.description && <p className="text-sm text-slate-600">{b.description}</p>}
          <p className="mt-1 text-sm text-slate-500">{basketWhen(b, localToday())}</p>
          {b.notes && <p className="mt-1 text-sm text-slate-600">Notes: {b.notes}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {b.status === 'pending' && (
            <button className="btn btn-primary" disabled={!active.length} onClick={() => run(() => api.startBasket(b.id))}>
              Start laundry
            </button>
          )}
          {b.status !== 'completed' && (
            <button className={`btn ${b.status === 'in_progress' ? 'btn-primary' : 'btn-secondary'}`} disabled={!active.length} onClick={() => setCompleting(true)}>
              Mark completed…
            </button>
          )}
          {b.status === 'pending' && active.length > 0 && (
            <button className="btn btn-secondary" onClick={() => setSimulating(true)}>What if…?</button>
          )}
          <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit</button>
          {b.status !== 'in_progress' && (
            <button
              className="btn btn-danger"
              onClick={async () => {
                const msg =
                  b.status === 'pending'
                    ? `Delete "${b.name}"? Its garments go back to their previous states.`
                    : `Delete "${b.name}" from your laundry history?`
                if (!confirm(msg)) return
                try {
                  await api.deleteBasket(b.id)
                  navigate('/laundry')
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                }
              }}
            >
              Delete
            </button>
          )}
        </div>
      </div>

      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <Notice messages={notices} onDismiss={() => setNotices([])} />

      {b.status !== 'completed' && (
        <section className="mb-6">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-semibold tracking-wide text-slate-500 uppercase">In this basket ({active.length})</h2>
            <button className="btn btn-secondary" onClick={() => setAdding(true)}>+ Add garments</button>
          </div>
          {active.length === 0 ? (
            <Empty>This basket is empty.</Empty>
          ) : (
            <ul className="card divide-y divide-slate-100">
              {active.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-4 py-2">
                  <GarmentThumb garment={i.garment} size="sm" />
                  <Link to={`/garments/${i.garment.id}`} className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{i.garment.name}</span>
                    <span className="text-xs text-slate-500">Was {STATE_LABELS[i.previous_state]}</span>
                  </Link>
                  <StateBadge state={i.garment.state} />
                  <button className="text-sm text-red-700 hover:underline" onClick={() => remove(i)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {past.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold tracking-wide text-slate-500 uppercase">
            {b.status === 'completed' ? 'Processed in this batch' : 'Removed'}
          </h2>
          <ul className="card divide-y divide-slate-100">
            {past.map((i) => (
              <li key={i.id} className="flex items-center gap-3 px-4 py-2">
                <GarmentThumb garment={i.garment} size="sm" />
                <Link to={`/garments/${i.garment.id}`} className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{i.garment.name}</span>
                  <span className="text-xs text-slate-500">
                    {i.outcome ? OUTCOME_LABELS[i.outcome] : ''} · {fmtDateTime(i.resolved_at)}
                  </span>
                </Link>
                <span className="text-xs text-slate-500">now</span>
                <StateBadge state={i.garment.state} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {simulating && <SimulateBasket basket={b} onClose={() => setSimulating(false)} />}
      {editing && (
        <BasketForm
          basket={b}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false)
            basket.setData(saved)
          }}
        />
      )}
      {adding && (
        <AddGarments
          basket={b}
          onClose={() => setAdding(false)}
          onDone={(saved, warnings) => {
            setAdding(false)
            basket.setData(saved)
            setNotices(warnings)
          }}
        />
      )}
      {completing && (
        <CompleteBasket
          basket={b}
          items={active}
          onClose={() => setCompleting(false)}
          onDone={(saved) => {
            setCompleting(false)
            basket.setData(saved)
            const ironing = saved.items.filter((i) => i.garment.state === 'needs_ironing').length
            const drying = saved.items.filter((i) => i.garment.state === 'drying').length
            setNotices(
              [
                `${b.name} completed.`,
                drying ? `${plural(drying, 'garment')} drying — mark them dry from the Today page.` : '',
                ironing ? `${plural(ironing, 'garment')} waiting to be ironed.` : '',
              ].filter(Boolean),
            )
          }}
        />
      )}
    </div>
  )
}

function AddGarments({
  basket,
  onClose,
  onDone,
}: {
  basket: Basket
  onClose: () => void
  onDone: (b: Basket, warnings: string[]) => void
}) {
  const garments = useLoad(() => api.garments(), [])
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const order = ['needs_laundry', 'worn_reusable']
  const sorted = [...(garments.data ?? [])].sort(
    (a, b) => (order.indexOf(a.state) + 1 || 9) - (order.indexOf(b.state) + 1 || 9),
  )

  async function add() {
    try {
      const r = await api.addToBasket(basket.id, selected)
      onDone(r.basket, r.warnings)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Modal
      title={`Add to ${basket.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!selected.length} onClick={add}>
            Add {selected.length || ''}
          </button>
        </>
      }
    >
      <ErrorBanner message={error ?? garments.error} />
      {basket.status === 'in_progress' && (
        <p className="mb-3 text-sm text-slate-600">This basket is in progress, so added garments go straight to In Laundry.</p>
      )}
      {garments.loading ? (
        <Spinner />
      ) : (
        <GarmentPicker garments={sorted} selected={selected} onChange={setSelected} disabledReason={basketBlocker} />
      )}
    </Modal>
  )
}

const RESULT_LABELS: Record<WashResult, string> = {
  dry: 'Washed & dry',
  drying: 'Still drying',
  unavailable: 'Damaged / unavailable',
  not_processed: "Didn't get washed",
}

function CompleteBasket({
  basket,
  items,
  onClose,
  onDone,
}: {
  basket: Basket
  items: BasketItem[]
  onClose: () => void
  onDone: (b: Basket) => void
}) {
  const [defaultResult, setDefaultResult] = useState<'dry' | 'drying'>('dry')
  // Per-garment overrides; absent = default result and the garment's own ironing policy.
  const [results, setResults] = useState<Record<string, WashResult>>({})
  const [ironing, setIroning] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const ironsByDefault = (i: BasketItem) => i.garment.ironing_policy === 'required'

  async function submit() {
    setSaving(true)
    setError(null)
    const outcomes = items
      .filter((i) => results[i.garment.id] || ironing[i.garment.id] !== undefined)
      .map((i) => ({
        garment_id: i.garment.id,
        result: results[i.garment.id] ?? defaultResult,
        needs_ironing: ironing[i.garment.id] ?? null,
      }))
    try {
      onDone(await api.completeBasket(basket.id, defaultResult, outcomes))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <Modal
      title={`Complete ${basket.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving} onClick={submit}>
            {saving ? 'Saving…' : 'Complete basket'}
          </button>
        </>
      }
    >
      <ErrorBanner message={error} />
      <p className="mb-3 text-sm text-slate-600">
        Washed garments get their wear count reset. Anything still drying or needing ironing won't be marked Ready to Wear yet.
      </p>
      <div className="mb-4 flex gap-2">
        {(['dry', 'drying'] as const).map((r) => (
          <button
            key={r}
            onClick={() => setDefaultResult(r)}
            className={`rounded-full px-3 py-1 text-sm ${defaultResult === r ? 'bg-indigo-600 text-white' : 'bg-white ring-1 ring-slate-300'}`}
          >
            Everything is {r === 'dry' ? 'dry' : 'still drying'}
          </button>
        ))}
      </div>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {items.map((i) => {
          const result = results[i.garment.id] ?? defaultResult
          const iron = ironing[i.garment.id] ?? ironsByDefault(i)
          return (
            <li key={i.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <GarmentThumb garment={i.garment} size="sm" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{i.garment.name}</span>
              <select
                className="input max-w-52"
                value={result}
                onChange={(e) => setResults({ ...results, [i.garment.id]: e.target.value as WashResult })}
                aria-label={`Result for ${i.garment.name}`}
              >
                {(Object.keys(RESULT_LABELS) as WashResult[]).map((r) => (
                  <option key={r} value={r}>{RESULT_LABELS[r]}</option>
                ))}
              </select>
              <label className={`flex items-center gap-1.5 text-sm ${result === 'dry' || result === 'drying' ? '' : 'invisible'}`}>
                <input
                  type="checkbox"
                  className="accent-indigo-600"
                  checked={iron}
                  onChange={(e) => setIroning({ ...ironing, [i.garment.id]: e.target.checked })}
                />
                Needs ironing
              </label>
            </li>
          )
        })}
      </ul>
    </Modal>
  )
}

/** Laundry simulation: what washing this basket on a given day does to the coming week. */
function SimulateBasket({ basket, onClose }: { basket: Basket; onClose: () => void }) {
  const today = localToday()
  const [washOn, setWashOn] = useState(basket.scheduled_for && basket.scheduled_for > today ? basket.scheduled_for : today)
  const result = useLoad(() => api.simulate({ basket_id: basket.id, wash_on: washOn, days: 7 }, today), [basket.id, washOn, today])
  const r = result.data
  return (
    <Modal title={`What if I wash ${basket.name}…`} onClose={onClose} wide>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="text-sm" htmlFor="sim-date">on</label>
        <input id="sim-date" type="date" className="input max-w-44" min={today} value={washOn} onChange={(e) => setWashOn(e.target.value || today)} />
        {r && <span className="text-sm text-slate-600">→ clothes back {fmtDate(r.returns_on)}</span>}
      </div>
      <ErrorBanner message={result.error} />
      {!r ? (
        <Spinner />
      ) : (
        <div className="space-y-4 text-sm">
          <p className={`rounded-lg px-3 py-2 ${r.covered ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>
            {r.covered ? '✓ Your routines for the next 7 days are still covered.' : '✗ Some days in the next week can’t be fully covered.'}
          </p>
          {r.resolved_issues.length > 0 && (
            <div>
              <h3 className="mb-1 font-semibold text-emerald-800">Better than the current schedule</h3>
              <IssueList issues={r.resolved_issues.map((i) => ({ ...i, severity: 'info' as const }))} />
            </div>
          )}
          {r.new_issues.length > 0 && (
            <div>
              <h3 className="mb-1 font-semibold text-red-800">New shortages</h3>
              <IssueList issues={r.new_issues} />
            </div>
          )}
          {r.scarce.length > 0 && (
            <div>
              <h3 className="mb-1 font-semibold">Running low</h3>
              <ul className="list-disc pl-5">{r.scarce.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
          {r.affected_events.length > 0 && (
            <div>
              <h3 className="mb-1 font-semibold">Events affected</h3>
              <ul className="list-disc pl-5">{r.affected_events.map((s) => <li key={s}>{s}</li>)}</ul>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 font-semibold">Pairs you can still wear</h3>
              {r.pairs_possible.length ? (
                <ul className="list-disc pl-5">{r.pairs_possible.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
              ) : (
                <p className="text-slate-500">None</p>
              )}
            </div>
            <div>
              <h3 className="mb-1 font-semibold">Pairs on hold until it's back</h3>
              {r.pairs_blocked.length ? (
                <ul className="list-disc pl-5">{r.pairs_blocked.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
              ) : (
                <p className="text-slate-500">None</p>
              )}
            </div>
          </div>
          {r.preparation.length > 0 && <p className="text-slate-600">{r.preparation.join(' · ')}</p>}
        </div>
      )}
    </Modal>
  )
}

/** The ironing basket: filled automatically after laundry, emptied by ironing. */
function IroningBasket({ basket, reload }: { basket: Basket; reload: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const active = basket.items.filter((i) => i.active)
  // Most recent first; the basket keeps its whole history, so show only the latest.
  const done = basket.items.filter((i) => i.outcome === 'ironed').sort((a, b) => (b.resolved_at ?? '').localeCompare(a.resolved_at ?? '')).slice(0, 12)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try {
      await action()
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Link to="/laundry" className="text-sm text-indigo-700 hover:underline">
        ← Laundry
      </Link>
      <div className="mt-3 mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Icon name="iron" className="h-7 w-7 text-orange-500" /> {basket.name}
          </h1>
          <p className="text-sm text-slate-500">
            Your one ironing basket. Clean clothes land here automatically after laundry and become Ready to Wear once ironed.
          </p>
        </div>
        {active.length > 1 && (
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.ironed(active.map((i) => i.garment.id)))}>
            <Icon name="check" className="h-4 w-4" /> Iron all {active.length}
          </button>
        )}
      </div>
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      {active.length === 0 ? (
          <Empty>Nothing waiting to be ironed. 🎉</Empty>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {active.map((i) => (
              <li key={i.id} className="card flex items-center gap-3 p-3">
                <GarmentThumb garment={i.garment} size="md" />
                <div className="min-w-0 flex-1">
                  <Link to={`/garments/${i.garment.id}`} className="block truncate font-medium hover:text-indigo-700">
                    {i.garment.name}
                  </Link>
                  <p className="text-xs text-slate-500">Waiting since {fmtDateTime(i.added_at)}</p>
                  <div className="mt-1.5 flex gap-3 text-sm">
                    <button className="font-medium text-indigo-700 hover:underline" disabled={busy} onClick={() => run(() => api.ironed([i.garment.id]))}>
                      Ironed
                    </button>
                    <button className="text-slate-500 hover:underline" disabled={busy} onClick={() => run(() => api.removeFromBasket(basket.id, i.garment.id))}>
                      No ironing needed
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      {done.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-2 text-sm font-semibold tracking-wide text-slate-500 uppercase">Recently ironed</h2>
          <ul className="flex flex-wrap gap-2">
            {done.map((i) => (
              <li key={i.id} className="flex items-center gap-2 rounded-full bg-white py-1 pr-3 pl-1 text-sm ring-1 ring-slate-200">
                <GarmentThumb garment={i.garment} size="sm" />
                {i.garment.name}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
