# ClosetIQ

A personal wardrobe manager for Android. It tracks every garment through wearing, laundry baskets, drying and ironing, and builds realistic weekly plans from your routines, calendar and the weather. See [Plan.txt](Plan.txt) for the original product plan.

**To install it on your phone, see [INSTALL.md](INSTALL.md).**

## How it works

There's no ClosetIQ server and no sign-up. Each person brings their own free **Supabase** project (their "vault") and, optionally, their own free **Groq** key for AI:

```
 Phone app (all the logic)  ──HTTPS──▶  your Supabase project (your data, nobody else's)
                            ──HTTPS──▶  Groq (only when you press an AI button)
                            ──HTTPS──▶  Open-Meteo (weather for your city)
```

- Share the APK with a friend. They connect it to *their* Supabase project and only ever see their own wardrobe.
- Install it on a second phone and enter the same Supabase details. You get the same wardrobe, because the data lives in the cloud.
- Settings lets you change the Supabase project, passphrase, Groq key and models at any time.

### Security model

- **Vault passphrase.** The Supabase anon key alone can't read anything. Every request also carries your passphrase, and the database checks it against a bcrypt hash before returning any row (row-level security). All writes go through one `security definer` function that checks the passphrase again, whitelists tables and applies the change atomically with optimistic locking.
- **On the phone.** The Supabase URL and key, the passphrase and the Groq key are stored with Android Keystore encryption. They are excluded from Android backups and device transfer.
- **App lock.** Optional fingerprint, face or PIN lock when the app opens, and again after more than 2 minutes in the background.
- **Hardening.** HTTPS only (no cleartext or mixed content), a strict Content-Security-Policy (no remote scripts), release builds without WebView debugging, and AI output that is sanitised and never saved without confirmation.

## Features

| | Feature | Where |
|---|---|---|
| 1 | **Wardrobe:** garments with photos (camera or gallery), labels, occasions, seasons, weather, fabric, price and notes, grouped by category. | Wardrobe |
| 2 | **Lifecycle:** 9 garment states, wear counts and reuse limits. A garment glows yellow once worn and becomes not ready at its limit. Manual override and full history. **Pairs:** saved combinations that show why they can't be worn right now. | Wardrobe, Pairs |
| 3 | **Laundry baskets:** Pending → In progress → Completed, scheduling and per-garment outcomes. **One permanent ironing basket** that washed clothes join automatically. Drying queue. | Laundry, Today |
| 4 | **Outfit ideas:** scored by colour, formality, occasion, weather, ratings and recency. **AI:** photo → garment details, plus "why this works" notes. | Outfits |
| 5 | **Routines:** describe your week in plain words, AI turns it into editable rules, then a feasibility check runs. | Routines |
| 6 | **Calendar:** a month view, holidays, and events with dress codes or reserved outfits. **Weather:** Open-Meteo forecast plus your own reports. | Calendar, Plan |
| 7 | **Weekly planner:** simulates availability day by day (baskets coming back, laundry days, drying, ironing), with lockable days, partial re-planning and "what if I wash this basket on…". | Plan, Laundry |
| 8 | **Coverage check:** looks ahead to a week or your next laundry, whichever is later, warns when clean clothes will run short and suggests tested fixes. | Plan, Today |
| 9 | **Insights:** wear stats, cost per wear, declutter, trip packing list and a before-you-buy check. | Insights |
| 📱 | **Phone notifications:** a morning briefing (what to wear, what's due) and an evening "get ready for tomorrow", at times you choose. Tapping one opens the right screen. | Settings |
| 💾 | **Backup:** export everything (photos included) to a file and share it, or restore from one. Backups from the old website version can be restored too. | Settings |

The rules that decide availability are deterministic code (`frontend/src/engine/lifecycle.ts`, `planner.ts`). AI only suggests: it never changes a garment's state or invents clothes.

## Develop

Needs Node.js 22+.

```powershell
cd frontend
npm install
npm run dev          # http://localhost:5173 (same app in the browser; uses localStorage instead of Keystore)
npm test             # 84 tests: the engine runs against the real SQL setup script in PGlite (Postgres in WASM)
npm run typecheck
npm run build
```

The browser build is for development. Phone features (notifications, app lock, Keystore, camera prompt) fall back gracefully there.

### Building the APK

GitHub Actions ([.github/workflows/android.yml](.github/workflows/android.yml)) tests the app and builds the APK on every push. The APK appears under the run's **Artifacts**. Pushing a tag such as `v1.0.0` also publishes it as a **GitHub Release**, which is the easiest link to send friends.

Release APKs are signed with a key from three repository secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`. Without them, CI builds a debug-signed APK instead. Always sign with the **same key**, otherwise phones can't update over an existing install. Never commit the key.

To build locally instead (needs Android Studio / JDK 21): `npm run build && npx cap sync android`, then `cd android && ./gradlew assembleDebug`.

### Database changes

[supabase/closetiq.sql](supabase/closetiq.sql) is idempotent: it is safe to run again, and it keeps data. If you change it, bump `SCHEMA_VERSION` in `frontend/src/engine/backend.ts` and the version the script writes. The app then asks people to re-run the script (Settings → Setup script).

## Layout

```
frontend/
  src/engine/        all the wardrobe logic (lifecycle, planner, outfits, coverage, insights, AI, weather)
    service.ts       the app's "API": one method per action, atomic writes to Supabase
    backend.ts       Supabase access (passphrase header, RPC writes)
    __tests__/       vitest suite running against real Postgres (PGlite)
  src/pages/         one file per screen (Setup = first-run wizard, Settings)
  src/lib/           connection (vault, Keystore), device (notifications, app lock), API wrapper
  android/           Capacitor Android project
supabase/closetiq.sql  the one-time setup script each person runs in their Supabase project
```

The FastAPI + Render + Vercel version that came before is preserved at the git tag `server-v1`.
