// Phone-only features: app lock (fingerprint / face / device PIN) and local notifications.
// Everything degrades gracefully on the web build.
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth'
import { SecureStorage } from '@aparajita/capacitor-secure-storage'
import { LocalNotifications } from '@capacitor/local-notifications'
import type { WardrobeService } from '../engine/service'
import { addDays, localToday } from '../engine/time'
import { isNative } from './connection'

// --- App lock -----------------------------------------------------------------------------

const LOCK_KEY = 'closetiq.applock'

export async function lockEnabled(): Promise<boolean> {
  if (!isNative) return false
  try {
    return (await SecureStorage.get(LOCK_KEY)) === true
  } catch {
    return false
  }
}

export async function lockAvailable(): Promise<boolean> {
  if (!isNative) return false
  try {
    const r = await BiometricAuth.checkBiometry()
    return r.isAvailable || r.deviceIsSecure
  } catch {
    return false
  }
}

/** Ask for fingerprint / face / device PIN. Resolves true when unlocked. */
export async function unlockApp(reason = 'Unlock ClosetIQ'): Promise<boolean> {
  try {
    await BiometricAuth.authenticate({
      reason,
      androidTitle: 'Unlock ClosetIQ',
      androidSubtitle: 'Confirm it’s you to open your wardrobe',
      allowDeviceCredential: true,
    })
    return true
  } catch {
    return false
  }
}

export async function setLockEnabled(on: boolean): Promise<boolean> {
  if (on && !(await unlockApp('Turn on app lock'))) return false
  await SecureStorage.set(LOCK_KEY, on)
  return true
}

// --- Notifications ---------------------------------------------------------------------------

/** Per-device notification settings (kept on the phone, not synced). */
export interface NotifyPrefs {
  enabled: boolean
  morningTime: string // "07:30": daily outfit + reminders briefing
  eveningTime: string // "20:30": prepare for tomorrow (ironing, laundry)
}

const PREFS_KEY = 'closetiq.notify'
export const DEFAULT_NOTIFY: NotifyPrefs = { enabled: true, morningTime: '07:30', eveningTime: '20:30' }

export function loadNotifyPrefs(): NotifyPrefs {
  try {
    return { ...DEFAULT_NOTIFY, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return DEFAULT_NOTIFY
  }
}

export function saveNotifyPrefs(p: NotifyPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p))
  } catch {
    /* not persisted */
  }
}

export async function notificationPermission(request = false): Promise<'granted' | 'denied' | 'prompt' | 'unsupported'> {
  if (!isNative) return 'unsupported'
  try {
    const status = request ? await LocalNotifications.requestPermissions() : await LocalNotifications.checkPermissions()
    return status.display === 'granted' ? 'granted' : status.display === 'denied' ? 'denied' : 'prompt'
  } catch {
    return 'unsupported'
  }
}

function at(date: string, time: string): Date {
  const [h, m] = time.split(':').map(Number)
  const [y, mo, d] = date.split('-').map(Number)
  return new Date(y, mo - 1, d, h, m, 0)
}

const ids = { morning: 1000, evening: 2000 }

/**
 * Schedule the next few days of reminders from the current data. Called on start, on
 * resume, and after changes. Messages are computed now (the phone shows them later even
 * if the app is closed), so they're refreshed whenever the app runs.
 */
export async function rescheduleNotifications(service: WardrobeService): Promise<number> {
  if (!isNative) return 0
  const prefs = loadNotifyPrefs()
  try {
    const pending = await LocalNotifications.getPending()
    if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) })
    if (!prefs.enabled || (await notificationPermission()) !== 'granted') return 0

    const today = localToday()
    const now = new Date()
    const out: Parameters<typeof LocalNotifications.schedule>[0]['notifications'] = []
    const plan = await service.plan(today, 3, today)
    for (let i = 0; i < 3; i++) {
      const day = addDays(today, i)
      // Morning: what to wear + today's reminders.
      const morningAt = at(day, prefs.morningTime)
      if (morningAt > now) {
        const outfit = plan.days[i]?.slots.filter((s) => s.garments.length && s.status === 'planned').map((s) => `${s.title}: ${s.garments.map((g) => g.name).join(' + ')}`)
        const notes = (await service.notifications(day)).filter((r) => !r.message.startsWith('Tomorrow'))
        const body = [outfit?.length ? outfit.join(' · ') : null, ...notes.slice(0, 2).map((n) => n.message)].filter(Boolean).join('\n')
        if (body) {
          out.push({ id: ids.morning + i, title: i === 0 ? 'Good morning! Today in your wardrobe' : 'Today in your wardrobe', body, largeBody: body, schedule: { at: morningAt, allowWhileIdle: true }, extra: { link: '/' } })
        }
      }
      // Evening: get ready for tomorrow (ironing, laundry due, events).
      const eveningAt = at(day, prefs.eveningTime)
      if (eveningAt > now) {
        const tomorrow = await service.notifications(day)
        const prep = tomorrow.filter((r) => r.message.includes('tomorrow') || r.message.startsWith('Tomorrow') || r.group === 'laundry')
        if (prep.length) {
          const body = prep.slice(0, 3).map((r) => r.message).join('\n')
          out.push({ id: ids.evening + i, title: 'Get ready for tomorrow', body, largeBody: body, schedule: { at: eveningAt, allowWhileIdle: true }, extra: { link: prep[0].link } })
        }
      }
    }
    if (out.length) await LocalNotifications.schedule({ notifications: out })
    return out.length
  } catch {
    return 0
  }
}

/** Tapping a notification opens the page it's about. */
export function onNotificationTap(navigate: (path: string) => void): () => void {
  if (!isNative) return () => undefined
  const handle = LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
    const link = (e.notification.extra as { link?: string } | undefined)?.link
    if (link) navigate(link)
  })
  return () => void handle.then((h) => h.remove())
}
