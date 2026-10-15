// This device's connection to the user's own Supabase project (their "vault").
// Secrets live in the platform's encrypted storage (Android Keystore) on the phone; the
// web build falls back to the browser's storage.
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { Capacitor } from '@capacitor/core'
import { useEffect, useState } from 'react'
import * as ai from '../engine/ai'
import { type Backend, SCHEMA_VERSION, SupabaseBackend, type VaultStatus } from '../engine/backend'
import { ApiError } from '../engine/errors'
import { WardrobeService, aiModels } from '../engine/service'

export interface Connection {
  supabaseUrl: string
  anonKey: string
  passphrase: string
  groqKey: string | null
  visionModel: string
  textModel: string
}

const KEY = 'closetiq.connection'
export const isNative = Capacitor.isNativePlatform()

export async function loadConnection(): Promise<Connection | null> {
  try {
    const raw = await SecureStorage.get(KEY)
    if (!raw || typeof raw !== 'object') return null
    const c = raw as Partial<Connection>
    if (!c.supabaseUrl || !c.anonKey || !c.passphrase) return null
    return {
      supabaseUrl: c.supabaseUrl,
      anonKey: c.anonKey,
      passphrase: c.passphrase,
      groqKey: c.groqKey ?? null,
      visionModel: c.visionModel || ai.DEFAULT_VISION_MODEL,
      textModel: c.textModel || ai.DEFAULT_TEXT_MODEL,
    }
  } catch {
    return null
  }
}

export async function saveConnection(c: Connection): Promise<void> {
  await SecureStorage.set(KEY, c as unknown as Record<string, unknown>)
}

export async function forgetConnection(): Promise<void> {
  try {
    await SecureStorage.remove(KEY)
  } catch {
    /* already gone */
  }
}

/** "abcd.supabase.co" -> "https://abcd.supabase.co"; also accepts a bare project ref. */
export function normalizeUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '')
  if (/^[a-z0-9]{20}$/.test(url)) url = `${url}.supabase.co`
  if (!/^https?:\/\//.test(url)) url = `https://${url}`
  return url.replace(/\/(rest|auth)\/v1.*$/, '')
}

export function projectRef(url: string): string | null {
  return url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1] ?? null
}

/** Check URL + key without a passphrase (used during setup). */
export async function probe(url: string, anonKey: string, passphrase = ''): Promise<VaultStatus> {
  try {
    return await new SupabaseBackend(url, anonKey, passphrase).status()
  } catch (e) {
    if (e instanceof ApiError) throw e
    throw new ApiError(503, "Couldn't reach that Supabase project. Check the URL and your internet connection.", 'unreachable')
  }
}

// --- The active session ----------------------------------------------------------------------

let service: WardrobeService | null = null
let current: Connection | null = null
const listeners = new Set<() => void>()

export function getService(): WardrobeService {
  if (!service) throw new ApiError(503, 'Not connected to your vault yet.', 'not_connected')
  return service
}

export const currentConnection = () => current

function applyAi(c: Connection): void {
  ai.setAiConfig({ apiKey: c.groqKey, visionModel: c.visionModel, textModel: c.textModel })
  aiModels.vision = c.visionModel
  aiModels.text = c.textModel
}

/** Connect with saved or new details and load the wardrobe. */
export async function activate(c: Connection, backend?: Backend): Promise<WardrobeService> {
  const b = backend ?? new SupabaseBackend(c.supabaseUrl, c.anonKey, c.passphrase)
  const status = await b.status()
  if (!status.installed) throw new ApiError(503, 'The setup script has not been run in this Supabase project yet.', 'not_installed')
  if ((status.schema_version ?? 0) < SCHEMA_VERSION) {
    throw new ApiError(503, 'This app needs an updated setup script. Run the latest one from the app in Supabase.', 'schema_outdated')
  }
  if (!status.authorized) throw new ApiError(401, 'Wrong vault passphrase.', 'passphrase')
  const svc = new WardrobeService(b)
  await svc.reload()
  applyAi(c)
  service = svc
  current = c
  for (const fn of listeners) fn()
  return svc
}

/** Update keys/models that don't need reconnecting (e.g. the Groq key). */
export async function updateConnection(patch: Partial<Connection>): Promise<void> {
  if (!current) return
  current = { ...current, ...patch }
  await saveConnection(current)
  applyAi(current)
  for (const fn of listeners) fn()
}

export async function deactivate(): Promise<void> {
  await forgetConnection()
  service = null
  current = null
  ai.setAiConfig({ apiKey: null, visionModel: ai.DEFAULT_VISION_MODEL, textModel: ai.DEFAULT_TEXT_MODEL })
  for (const fn of listeners) fn()
}

/** Re-render on connect, disconnect and connection changes. */
export function useConnection(): { service: WardrobeService | null; connection: Connection | null } {
  const [, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((t) => t + 1)
    listeners.add(bump)
    return () => {
      listeners.delete(bump)
    }
  }, [])
  return { service, connection: current }
}
