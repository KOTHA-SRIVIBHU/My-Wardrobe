// Groq (free tier, OpenAI-compatible), called directly from the device with the user's
// own key. AI output is treated as untrusted suggestions: everything is sanitised against
// the app's vocabularies and nothing is saved until the user confirms.
import type { Classification, RoutineDraft } from '../lib/types'
import { ApiError } from './errors'
import { CATEGORY_DEFAULTS } from './lifecycle'
import { OCCASIONS, PATTERNS, SEASONS, SUGGESTED_LABELS, WEATHER, canonical } from './vocab'

export interface AiConfig {
  apiKey: string | null
  visionModel: string
  textModel: string
}

export const DEFAULT_VISION_MODEL = 'qwen/qwen3.8-27b'
export const DEFAULT_TEXT_MODEL = 'openai/gpt-oss-120b'
const BASE_URL = 'https://api.groq.com/openai/v1'

let config: AiConfig = { apiKey: null, visionModel: DEFAULT_VISION_MODEL, textModel: DEFAULT_TEXT_MODEL }
export const setAiConfig = (c: AiConfig) => {
  config = c
}
export const aiEnabled = () => !!config.apiKey

export class NotClothing extends ApiError {
  constructor() {
    super(422, "That photo doesn't seem to show a garment.", 'not_clothing')
  }
}

const unavailable = (message: string, code: string, retry: number | null = null) => new ApiError(503, message, code, retry)

/** Single HTTP seam, replaceable in tests. */
export const transport = {
  post: async (body: unknown): Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }> =>
    fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
}

function modelOptions(model: string): Record<string, string> {
  // Reasoning models spend tokens thinking first: keep it off/short.
  if (model.startsWith('qwen/')) return { reasoning_effort: 'none' }
  if (model.startsWith('openai/gpt-oss')) return { reasoning_effort: 'low' }
  return {}
}

export function parseJson(text: string): Record<string, unknown> {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  const candidates = [cleaned]
  const m = cleaned.match(/\{[\s\S]*\}/)
  if (m) candidates.push(m[0])
  for (const c of candidates) {
    try {
      const data = JSON.parse(c)
      if (data && typeof data === 'object' && !Array.isArray(data)) return data
    } catch {
      /* try the next candidate */
    }
  }
  throw unavailable("The AI reply wasn't usable. Please try again.", 'ai_bad_output')
}

export async function chatJson(model: string, messages: unknown[], maxTokens = 600): Promise<Record<string, unknown>> {
  if (!aiEnabled()) throw unavailable('AI features are off. Add your Groq API key in Settings to use them.', 'ai_not_configured')
  const body = { model, messages, response_format: { type: 'json_object' }, temperature: 0.2, max_completion_tokens: maxTokens, ...modelOptions(model) }
  let r
  try {
    r = await transport.post(body)
  } catch {
    throw unavailable("Couldn't reach Groq. Check your internet connection and try again.", 'ai_unreachable')
  }
  if (r.status === 429) {
    const retry = Number.parseFloat(r.headers.get('retry-after') ?? '')
    const secs = Number.isFinite(retry) ? Math.trunc(retry) : null
    throw unavailable(`Groq's free-tier limit has been reached.${secs ? ` Try again in about ${secs} s.` : ' Try again later.'} Everything else keeps working.`, 'ai_quota', secs)
  }
  if (r.status === 401 || r.status === 403) throw unavailable('Groq rejected the API key. Check it in Settings.', 'ai_auth')
  if (r.status === 404) throw unavailable(`Groq doesn't offer the model '${model}' any more. Pick another in Settings.`, 'ai_model')
  if (r.status >= 400) throw unavailable(`Groq returned an error (${r.status}).`, 'ai_error')
  let content = ''
  try {
    const data = (await r.json()) as { choices: { message: { content?: string } }[] }
    content = data.choices[0].message.content ?? ''
  } catch {
    throw unavailable("The AI reply wasn't usable. Please try again.", 'ai_bad_output')
  }
  return parseJson(content)
}

function text(v: unknown, maxLen: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.split(/\s+/).filter(Boolean).join(' ')
  return t.slice(0, maxLen) || null
}

function level(v: unknown): number | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : null
}

// --- Photo classification -------------------------------------------------------------

const CATEGORIES = Object.keys(CATEGORY_DEFAULTS)
const list = (xs: string[]) => JSON.stringify(xs)

