# ClosetIQ

A personal wardrobe manager. It tracks every garment through wearing, laundry baskets, drying and ironing, and builds realistic weekly plans from your routines, calendar and the weather. See [Plan.txt](Plan.txt) for the full product plan.

## What's built

All nine roadmap phases of the plan:

| Phase | Feature | Where |
|---|---|---|
| 1 | **Wardrobe:** garments with photos, labels, occasions, seasons, weather, fabric, price and notes. Shown grouped by category. | Wardrobe |
| 2 | **Lifecycle:** 9 garment states, wear counts, per-category reuse rules, manual override and full history. **Pairs:** saved combinations that show why they can't be worn right now. | Wardrobe, Pairs |
| 3 | **Laundry baskets:** Pending → In Progress → Completed, scheduling, per-garment outcomes. **Drying and ironing** queues. | Laundry, Today |
| 4 | **Outfit ideas:** deterministic scoring by colour, formality, occasion, weather, ratings and recency. **AI:** photo → garment details, "why this works" notes. | Outfits |
| 5 | **Routines:** describe your week in plain words, AI turns it into editable rules, then a feasibility check. | Routines |
| 6 | **Calendar:** holidays skip daytime routines; events get dress-code outfits or a reserved outfit. **Weather:** Open-Meteo forecast, plus your own reports. | Calendar, Plan |
| 7 | **Weekly planner:** day-by-day availability simulation (baskets coming back, laundry days, drying, ironing prep), lockable days, partial re-planning, and "what if I wash this basket on…" simulation. | Plan, Laundry |
| 8 | **Insights:** wear stats, cost per wear, repeated outfits, trip packing list, before-you-buy check, and a reminders bell with per-type settings. | Insights, 🔔 |
| 9 | **Backup:** export everything (including photos) to one file, and restore it into any account. Automated tests and deployment configs. | Insights → Backup |
| + | **Ironing basket:** created automatically when washed clothes need ironing; empties as you iron, then closes itself. | Laundry |
| + | **Clothes coverage check:** checks your routines up to whichever is later, a week ahead or your next laundry coming back. Alerts you if clean clothes will run short and suggests tested fixes (e.g. "Wash 2 shirts on Wed"). Also gives recommended stock per routine and an optional AI weekly brief. | Plan, Today, 🔔 |
| + | **Declutter:** clothes not worn in 3+ months, with one-click archive. **Wear it:** one tap for today's planned outfit. | Insights, Today |

The rules that decide availability are deterministic code, mainly `backend/app/lifecycle.py` and `backend/app/planner.py`. AI only suggests; it never changes a garment's state or invents clothes.

## Run locally

Needs Python 3.11+ and Node.js 20+. No accounts are needed: local mode uses SQLite, stores photos on disk, and skips login.

```powershell
# Backend (from the repo root)
python -m venv .venv
.\.venv\Scripts\python -m pip install -r backend\requirements-dev.txt
cd backend
..\.venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
# API docs: http://localhost:8000/docs

# Frontend (second terminal)
cd frontend
npm install
npm run dev
# App: http://localhost:5173
```

Run the backend tests with `cd backend; ..\.venv\Scripts\python -m pytest`. Check the frontend with `cd frontend; npm run build`.

## AI (Groq, optional)

1. Create a free API key at https://console.groq.com/keys.
2. Put it in `backend/.env` as `GROQ_API_KEY=...` and restart the backend.
3. Defaults: `qwen/qwen3.8-27b` for photos (a Groq *preview* model) and `openai/gpt-oss-120b` for text. If Groq retires a model, the app tells you which one. Pick a replacement from https://console.groq.com/docs/models and set `GROQ_VISION_MODEL` / `GROQ_TEXT_MODEL`.

Without a key, or once the free quota is used up, the AI buttons explain why they're unavailable, and everything else keeps working. There's no fallback to any paid provider. The app sends Groq only what the AI needs:
- photos, only when you press "Suggest details";
- your routine text, only when you press "Turn into routines";
- for outfit notes, only category, colour, pattern, fabric and formality.

## Weather

On the Plan page, open ⚙ Settings and search for your city. Forecasts come from [Open-Meteo](https://open-meteo.com) (free, no key). If the forecast can't be fetched, planning carries on without it.

## Your data

- **Backups:** Insights → Backup downloads one JSON file. Restoring replaces your current data and gives every record a fresh ID.
- **Schema changes:** on startup the backend creates missing tables and adds missing columns, so an existing local database keeps working after updates. Add Alembic before making changes that rename or remove columns.

## Deploying

Step-by-step instructions for Vercel + Render + Supabase (all free tiers) are in **[DEPLOY.md](DEPLOY.md)**. In production:

- Anyone can sign up (Supabase Auth, email confirmation).
- Fair-use limits apply per account: AI requests per day, API requests per minute, and garments stored.
- People can export or delete their account (Insights → Account).
- A public [privacy page](frontend/src/pages/Privacy.tsx) explains what is shared with Groq and Open-Meteo.

## Layout

```
backend/
  app/lifecycle.py   garment states, wearing, washing, ironing, baskets
  app/planner.py     day-by-day availability simulation and planning
  app/outfits.py     outfit scoring
  app/insights.py    analytics, packing, before-you-buy, reminders
  app/backup.py      export / restore
  app/ai.py          Groq integration (all output sanitised)
  app/weather.py     Open-Meteo integration
  app/routers/       HTTP endpoints
  tests/             pytest suite
frontend/src/
  pages/             one file per screen
  components/        shared UI
  lib/               API client, types, formatting
supabase/            one-time SQL for the cloud setup
render.yaml          backend deployment blueprint
```
