import { useState, type FormEvent } from 'react'
import { useAi } from '../App'
import { api, downscaleImage, type GarmentInput } from '../lib/api'
import { capitalize } from '../lib/format'
import type { Classification, Garment, IroningPolicy, Meta } from '../lib/types'
import { ErrorBanner, Modal, TagInput } from './ui'
import { PhotoPicker, PhotoPreview } from './PhotoPicker'

const IRONING_LABELS: Record<IroningPolicy, string> = {
  not_required: 'Not required',
  required: 'Required after washing',
  optional: 'Optional',
  user_decides: 'I decide after washing',
}

/** Create or edit a garment. New garments can attach a photo in the same step. */
export function GarmentForm({
  meta,
  labels,
  garment,
  onClose,
  onSaved,
}: {
  meta: Meta
  labels: string[]
  garment?: Garment
  onClose: () => void
  onSaved: (g: Garment) => void
}) {
  const [f, setF] = useState({
    name: garment?.name ?? '',
    category: garment?.category ?? 'shirt',
    subcategory: garment?.subcategory ?? '',
    color: garment?.color ?? '',
    pattern: garment?.pattern ?? '',
    labels: garment?.labels ?? [],
    occasions: garment?.occasions ?? [],
    formality: garment?.formality?.toString() ?? '',
    seasons: garment?.seasons ?? [],
    weather: garment?.weather ?? [],
    fabric: garment?.fabric ?? '',
    comfort_notes: garment?.comfort_notes ?? '',
    // Empty string = use category default (new garments only).
    max_wears: garment ? (garment.max_wears_before_wash?.toString() ?? 'never') : '',
    ironing_policy: (garment?.ironing_policy ?? '') as IroningPolicy | '',
    purchase_date: garment?.purchase_date ?? '',
    purchase_price: garment?.purchase_price ?? '',
    notes: garment?.notes ?? '',
  })
  const [photo, setPhoto] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ai = useAi()
  const [suggesting, setSuggesting] = useState(false)
  const [aiNote, setAiNote] = useState<string | null>(null)
  // Fields the user has edited themselves; AI suggestions never overwrite these.
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => {
    setF((p) => ({ ...p, [k]: v }))
    setTouched((t) => (t.has(k) ? t : new Set(t).add(k)))
  }

  async function suggest() {
    if (!photo) return
    setSuggesting(true)
    setError(null)
    setAiNote(null)
    try {
      applySuggestion(await api.classify(photo))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSuggesting(false)
    }
  }

  function applySuggestion(c: Classification) {
    const filled: string[] = []
    const next = { ...f }
    const text = { name: c.name, subcategory: c.subcategory, color: c.color, pattern: c.pattern, fabric: c.fabric }
    for (const [k, v] of Object.entries(text) as [keyof typeof text, string | null][]) {
      if (v && !touched.has(k) && !f[k]) {
        next[k] = v
        filled.push(k)
      }
    }
    if (!touched.has('category') && !garment) {
      next.category = c.category
      filled.push('category')
    }
    if (c.formality && !touched.has('formality') && !f.formality) {
      next.formality = String(c.formality)
      filled.push('formality')
    }
    for (const k of ['labels', 'occasions', 'seasons', 'weather'] as const) {
      const merged = [...new Set([...f[k], ...c[k]])]
      if (merged.length > f[k].length) {
        next[k] = merged
        filled.push(k)
      }
    }
    setF(next)
    setAiNote(
      filled.length
        ? 'Filled in details from the photo. Please check them before saving.'
        : 'The AI had nothing to add to what you already entered.',
    )
  }

  const catDefault = meta.categories.find((c) => c.value === f.category)
  const knownCategory = meta.categories.some((c) => c.value === f.category)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    const body: GarmentInput = {
      name: f.name.trim(),
      category: f.category.trim(),
      subcategory: f.subcategory || null,
      color: f.color || null,
      pattern: f.pattern || null,
      labels: f.labels,
      occasions: f.occasions,
      formality: f.formality ? Number(f.formality) : null,
      seasons: f.seasons,
      weather: f.weather,
      fabric: f.fabric || null,
      comfort_notes: f.comfort_notes || null,
      purchase_date: f.purchase_date || null,
      purchase_price: f.purchase_price || null,
      notes: f.notes || null,
    }
    if (f.max_wears) body.max_wears_before_wash = f.max_wears === 'never' ? null : Number(f.max_wears)
    if (f.ironing_policy) body.ironing_policy = f.ironing_policy
    try {
      let saved = garment ? await api.updateGarment(garment.id, body) : await api.createGarment(body)
      if (photo) saved = await api.uploadImage(saved.id, photo)
      onSaved(saved)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  const toggle = (k: 'seasons' | 'weather', v: string) =>
    set(k, f[k].includes(v) ? f[k].filter((x) => x !== v) : [...f[k], v])

  return (
    <Modal
      title={garment ? `Edit ${garment.name}` : 'Add garment'}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-secondary" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="btn btn-primary" form="garment-form" disabled={saving || !f.name.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <ErrorBanner message={error} />
      {aiNote && <p className="mb-4 rounded-lg bg-indigo-50 px-4 py-3 text-sm text-indigo-900">✨ {aiNote}</p>}
      <form id="garment-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {!garment && (
          <div className="sm:col-span-2 rounded-lg border border-dashed border-slate-300 p-3">
            <p className="label">Photo (optional)</p>
            <div className="flex flex-wrap items-center gap-3">
              <PhotoPicker onPick={async (file) => setPhoto(await downscaleImage(file, 1280))}>
                {photo ? 'Change photo' : '📷 Add photo'}
              </PhotoPicker>
              {photo && <PhotoPreview file={photo} />}
              {ai?.enabled && (
                <button type="button" className="btn btn-secondary" disabled={!photo || suggesting} onClick={suggest}>
                  {suggesting ? 'Looking…' : '✨ Suggest details'}
                </button>
              )}
            </div>
            {ai && !ai.enabled && (
              <p className="mt-2 text-xs text-slate-500">AI suggestions are off (add a Groq key in Settings). You can fill the details in yourself.</p>
            )}
          </div>
        )}
        <div className="sm:col-span-2">
          <label className="label" htmlFor="g-name">Name</label>
          <input id="g-name" className="input" value={f.name} onChange={(e) => set('name', e.target.value)} required autoFocus placeholder="e.g. White Oxford shirt" />
        </div>
        <div>
          <label className="label" htmlFor="g-cat">Category</label>
          <select id="g-cat" className="input" value={knownCategory ? f.category : '__custom'} onChange={(e) => set('category', e.target.value === '__custom' ? '' : e.target.value)}>
            {meta.categories.map((c) => (
              <option key={c.value} value={c.value}>{capitalize(c.value)}</option>
            ))}
            <option value="__custom">Other (type below)…</option>
          </select>
          {!knownCategory && (
            <input className="input mt-2" value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="Custom category" required />
          )}
        </div>
        <div>
          <label className="label" htmlFor="g-sub">Subcategory</label>
          <input id="g-sub" className="input" value={f.subcategory} onChange={(e) => set('subcategory', e.target.value)} placeholder="e.g. Oxford, polo" />
        </div>
        <div>
          <label className="label" htmlFor="g-color">Color</label>
          <input id="g-color" className="input" value={f.color} onChange={(e) => set('color', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="g-pattern">Pattern</label>
          <input id="g-pattern" className="input" value={f.pattern} onChange={(e) => set('pattern', e.target.value)} placeholder="Solid, striped, checked…" />
        </div>
        <div className="sm:col-span-2">
          <span className="label">Labels</span>
          <TagInput value={f.labels} onChange={(v) => set('labels', v)} suggestions={[...new Set([...labels, ...meta.suggested_labels])]} placeholder="Office, Party…" />
        </div>
        <div className="sm:col-span-2">
          <span className="label">Occasions</span>
          <TagInput value={f.occasions} onChange={(v) => set('occasions', v)} placeholder="Work, wedding, gym…" />
        </div>
        <div>
          <label className="label" htmlFor="g-formality">Formality</label>
          <select id="g-formality" className="input" value={f.formality} onChange={(e) => set('formality', e.target.value)}>
            <option value="">Not set</option>
            <option value="1">1 · Very casual</option>
            <option value="2">2 · Casual</option>
            <option value="3">3 · Smart casual</option>
            <option value="4">4 · Business</option>
            <option value="5">5 · Formal</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="g-fabric">Fabric</label>
          <input id="g-fabric" className="input" value={f.fabric} onChange={(e) => set('fabric', e.target.value)} placeholder="Cotton, linen…" />
        </div>
        <div className="sm:col-span-2">
          <span className="label">Seasons & weather</span>
          <div className="flex flex-wrap gap-1.5">
            {meta.seasons.map((s) => (
              <Chip key={s} on={f.seasons.includes(s)} onClick={() => toggle('seasons', s)}>{s}</Chip>
            ))}
            <span className="mx-1 border-l border-slate-200" />
            {meta.weather.map((w) => (
              <Chip key={w} on={f.weather.includes(w)} onClick={() => toggle('weather', w)}>{w}</Chip>
            ))}
          </div>
        </div>
        <div>
          <label className="label" htmlFor="g-wears">Wash after</label>
          <select id="g-wears" className="input" value={f.max_wears} onChange={(e) => set('max_wears', e.target.value)}>
            {!garment && (
              <option value="">
                Category default ({catDefault ? (catDefault.max_wears_before_wash ?? 'never') : 1}
                {catDefault?.max_wears_before_wash ? ' wears' : ''})
              </option>
            )}
            {[1, 2, 3, 4, 5, 7, 10, 15, 20].map((n) => (
              <option key={n} value={n}>{n === 1 ? 'Every wear' : `${n} wears`}</option>
            ))}
            <option value="never">Never (e.g. shoes)</option>
          </select>
        </div>
        <div>
          <label className="label" htmlFor="g-iron">Ironing</label>
          <select id="g-iron" className="input" value={f.ironing_policy} onChange={(e) => set('ironing_policy', e.target.value as IroningPolicy | '')}>
            {!garment && <option value="">Category default ({IRONING_LABELS[catDefault?.ironing_policy ?? 'not_required'].toLowerCase()})</option>}
            {meta.ironing_policies.map((p) => (
              <option key={p} value={p}>{IRONING_LABELS[p]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="g-pdate">Purchase date</label>
          <input id="g-pdate" type="date" className="input" value={f.purchase_date} onChange={(e) => set('purchase_date', e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="g-price">Price</label>
          <input id="g-price" type="number" min="0" step="0.01" className="input" value={f.purchase_price} onChange={(e) => set('purchase_price', e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="g-comfort">Comfort notes</label>
          <input id="g-comfort" className="input" value={f.comfort_notes} onChange={(e) => set('comfort_notes', e.target.value)} placeholder="Runs warm, a bit tight…" />
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor="g-notes">Notes</label>
          <textarea id="g-notes" className="input" rows={2} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>
      </form>
    </Modal>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`rounded-full border px-2.5 py-1 text-xs ${on ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
    >
      {children}
    </button>
  )
}
