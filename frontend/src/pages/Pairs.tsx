import { useState } from 'react'
import { Link } from 'react-router-dom'
import { GarmentPicker } from '../components/GarmentPicker'
import { Empty, ErrorBanner, GarmentThumb, Modal, Notice, Spinner, TagInput } from '../components/ui'
import { api } from '../lib/api'
import { localToday, useLoad } from '../lib/format'
import type { Pair } from '../lib/types'

export default function Pairs() {
  const pairs = useLoad(() => api.pairs(), [])
  const [editing, setEditing] = useState<Pair | 'new' | null>(null)
  const [onlyWearable, setOnlyWearable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notices, setNotices] = useState<string[]>([])

  async function run(action: () => Promise<unknown>, done?: string) {
    setError(null)
    try {
      await action()
      if (done) setNotices([done])
      pairs.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const shown = (pairs.data ?? []).filter((p) => !onlyWearable || p.wearable)

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Pairs</h1>
        <button className="btn btn-primary" onClick={() => setEditing('new')}>
          + New pair
        </button>
      </div>
      <label className="mb-4 flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={onlyWearable} onChange={(e) => setOnlyWearable(e.target.checked)} className="accent-indigo-600" />
        Only pairs I can wear right now
      </label>
      <ErrorBanner message={error ?? pairs.error} onDismiss={() => setError(null)} />
      <Notice messages={notices} onDismiss={() => setNotices([])} />

      {pairs.loading && !pairs.data ? (
        <Spinner />
      ) : shown.length === 0 ? (
        <Empty>{onlyWearable ? 'No pairs are fully available right now.' : 'Save your favourite combinations as pairs — e.g. a shirt, trousers and shoes you like together.'}</Empty>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((p) => (
            <li key={p.id} className="card flex flex-col p-4">
              <div className="mb-2 flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">{p.name}</h3>
                  {p.occasion && <p className="text-xs text-slate-500">{p.occasion}</p>}
                </div>
                <button
                  className={`text-xl ${p.favorite ? 'text-amber-500' : 'text-slate-300 hover:text-slate-400'}`}
                  onClick={() => run(() => api.updatePair(p.id, { favorite: !p.favorite }))}
                  aria-label={p.favorite ? 'Unfavourite' : 'Favourite'}
                  aria-pressed={p.favorite}
                >
                  ★
                </button>
              </div>
              <div className="mb-3 flex flex-wrap gap-2">
                {p.garments.map((g) => (
                  <Link key={g.id} to={`/garments/${g.id}`} title={g.name}>
                    <GarmentThumb garment={g} size="md" />
                  </Link>
                ))}
              </div>
              {p.wearable ? (
                <p className="mb-3 text-sm font-medium text-emerald-700">Ready to wear</p>
              ) : (
                <ul className="mb-3 space-y-0.5 text-sm text-amber-800">
                  {p.blockers.map((b) => (
                    <li key={b.garment_id}>
                      {b.garment_name}: {b.reason}
                    </li>
                  ))}
                </ul>
              )}
              {p.labels.length > 0 && (
                <div className="mb-3 flex flex-wrap gap-1">
                  {p.labels.map((l) => (
                    <span key={l} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">{l}</span>
                  ))}
                </div>
              )}
              <div className="mt-auto flex flex-wrap gap-2">
                <button className="btn btn-primary" disabled={!p.wearable} onClick={() => run(() => api.wearPair(p.id, localToday()), `Wearing ${p.name} today.`)}>
                  Wear today
                </button>
                <button className="btn btn-secondary" onClick={() => setEditing(p)}>Edit</button>
                <button className="btn btn-secondary" onClick={() => run(() => api.duplicatePair(p.id))}>Duplicate</button>
                <button
                  className="btn btn-danger"
                  onClick={() => confirm(`Delete the pair "${p.name}"? The garments are not affected.`) && run(() => api.deletePair(p.id))}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <PairForm
          pair={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            pairs.reload()
          }}
        />
      )}
    </div>
  )
}

function PairForm({ pair, onClose, onSaved }: { pair?: Pair; onClose: () => void; onSaved: () => void }) {
  const garments = useLoad(() => api.garments(), [])
  const [name, setName] = useState(pair?.name ?? '')
  const [occasion, setOccasion] = useState(pair?.occasion ?? '')
  const [labels, setLabels] = useState<string[]>(pair?.labels ?? [])
  const [notes, setNotes] = useState(pair?.notes ?? '')
  const [favorite, setFavorite] = useState(pair?.favorite ?? false)
  const [selected, setSelected] = useState<string[]>(pair?.garments.map((g) => g.id) ?? [])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    setError(null)
    const body = { name: name.trim(), occasion: occasion || null, labels, notes: notes || null, favorite, garment_ids: selected }
    try {
      if (pair) await api.updatePair(pair.id, body)
      else await api.createPair(body)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setSaving(false)
    }
  }

  const options = garments.data ?? []

  return (
    <Modal
      title={pair ? `Edit ${pair.name}` : 'New pair'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={saving || !name.trim() || selected.length === 0} onClick={save}>
            {saving ? 'Saving…' : 'Save pair'}
          </button>
        </>
      }
    >
      <ErrorBanner message={error ?? garments.error} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="p-name">Name</label>
          <input id="p-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Monday office" autoFocus />
        </div>
        <div>
          <label className="label" htmlFor="p-occ">Occasion</label>
          <input id="p-occ" className="input" value={occasion} onChange={(e) => setOccasion(e.target.value)} placeholder="Office, party…" />
        </div>
        <div className="sm:col-span-2">
          <span className="label">Labels</span>
          <TagInput value={labels} onChange={setLabels} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="p-notes">Notes</label>
          <input id="p-notes" className="input" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} className="accent-indigo-600" />
          Favourite
        </label>
      </div>
      <span className="label">Garments</span>
      {garments.loading ? <Spinner /> : <GarmentPicker garments={options} selected={selected} onChange={setSelected} />}
    </Modal>
  )
}
