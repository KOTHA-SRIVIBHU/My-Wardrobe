# Deploying ClosetIQ

This guide takes ClosetIQ from your PC to the internet using free tiers:

| Piece | Service | What it does |
|---|---|---|
| Website | **Vercel** | Serves the app you open in the browser |
| API | **Render** | Runs the Python backend |
| Database, photos, login | **Supabase** | Stores everything, handles sign-up / sign-in |
| AI | **Groq** | Photo suggestions, routines, briefs (optional) |

Plan on about an hour. Steps 1–2 can be done in any order; 3 → 4 → 5 must be done in order.

> **Keep secrets out of chat and out of git.** Paste keys only into the service dashboards
> (or the git-ignored `backend/.env` / `backend/.env.test` files on your PC).

---

## 0. Before you start

- **Rotate your Groq key.** The current one was shared in a chat, so create a new key at
  <https://console.groq.com/keys>, delete the old one, and use the new key below.
- Install **Git**: <https://git-scm.com/download/win> (defaults are fine), then close and
  reopen VS Code.

## 1. Put the code on GitHub

1. Create a free account at <https://github.com> and a **new private repository** called
   `closetiq`. Don't add a README or .gitignore (the project has them).
2. In a terminal in the project folder:
   ```powershell
   git init
   git add .
   git commit -m "ClosetIQ"
   git branch -M main
   git remote add origin https://github.com/<your-username>/closetiq.git
   git push -u origin main
   ```
3. Check on GitHub that **`backend/.env` is not there** (it's git-ignored on purpose).
4. Open the **Actions** tab: the CI workflow should go green (tests + build).

## 2. Create the Supabase project

1. Sign up at <https://supabase.com> → **New project**.
   - Region: the one closest to you (e.g. *Mumbai* or *Singapore*).
   - Save the **database password** somewhere safe.
2. Collect these values (Project Settings):

   | Value | Where | Used by |
   |---|---|---|
   | Project URL | *Data API* / *API* | Render `SUPABASE_URL`, Vercel `VITE_SUPABASE_URL` |
   | anon / publishable key | *API Keys* | Vercel `VITE_SUPABASE_ANON_KEY` |
   | service_role / secret key | *API Keys* | Render `SUPABASE_SERVICE_KEY` (**never** in the frontend) |
   | Connection string, **Session pooler** | *Connect* → *Session pooler* (put your DB password in it) | Render `DATABASE_URL` |

   Use the **Session pooler** string (port 5432, host `...pooler.supabase.com`): Render's free
   tier can't reach Supabase's direct (IPv6-only) address.

3. *(Optional but recommended)* Let me test against real Postgres: create
   `backend/.env.test` on your PC containing `TEST_DATABASE_URL=<session pooler string>`.
   The tests use their own `closetiq_test` schema and never touch the app's tables.

## 3. Deploy the API on Render

1. Sign up at <https://render.com> with your GitHub account.
2. **New → Blueprint** → pick the `closetiq` repo. Render reads `render.yaml`.
3. Fill in the secret values it asks for:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | Supabase session pooler string |
   | `SUPABASE_URL` | Supabase project URL |
   | `SUPABASE_SERVICE_KEY` | Supabase service_role / secret key |
   | `GROQ_API_KEY` | your **new** Groq key (leave empty to run without AI) |
   | `CORS_ORIGINS` | `https://example.com` for now (fixed in step 5) |

4. Deploy. When it's live, open `https://<service>.onrender.com/api/health?deep=true`.
   You should see `"status":"ok"` and `"database":"ok"`.

   The `region` in `render.yaml` is Singapore. If your Supabase project is elsewhere, edit
   it before step 2 so the API sits near the database.

## 4. Lock down the database (once)

Supabase dashboard → **SQL Editor** → paste the contents of [`supabase/setup.sql`](supabase/setup.sql) → **Run**.

This turns on row-level security for every table (only the API can read them) and creates
the private `garment-images` photo bucket. It must run **after** step 3, because the API
creates the tables on its first start.

## 5. Deploy the website on Vercel

1. Sign up at <https://vercel.com> with GitHub → **Add New → Project** → import `closetiq`.
2. **Root Directory:** `frontend` (framework is detected as Vite).
3. Environment variables:

   | Key | Value |
   |---|---|
   | `VITE_API_URL` | `https://<service>.onrender.com` (no trailing slash) |
   | `VITE_SUPABASE_URL` | Supabase project URL |
   | `VITE_SUPABASE_ANON_KEY` | Supabase anon / publishable key |

4. Deploy. Note your site address, e.g. `https://closetiq-yourname.vercel.app`.
5. Connect the pieces:
   - **Render** → your service → Environment → set `CORS_ORIGINS` to the Vercel address → save (it redeploys).
   - **Supabase** → Authentication → URL Configuration:
     - **Site URL**: the Vercel address
     - **Redirect URLs**: add the Vercel address (confirmation and password-reset emails link here)

## 6. Try it

1. Open the Vercel address → **Create account** → confirm via the email → sign in.
2. Add a garment with a photo, try **✨ Suggest details**, add a routine, open the Plan.
3. Insights → Account shows your email and today's AI usage.

## 7. Recommended extras

- **Email sending.** Supabase's built-in email is for testing and only sends a few
  emails per hour. With open sign-up, set up custom SMTP (Authentication → Emails → SMTP),
  e.g. a free [Resend](https://resend.com) or [Brevo](https://www.brevo.com) account.
- **Faster first load.** Free Render services sleep after ~15 idle minutes, so the next visit
  waits ~30–60 s. A free [UptimeRobot](https://uptimerobot.com) HTTP monitor on
  `https://<service>.onrender.com/api/health` every 5 minutes keeps it awake (one service
  fits in Render's free 750 hours/month).
- **Keep Supabase active.** Free projects pause after a week without activity. Either the
  monitor above or the included daily GitHub workflow prevents that: on GitHub, go to
  Settings → Secrets and variables → Actions → **Variables** and add `API_URL` = your Render address.

## Updating later

Push to `main`. GitHub runs the tests, and Render and Vercel redeploy automatically. New
database columns and indexes are added automatically when the API starts.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Site loads but every action fails / "Failed to fetch" | `CORS_ORIGINS` on Render doesn't exactly match the Vercel address, or `VITE_API_URL` is wrong (redeploy Vercel after changing env vars). |
| "Invalid or expired token" | `SUPABASE_URL` differs between Render and Vercel, or you're using keys from different projects. |
| Health shows `"database":"unreachable"` | Wrong `DATABASE_URL`: use the **Session pooler** string with your real password. |
| Confirmation email never arrives | Built-in Supabase email limit: wait, or set up custom SMTP (step 7). |
| Photos don't appear | `setup.sql` not run (bucket missing) or wrong `SUPABASE_SERVICE_KEY`. |
| First request after a while is slow | Render free tier waking up (step 7). |
| AI buttons say the daily limit is used | Per-user fair-use limit (`AI_DAILY_LIMIT_PER_USER` on Render). |