const CLASSIFY_PROMPT = `You label clothing photos for a personal wardrobe app.
Describe the single main garment in the photo. Reply with a JSON object only, with these keys:
- "name": short descriptive name, e.g. "Light blue Oxford shirt"
- "category": one of ${list(CATEGORIES)}
- "subcategory": e.g. "Oxford", "polo", "chinos", or null
- "color": the main colour as one or two common words
- "pattern": one of ${list(PATTERNS)}
- "fabric": best guess or null
- "formality": integer 1-5 (1 very casual, 3 smart casual, 5 formal)
- "occasions": up to 4 of ${list(OCCASIONS)}
- "labels": up to 3 of ${list(SUGGESTED_LABELS)}
- "seasons": any of ${list(SEASONS)}
- "weather": any of ${list(WEATHER)}
If the photo does not show clothing, reply {"error": "not_clothing"}.`

export function sanitizeClassification(raw: Record<string, unknown>): Classification {
  if (raw.error === 'not_clothing') throw new NotClothing()
  const category = (text(raw.category, 40) ?? '').toLowerCase()
  const pattern = (text(raw.pattern, 40) ?? '').toLowerCase()
  return {
    name: text(raw.name, 120),
    category: category in CATEGORY_DEFAULTS ? category : 'other',
    subcategory: text(raw.subcategory, 60),
    color: (text(raw.color, 40) ?? '').toLowerCase() || null,
    pattern: PATTERNS.includes(pattern) ? pattern : null,
    fabric: text(raw.fabric, 60),
    formality: level(raw.formality),
    occasions: canonical(raw.occasions, OCCASIONS, 4),
    labels: canonical(raw.labels, SUGGESTED_LABELS, 3),
    seasons: canonical(raw.seasons, SEASONS),
    weather: canonical(raw.weather, WEATHER),
  }
}

export async function classifyImage(dataUrl: string): Promise<Classification> {
  const raw = await chatJson(
    config.visionModel,
    [{ role: 'user', content: [{ type: 'text', text: CLASSIFY_PROMPT }, { type: 'image_url', image_url: { url: dataUrl } }] }],
    400,
  )
  return sanitizeClassification(raw)
}

// --- Routine interpretation -------------------------------------------------------------

const DAY_NAMES: Record<string, number> = {}
;[['monday', 'mon'], ['tuesday', 'tue', 'tues'], ['wednesday', 'wed'], ['thursday', 'thu', 'thur', 'thurs'], ['friday', 'fri'], ['saturday', 'sat'], ['sunday', 'sun']]
  .forEach((names, i) => names.forEach((n) => (DAY_NAMES[n] = i)))

const interpretPrompt = (categories: string[]) => `You turn a person's description of their clothing routine into structured rules
for a wardrobe planner. Reply with a JSON object only:
{"routines": [{
    "name": short name, e.g. "Office days",
    "kind": "day" or "night",
    "weekdays": weekday numbers, 0=Monday ... 6=Sunday,
    "occasion": one of ${list(OCCASIONS)} or null,
    "formality": 1-5 or null (1 very casual, 5 formal),
    "mandatory": true unless the person says it is optional,
    "requirements": [{
        "category": one of ${list(categories)},
        "quantity": items needed per day,
        "min_formality": 1-5 or null,
        "reuse": "fixed" if the same item is worn every time (e.g. the same shoes all month), else "rotate",
        "no_consecutive": true only if they say not to repeat an item on consecutive days
    }]
}],
"questions": [short clarification questions, only if something important is ambiguous]}
Rules: a "pair" of socks, underwear or nightwear is quantity 1. A "formal shirt" is category
"shirt" with min_formality 4. Use only the listed categories; if an item fits none, ask about
it in "questions" instead of inventing a category. Night-time routines have kind "night".`

function weekdays(v: unknown): number[] {
  const out = new Set<number>()
  for (const x of Array.isArray(v) ? v : []) {
    if (typeof x === 'boolean') continue
    if (typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 6) out.add(x)
    else if (typeof x === 'string' && DAY_NAMES[x.trim().toLowerCase()] !== undefined) out.add(DAY_NAMES[x.trim().toLowerCase()])
  }
  return [...out].sort((a, b) => a - b)
}

