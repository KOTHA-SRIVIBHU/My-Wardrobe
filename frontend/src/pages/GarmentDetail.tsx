import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMeta } from '../App'
import { GarmentForm } from '../components/GarmentForm'
import { ErrorBanner, GarmentThumb, Modal, Spinner, StateBadge } from '../components/ui'
import { api } from '../lib/api'
import { STATE_LABELS, capitalize, fmtDate, fmtDateTime, localToday, useLoad } from '../lib/format'
import type { Garment, GarmentEvent, GarmentState } from '../lib/types'
import { AddToBasket } from './Wardrobe'

const BASKET_STATES: GarmentState[] = ['in_basket', 'in_laundry']

export default function GarmentDetail() {
  const { id = '' } = useParams()
  const meta = useMeta()
  const navigate = useNavigate()
  const garment = useLoad(() => api.garment(id), [id])
  const history = useLoad(() => api.history(id), [id])
  const labels = useLoad(() => api.labels(), [])
  const [editing, setEditing] = useState(false)
  const [overriding, setOverriding] = useState(false)
  const [washing, setWashing] = useState(false)
  const [toBasket, setToBasket] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (garment.loading && !garment.data) return <Spinner />
  if (!garment.data) return <ErrorBanner message={garment.error} />
  const g = garment.data

  async function run(action: () => Promise<Garment | Garment[] | void>) {
    setError(null)
    try {
      const r = await action()
      if (r && !Array.isArray(r)) garment.setData(r)
      else garment.reload()
      history.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const canWear = !g.archived && (g.wearable || g.state === 'reserved')
  const inBasket = BASKET_STATES.includes(g.state)

  return (
    <div>
      <Link to="/wardrobe" className="text-sm text-indigo-700 hover:underline">
        ← Wardrobe
      </Link>
      <div className="mt-3 grid gap-6 md:grid-cols-[280px_1fr]">
        <div className="space-y-3">
          <GarmentThumb garment={g} size="lg" />
          <label className="btn btn-secondary w-full cursor-pointer">
            {g.image_url ? 'Replace photo' : 'Add photo'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) run(() => api.uploadImage(g.id, file))
              }}
            />
          </label>
          {g.image_url && (
            <button className="btn btn-secondary w-full" onClick={() => run(() => api.deleteImage(g.id))}>
              Remove photo
            </button>
          )}
        </div>

        <div>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold">{g.name}</h1>
              <p className="text-sm text-slate-500">
                {capitalize(g.category)}
                {g.subcategory ? ` · ${g.subcategory}` : ''}
                {g.color ? ` · ${g.color}` : ''}
                {g.pattern ? ` · ${g.pattern}` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {g.archived ? <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs">Archived ({g.archived_reason?.replace(/_/g, ' ')})</span> : <StateBadge state={g.state} />}
            </div>
          </div>

          {g.active_basket && (
            <p className="mt-2 text-sm text-slate-600">
              In basket{' '}
              <Link to={`/laundry/${g.active_basket.id}`} className="font-medium text-indigo-700 hover:underline">
                {g.active_basket.name}
              </Link>
              .
            </p>
          )}
          {g.state === 'drying' && g.iron_after_drying && <p className="mt-2 text-sm text-slate-600">Will need ironing once dry.</p>}

          <ErrorBanner message={error} onDismiss={() => setError(null)} />

          {!g.archived && (
            <div className="mt-4 flex flex-wrap gap-2">
              {canWear && (
                <button className="btn btn-primary" onClick={() => run(() => api.wear([g.id], localToday()))}>
                  Wore it today
                </button>
              )}
              {g.state === 'drying' && (
                <button className="btn btn-primary" onClick={() => run(() => api.dried([g.id]))}>
                  Mark dry
                </button>
              )}
              {g.state === 'needs_ironing' && (
                <button className="btn btn-primary" onClick={() => run(() => api.ironed([g.id]))}>
                  Mark ironed
                </button>
              )}
              {(g.wearable || g.state === 'reserved' || (g.state === 'drying' && !g.iron_after_drying)) && (
                <button className="btn btn-secondary" onClick={() => run(() => api.needsIroning([g.id]))}>
                  Needs ironing
                </button>
              )}
              {!inBasket && (
                <>
                  <button className="btn btn-secondary" onClick={() => setToBasket(true)}>
                    Add to basket…
                  </button>
                  <button className="btn btn-secondary" onClick={() => setWashing(true)}>
                    Washed by hand…
                  </button>
                  <button className="btn btn-secondary" onClick={() => setOverriding(true)}>
                    Change state…
                  </button>
                </>
              )}
            </div>
          )}

          {!g.archived && g.max_wears_before_wash && <ReuseMeter garment={g} />}

          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
            <Stat label="Total wears" value={g.total_wears} />
            <Stat label="Since last wash" value={`${g.wears_since_wash}${g.max_wears_before_wash ? ` / ${g.max_wears_before_wash}` : ''}`} />
            <Stat label="Last worn" value={fmtDate(g.last_worn_on)} />
            <Stat label="Last washed" value={fmtDateTime(g.last_washed_at)} />
            <Stat label="Wash after" value={g.max_wears_before_wash ? `${g.max_wears_before_wash} wear(s)` : 'Never'} />
            <Stat label="Ironing" value={capitalize(g.ironing_policy.replace(/_/g, ' '))} />
            {g.formality && <Stat label="Formality" value={`${g.formality} / 5`} />}
            {g.fabric && <Stat label="Fabric" value={g.fabric} />}
            {g.purchase_price && (
              <Stat
                label="Cost per wear"
                value={g.total_wears ? (Number(g.purchase_price) / g.total_wears).toFixed(2) : g.purchase_price}
              />
            )}
          </dl>

          {[...g.labels, ...g.occasions, ...g.seasons, ...g.weather].length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {[...g.labels, ...g.occasions, ...g.seasons, ...g.weather].map((t, i) => (
                <span key={`${t}-${i}`} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                  {t}
                </span>
              ))}
            </div>
          )}
          {g.comfort_notes && <p className="mt-4 text-sm text-slate-700">Comfort: {g.comfort_notes}</p>}
          {g.notes && <p className="mt-2 text-sm whitespace-pre-line text-slate-700">{g.notes}</p>}

          <div className="mt-6 flex flex-wrap gap-2 border-t border-slate-200 pt-4">
            <button className="btn btn-secondary" onClick={() => setEditing(true)}>
              Edit details
            </button>
            {g.archived ? (
              <button className="btn btn-secondary" onClick={() => run(() => api.unarchive(g.id))}>
                Restore to wardrobe
              </button>
            ) : (
              <>
                <button className="btn btn-secondary" onClick={() => run(() => api.archive(g.id, 'archived'))}>
                  Archive
                </button>
                <button className="btn btn-secondary" onClick={() => run(() => api.archive(g.id, 'no_longer_owned'))}>
                  No longer owned
                </button>
              </>
            )}
            <button
              className="btn btn-danger ml-auto"
              onClick={async () => {
                if (!confirm(`Permanently delete "${g.name}" and all its history? Archiving keeps history.`)) return
                try {
                  await api.deleteGarment(g.id)
                  navigate('/wardrobe')
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e))
                }
              }}
            >
              Delete
            </button>
          </div>

          <h2 className="mt-8 mb-2 text-sm font-semibold tracking-wide text-slate-500 uppercase">History</h2>
          <ul className="card divide-y divide-slate-100">
            {(history.data ?? []).map((e) => (
              <li key={e.id} className="flex justify-between gap-3 px-4 py-2 text-sm">
                <span>{describe(e)}</span>
                <span className="shrink-0 text-xs text-slate-500">{fmtDateTime(e.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {editing && (
        <GarmentForm
          meta={meta}
          labels={labels.data ?? []}
          garment={g}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false)
            garment.setData(saved)
            history.reload()
          }}
        />
      )}
      {overriding && (
        <OverrideState
          garment={g}
          onClose={() => setOverriding(false)}
          onSave={(state, note) => {
            setOverriding(false)
            run(() => api.setState(g.id, state, note))
          }}
        />
      )}
      {washing && (
        <Modal title="Washed outside a basket" onClose={() => setWashing(false)}>
          <p className="mb-4 text-sm text-slate-600">This resets the wear count since washing. Is it dry yet?</p>
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary" onClick={() => { setWashing(false); run(() => api.wash([g.id], true)) }}>
              Washed & dry
            </button>
            <button className="btn btn-secondary" onClick={() => { setWashing(false); run(() => api.wash([g.id], false)) }}>
              Washed, still drying
            </button>
          </div>
        </Modal>
      )}
      {toBasket && (
        <AddToBasket
          garmentIds={[g.id]}
          onClose={() => setToBasket(false)}
          onDone={(warnings) => {
            setToBasket(false)
            if (warnings.length) setError(warnings.join(' '))
            garment.reload()
            history.reload()
          }}
        />
      )}
    </div>
  )
}

/** Wears since the last wash against the garment's reuse limit. */
function ReuseMeter({ garment: g }: { garment: Garment }) {
  const limit = g.max_wears_before_wash ?? 1
  // "Ready to Wear" means fresh, whatever an old count says.
  const worn = g.state === 'ready' ? 0 : g.wears_since_wash
  const used = Math.min(worn, limit)
  const left = limit - worn
  const atLimit = left <= 0
  const message = atLimit
    ? g.state === 'needs_laundry'
      ? 'Reached its reuse limit: needs washing before the next wear.'
      : 'Reached its reuse limit.'
    : worn === 0
      ? `Fresh: can be worn ${limit === 1 ? 'once' : `${limit} times`} before washing.`
      : `Worn ${worn} of ${limit} times: ${left} more ${left === 1 ? 'wear' : 'wears'} before washing.`
  return (
    <div className={`mt-4 rounded-xl border p-3 ${atLimit ? 'border-red-200 bg-red-50' : worn ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
      <div className="mb-2 flex gap-1" role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={worn} aria-label="Wears since last wash">
        {Array.from({ length: limit }, (_, i) => (
          <span key={i} className={`h-2 flex-1 rounded-full ${i < used ? (atLimit ? 'bg-red-400' : 'bg-amber-400') : 'bg-white ring-1 ring-black/10'}`} />
        ))}
      </div>
      <p className="text-sm">{message}</p>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  )
}

function describe(e: GarmentEvent): string {
  const to = e.to_state ? STATE_LABELS[e.to_state] : ''
  switch (e.kind) {
    case 'created':
      return 'Added to wardrobe'
    case 'worn':
      return `Worn${e.worn_on ? ` on ${fmtDate(e.worn_on)}` : ''}${e.pair_id ? ' (as a pair)' : ''} → ${to}`
    case 'washed':
      return 'Washed'
    case 'ironed':
      return 'Ironed → Ready to Wear'
    case 'archived':
      return `Archived (${(e.note ?? '').replace(/_/g, ' ')})`
    case 'unarchived':
      return 'Restored to wardrobe'
    default:
      return [e.note, to && `→ ${to}`].filter(Boolean).join(' ') || 'Updated'
  }
}

function OverrideState({
  garment,
  onClose,
  onSave,
}: {
  garment: Garment
  onClose: () => void
  onSave: (state: GarmentState, note?: string) => void
}) {
  const meta = useMeta()
  const options = meta.states.filter((s) => !BASKET_STATES.includes(s.value))
  const [state, setState] = useState<GarmentState>(garment.state)
  const [note, setNote] = useState('')
  return (
    <Modal
      title="Change state"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={state === garment.state} onClick={() => onSave(state, note || undefined)}>
            Save
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm text-slate-600">Use this when the real world differs from what ClosetIQ expects. Laundry states are set through baskets.</p>
      <label className="label" htmlFor="ov-state">New state</label>
      <select id="ov-state" className="input mb-3" value={state} onChange={(e) => setState(e.target.value as GarmentState)}>
        {options.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>
      <label className="label" htmlFor="ov-note">Note (optional)</label>
      <input id="ov-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Lent to a friend" />
    </Modal>
  )
}
