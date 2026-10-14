import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { GarmentPicker } from '../components/GarmentPicker'
import { Icon } from '../components/Icon'
import { BasketBadge, Empty, ErrorBanner, GarmentThumb, Modal, PageHeader, Spinner } from '../components/ui'
import { api } from '../lib/api'
import { fmtDate, fmtDateTime, fromLocalInput, localToday, plural, toLocalInput, useLoad } from '../lib/format'
import type { Basket, BasketStatus, Garment } from '../lib/types'

export default function Laundry() {
  const [status, setStatus] = useState<BasketStatus | ''>('')
  const [sort, setSort] = useState<'scheduled' | 'name' | 'created'>('scheduled')
  const [creating, setCreating] = useState(false)
  const baskets = useLoad(() => api.baskets(status || undefined, sort), [status, sort])
  const navigate = useNavigate()
  const today = localToday()
  const ironingRef = useLoad(() => api.dashboard(today).then((d) => d.ironing_basket), [today])
  const ironingId = ironingRef.data?.id
  const ironing = useLoad(() => (ironingId ? api.basket(ironingId) : Promise.resolve(null)), [ironingId])
  const [ironBusy, setIronBusy] = useState(false)
  const laundryBaskets = (baskets.data ?? []).filter((b) => !(b.kind === 'ironing' && b.status !== 'completed'))

  async function ironAll(ids: string[]) {
    setIronBusy(true)
    try {
      await api.ironed(ids)
      await Promise.all([ironingRef.reload(), baskets.reload()])
    } finally {
      setIronBusy(false)
    }
  }

  const waiting = ironing.data?.items.filter((i) => i.active) ?? []

  return (
    <div>
      <PageHeader
        title="Laundry"
        subtitle="Batch clothes for washing; anything that needs ironing afterwards goes to the ironing basket."
        actions={
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" className="h-4 w-4" /> New basket
          </button>
        }
      />

      {waiting.length === 0 && ironing.data && (
        <Link
          to={`/laundry/${ironing.data.id}`}
          className="mb-6 flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600 hover:border-orange-300"
        >
          <Icon name="iron" className="h-5 w-5 text-orange-500" />
          <span className="flex-1">Ironing basket is empty. Nothing to iron.</span>
          <span className="text-indigo-700">Open →</span>
        </Link>
      )}
      {waiting.length > 0 && ironing.data && (
        <section className="mb-6 overflow-hidden rounded-2xl border border-orange-200 bg-gradient-to-br from-orange-50 to-amber-50">
          <div className="flex flex-wrap items-center gap-3 px-5 pt-4">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500 text-white shadow-sm">
              <Icon name="iron" className="h-6 w-6" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="font-semibold text-orange-950">Ironing basket</h2>
              <p className="text-sm text-orange-900/80">{plural(waiting.length, 'garment')} waiting to be ironed</p>
            </div>
            <Link to={`/laundry/${ironing.data.id}`} className="btn btn-secondary">Open</Link>
            <button className="btn bg-orange-600 text-white hover:bg-orange-700" disabled={ironBusy} onClick={() => ironAll(waiting.map((i) => i.garment.id))}>
              <Icon name="check" className="h-4 w-4" /> All ironed
            </button>
          </div>
          <ul className="flex gap-2 overflow-x-auto px-5 py-4">
            {waiting.map((i) => (
              <li key={i.id} className="w-20 shrink-0 text-center">
                <Link to={`/garments/${i.garment.id}`}>
                  <span className="block overflow-hidden rounded-lg ring-1 ring-orange-200">
                    <GarmentThumb garment={i.garment} size="card" />
                  </span>
                  <span className="mt-1 block truncate text-[11px] text-orange-950">{i.garment.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        {(['', 'pending', 'in_progress', 'completed'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-sm ${status === s ? 'bg-indigo-600 text-white' : 'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50'}`}
          >
            {{ '': 'All', pending: 'Pending', in_progress: 'In progress', completed: 'Completed' }[s]}
          </button>
        ))}
        <select className="input ml-auto max-w-44" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
          <option value="scheduled">By scheduled date</option>
          <option value="name">By name</option>
          <option value="created">Newest first</option>
        </select>
      </div>
      <ErrorBanner message={baskets.error} />
      {baskets.loading && !baskets.data ? (
        <Spinner />
      ) : laundryBaskets.length === 0 ? (
        <Empty>No baskets here yet. Create one to batch clothes for washing — e.g. “Monday Laundry” or “Whites”.</Empty>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {laundryBaskets.map((b) => (
            <li key={b.id}>
              <Link to={`/laundry/${b.id}`} className="card block p-4 transition hover:border-indigo-300 hover:shadow-md">
                <div className="mb-1 flex items-start justify-between gap-2">
                  <h3 className="flex items-center gap-2 font-semibold">
                    <Icon name={b.kind === 'ironing' ? 'iron' : 'washer'} className="h-4 w-4 text-slate-400" />
                    {b.name}
                  </h3>
                  <BasketBadge status={b.status} />
                </div>
                <p className="text-sm text-slate-600">{plural(b.garment_count, 'garment')}</p>
                <p className="mt-2 text-xs text-slate-500">{basketWhen(b, today)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <BasketForm
          onClose={() => setCreating(false)}
          onSaved={(b) => navigate(`/laundry/${b.id}`)}
        />
      )}
    </div>
  )
}

export function basketWhen(b: Basket, today: string): string {
  if (b.status === 'completed') return `Completed ${fmtDateTime(b.completed_at)}`
  if (b.status === 'in_progress')
    return `Started ${fmtDateTime(b.started_at)}${b.expected_completion_at ? ` · done by ${fmtDateTime(b.expected_completion_at)}` : ''}`
  if (!b.scheduled_for) return 'Not scheduled'
  if (b.scheduled_for === today) return 'Due today'
  return `${b.scheduled_for < today ? 'Was due' : 'Scheduled'} ${fmtDate(b.scheduled_for)}`
}

/** Garments that can't go into a new basket, and why. */
export function basketBlocker(g: Garment): string | null {
  // Clothes waiting for ironing can go back in the wash; they leave the ironing basket.
  if (g.active_basket && g.active_basket.kind !== 'ironing') return `In ${g.active_basket.name}`
  return null
}

export function BasketForm({
  basket,
  onClose,
  onSaved,
}: {
  basket?: Basket
  onClose: () => void
  onSaved: (b: Basket, warnings: string[]) => void
}) {
  const garments = useLoad<Garment[]>(() => (basket ? Promise.resolve([]) : api.garments()), [])
  const [name, setName] = useState(basket?.name ?? '')
  const [description, setDescription] = useState(basket?.description ?? '')
  const [scheduled, setScheduled] = useState(basket?.scheduled_for ?? '')
  const [expected, setExpected] = useState(toLocalInput(basket?.expected_completion_at ?? null))
  const [notes, setNotes] = useState(basket?.notes ?? '')
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Garments that most likely belong in a basket are listed first.
  const order = ['needs_laundry', 'worn_reusable']
  const sorted = [...(garments.data ?? [])].sort(
    (a, b) => (order.indexOf(a.state) + 1 || 9) - (order.indexOf(b.state) + 1 || 9),
  )

  async function save() {
    setSaving(true)
    setError(null)
    const body = {
      name: name.trim(),
      description: description || null,
      scheduled_for: scheduled || null,
      expected_completion_at: fromLocalInput(expected),
      notes: notes || null,
    }
    try {
      if (basket) onSaved(await api.updateBasket(basket.id, body), [])
      else {
        const r = await api.createBasket({ ...body, garment_ids: selected })
        onSaved(r.basket, r.warnings)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  return (
    <Modal
      title={basket ? `Edit ${basket.name}` : 'New laundry basket'}
      onClose={onClose}
      wide={!basket}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving || !name.trim()} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBanner message={error ?? garments.error} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="label" htmlFor="b-name">Name</label>
          <input id="b-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Monday Laundry" autoFocus />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="b-desc">Description</label>
          <input id="b-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Whites and light colours" />
        </div>
        <div>
          <label className="label" htmlFor="b-date">Scheduled for</label>
          <input id="b-date" type="date" className="input" value={scheduled} onChange={(e) => setScheduled(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="b-exp">Expected done by</label>
          <input id="b-exp" type="datetime-local" className="input" value={expected} onChange={(e) => setExpected(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="b-notes">Laundry notes</label>
          <input id="b-notes" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Cold wash, no tumble dry…" />
        </div>
      </div>
      {!basket && (
        <>
          <span className="label">Garments (optional — you can add more later)</span>
          {garments.loading ? (
            <Spinner />
          ) : (
            <GarmentPicker garments={sorted} selected={selected} onChange={setSelected} disabledReason={basketBlocker} />
          )}
        </>
      )}
    </Modal>
  )
}