export function sanitizeRoutines(raw: Record<string, unknown>, categories: string[]): { routines: RoutineDraft[]; questions: string[] } {
  const allowed = new Set(categories.map((c) => c.toLowerCase()))
  const questions = (Array.isArray(raw.questions) ? raw.questions : []).slice(0, 5).map((q) => text(q, 200)).filter((q): q is string => !!q)
  const routines: RoutineDraft[] = []
  for (const r of (Array.isArray(raw.routines) ? raw.routines : []).slice(0, 10)) {
    if (!r || typeof r !== 'object') continue
    const rr = r as Record<string, unknown>
    const name = text(rr.name, 120) ?? 'Routine'
    const requirements: RoutineDraft['requirements'] = []
    for (const req of (Array.isArray(rr.requirements) ? rr.requirements : []).slice(0, 15)) {
      if (!req || typeof req !== 'object') continue
      const q = req as Record<string, unknown>
      const category = (text(q.category, 40) ?? '').toLowerCase()
      if (!allowed.has(category)) {
        if (category) questions.push(`'${category}' in ${name} isn't one of your categories. Which category should it use?`)
        continue
      }
      const n = Math.trunc(Number(q.quantity || 1))
      requirements.push({
        category,
        quantity: Number.isFinite(n) ? Math.min(10, Math.max(1, n)) : 1,
        labels: [],
        min_formality: level(q.min_formality),
        reuse: q.reuse === 'fixed' ? 'fixed' : 'rotate',
        no_consecutive: q.no_consecutive === true,
      })
    }
    const days = weekdays(rr.weekdays)
    if (!days.length) questions.push(`Which days of the week does '${name}' apply to?`)
    const occasion = canonical([rr.occasion], OCCASIONS)
    routines.push({
      name,
      kind: rr.kind === 'night' ? 'night' : 'day',
      weekdays: days,
      occasion: occasion[0] ?? null,
      formality: level(rr.formality),
      mandatory: rr.mandatory !== false,
      requirements,
    })
  }
  return { routines, questions: [...new Set(questions)] }
}

export async function interpretRoutines(input: string, categories: string[]) {
  const raw = await chatJson(config.textModel, [{ role: 'system', content: interpretPrompt(categories) }, { role: 'user', content: input }], 2000)
  return sanitizeRoutines(raw, categories)
}

// --- Weekly brief & outfit explanations ---------------------------------------------------

const BRIEF_PROMPT = `You are a friendly wardrobe assistant. Below are facts computed by the user's
wardrobe planner: whether their clean clothes will last until laundry, shortages, suggested
fixes, and the planned outfits with weather. Write a short briefing for the coming days.
Use ONLY these facts: never invent garments, dates or numbers. Reply with a JSON object only:
{"summary": one or two sentences, "bullets": up to 5 short points about the days ahead,
 "tips": up to 3 short, practical tips (laundry timing, ironing, weather)}.`

const items = (raw: Record<string, unknown>, key: string, n: number, maxLen: number) =>
  (Array.isArray(raw[key]) ? (raw[key] as unknown[]) : []).slice(0, n).map((x) => text(x, maxLen)).filter((x): x is string => !!x)

export async function weeklyBrief(facts: unknown): Promise<{ summary: string; bullets: string[]; tips: string[] }> {
  const raw = await chatJson(config.textModel, [{ role: 'system', content: BRIEF_PROMPT }, { role: 'user', content: JSON.stringify(facts) }], 1500)
  const summary = text(raw.summary, 400)
  if (!summary) throw unavailable("The AI reply wasn't usable. Please try again.", 'ai_bad_output')
  return { summary, bullets: items(raw, 'bullets', 5, 220), tips: items(raw, 'tips', 3, 220) }
}

const EXPLAIN_PROMPT = `You are a concise personal stylist. The user has already chosen the outfit
below from clothes they own and that are clean and ready to wear. Explain briefly why it works
for the context. Only mention the listed garments; don't suggest buying anything.
Reply with a JSON object only: {"summary": one or two sentences, "tips": up to 2 short styling tips}.`

/** Only styling attributes are sent: no garment names, notes or personal data. */
export async function explainOutfit(garments: Record<string, unknown>[], context: Record<string, unknown>) {
  const raw = await chatJson(config.textModel, [{ role: 'system', content: EXPLAIN_PROMPT }, { role: 'user', content: JSON.stringify({ outfit: garments, context }) }], 1000)
  const summary = text(raw.summary, 400)
  if (!summary) throw unavailable("The AI reply wasn't usable. Please try again.", 'ai_bad_output')
  return { summary, tips: items(raw, 'tips', 2, 200) }
}
