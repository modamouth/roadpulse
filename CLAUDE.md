# CLAUDE.md

Instructions for Claude Code (or any agent) picking up development on this
repo. Read this, `README.md`, and `docs/DECISIONS.md` before writing code —
several approaches (Ushahidi, Google Maps, naive geocoding) were already
considered and rejected; don't re-propose them without a new reason.

## What exists right now

- A **working single-file HTML prototype** at `docs/prototype-dashboard.html`
  — Leaflet + OpenStreetMap, dark UI, regional severity markers (sized/colored
  by MVA Fund stats), a toggleable incident-report layer, KPI tiles, a
  time-of-day chart. This proves the concept and is a useful visual/UX
  reference, but it's a static HTML file with data baked into the JS, not a
  real app — don't extend that file further, port its logic into
  `frontend/`.
- **Extracted MVA Fund data** in `data/mva-fund-2024/` — 33 CSV tables + a
  combined JSON, covering crashes/fatalities/injuries by region, month, day,
  time-of-day, crash type, vehicle type, and more. See its `README.md` for
  caveats (regional aggregate only, no point data, one known internal
  inconsistency in the source report).
- **One real incident record**, `data/sample-incidents.json` — a collision
  near Okahandja–Otjiwarongo, extracted from a news Facebook post, geocoded by
  straight-line interpolation (approximation, not exact — see
  `pipelines/geocoding/README.md`).
- **A real `frontend/`+`backend/` implementation, targeting Supabase** —
  schema, RLS policies, and `supabase-js` client calls are written (see
  step 1/2 below), but no Supabase project has actually been provisioned
  yet, so none of this has been run against a live database.

## What's next, roughly in order

1. **Backend: database + API.** — **done, Supabase-backed.** Database is
   Postgres + PostGIS on Supabase (see `docs/DECISIONS.md` for why, over
   both MongoDB and a bare self-hosted Postgres). `backend/src/db/schema.sql`
   has the `regional_stats`/`incidents`/`profiles` tables, RLS policies, and
   the `is_moderator()` helper; `migrate.ts`/`seed.ts` apply it and load
   `data/mva-fund-2024/` + `data/sample-incidents.json` against
   `DATABASE_URL` (Supabase's direct Postgres connection string — bypasses
   RLS as the `postgres` role). Reads and most writes now happen directly
   from the frontend via `supabase-js`, under RLS — there is no
   `GET /api/regions`/`GET /api/incidents` Express route any more. The one
   thing still behind Express is `POST /api/pipeline/ingest`
   (`backend/src/routes/pipeline.ts`), for the extraction pipeline's writes,
   which need service-role credentials RLS deliberately keeps off public
   clients. Still needs doing: a real Supabase project created and its
   keys filled into `.env` (nothing has been provisioned yet, this is
   schema + client code only), and running `npm run db:migrate` /
   `npm run db:seed` against it.

2. **Frontend: port the prototype into the real app.** — **mostly done.**
   `frontend/src/main.ts`, `style.css`, `map/severity.ts` port the
   prototype's Leaflet setup, color scale, and dark map-console UI.
   `frontend/src/api/client.ts` fetches `regional_stats`/`incidents` from
   Supabase via `frontend/src/api/supabase.ts` (needs `VITE_SUPABASE_URL`/
   `VITE_SUPABASE_ANON_KEY` in `frontend/.env`). `submitIncident`,
   `fetchReviewQueue`, `setIncidentVerified` exist in `client.ts` but
   nothing in the UI calls them yet — see steps 4/5 below.

3. **Geocoding helper.** Implement real linear referencing (point N km along
   an actual road, using OSM way geometry from Overpass API) to replace the
   straight-line-between-two-towns approximation in the prototype. See
   `pipelines/geocoding/README.md` for the approach and why the simple
   version isn't good enough at scale.

4. **Extraction pipeline.** The prompt in `pipelines/extraction/prompt.md`
   works (tested against a real example in conversation). Wire it into an
   actual pipeline: a source (news site scraping, or Facebook Graph API for
   pages like Informanté/NBC Digital News — note Meta restricts this, check
   current API access before committing to it), the extraction call, the
   geocoding step, and a review queue before anything is marked `verified`.
   n8n is the intended orchestration tool (user already runs n8n for other
   projects) — see `pipelines/n8n/README.md`.

5. **Moderation / review UI.** Nothing in `incidents` should go live on the
   public map without either (a) coming from the official MVA Fund aggregate
   data, or (b) being marked `verified` by a human reviewer. This is now
   enforced at the database level (RLS policies in `schema.sql` — a
   non-moderator's `fetchReviewQueue()`/`setIncidentVerified()` call simply
   returns nothing / fails), so the UI itself can be minimal: it needs
   Supabase Auth sign-in, then a view that calls `fetchReviewQueue()` and
   `setIncidentVerified()` (both already in `frontend/src/api/client.ts`).
   Promoting a user to moderator is still a manual
   `UPDATE profiles SET role = 'moderator'` — no self-serve flow, see
   `docs/ARCHITECTURE.md`.

## Conventions

- TypeScript throughout, strict mode on.
- Keep `regional_stats` (aggregate) and `incidents` (point-level) clearly
  separate in both the schema and the UI — don't let a user assume a regional
  marker is a specific crash location. The prototype's popups make this
  explicit; keep doing that.
- Any location derived from a vague reference ("Xkm from Y", "near the Z
  turnoff") must carry a `needs_review: true` flag and a human-readable note
  on how the coordinate was derived. Never silently present an interpolated
  or estimated point as precise.
- Don't fabricate incident records. If sample/seed data is needed for
  development, generate clearly-labeled synthetic data (`is_synthetic: true`
  or similar) — never invent realistic-looking fake news sources or crash
  details and present them as real.

## Open questions for the user (don't guess on these)

- ~~Which Postgres hosting~~ — **settled: Supabase.** See
  `docs/DECISIONS.md`. Still needs a real Supabase project provisioned —
  nothing has been created yet, only schema/client code written against
  the assumption.
- Facebook/news scraping legality and access — Meta's Graph API has real
  restrictions on page scraping; confirm the intended approach before
  building it.
- Whether crowdsourced public submission is in scope yet, or whether v1 is
  read-only (regional stats + extracted historical incidents) with
  submission added later.
