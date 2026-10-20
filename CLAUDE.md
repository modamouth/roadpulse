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
- **A real `frontend/`+`backend/` implementation on a live Supabase
  project** — schema, RLS policies, and `supabase-js` client calls (see
  step 1/2 below), provisioned, migrated, seeded, and verified end to end
  (map loads live data; RLS checked with the public key). The project is in
  **eu-west-1 (Ireland)** — deliberately kept there rather than Frankfurt,
  don't propose moving it. Its URL/keys live only in the gitignored `.env`
  files.

## What's next, roughly in order

1. **Backend: database + API.** — **done, Supabase-backed.** Database is
   Postgres + PostGIS on Supabase (see `docs/DECISIONS.md` for why, over
   both MongoDB and a bare self-hosted Postgres). `backend/src/db/schema.sql`
   has the `regional_stats`/`incidents`/`profiles` tables, RLS policies, and
   the `is_moderator()` helper; `migrate.ts`/`seed.ts` apply it and load
   `frontend/src/data/regions.json` (the compact per-region extract of
   `data/mva-fund-2024/`) + `data/sample-incidents.json` against
   `DATABASE_URL` (Supabase's session pooler string — bypasses RLS as the
   `postgres` role). Reads and most writes now happen directly
   from the frontend via `supabase-js`, under RLS — there is no
   `GET /api/regions`/`GET /api/incidents` Express route any more. The one
   thing still behind Express is `POST /api/pipeline/ingest`
   (`backend/src/routes/pipeline.ts`), for the extraction pipeline's writes,
   which need service-role credentials RLS deliberately keeps off public
   clients.

   Things learned bringing it up against the real project — don't undo:
   - **Connect via the session pooler** (port 5432), not the direct
     `db.<ref>.supabase.co` host (IPv6-only, unreachable on IPv4 networks)
     and not the transaction pooler (port 6543; no DDL). See `.env.example`.
   - **Env files:** server-side vars in the repo-root `.env`, loaded by
     `backend/src/env.ts` (npm workspace scripts run with cwd=`backend/`, so
     plain `dotenv/config` missed it); `VITE_*` vars in `frontend/.env`.
   - **PostGIS goes in the `extensions` schema.** In `public`, its
     `spatial_ref_sys` table was writable with the public API key.
   - **Public inserts can't read their row back** (`.insert().select()`
     fails under RLS — anon can't SELECT unverified rows), so
     `submitIncident()` returns nothing.
   - `npm run db:seed` isn't idempotent for incidents — re-running it
     duplicates the sample incident. Rebuild from a clean schema instead.
   - **Node 22+** (`.nvmrc`): supabase-js won't construct a client on
     Node 20 (no native WebSocket), which matters once backend/pipeline
     code uses it.

2. **Frontend: port the prototype into the real app.** — **mostly done.**
   `frontend/src/main.ts`, `style.css`, `map/severity.ts` port the
   prototype's Leaflet setup, color scale, and dark map-console UI. The
   basemap is standard OSM tiles darkened with a CSS filter — the
   prototype's CARTO `dark_all` tiles now need an API key. Check OSM's tile
   usage policy before a public launch.
   `frontend/src/api/client.ts` fetches `regional_stats`/`incidents` from
   Supabase via `frontend/src/api/supabase.ts` (needs `VITE_SUPABASE_URL`/
   `VITE_SUPABASE_ANON_KEY` in `frontend/.env`). Popups escape every
   database field (`src/lib/html.ts`) — approved crowdsourced reports are
   user-written, so never interpolate raw incident text into HTML.
   `submitIncident` exists in `client.ts` but no public submission form
   calls it yet — that's the next frontend piece now that public
   submission is in scope for v1.

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

   **Manual sources already work:** `npm run db:import -- <file.json>
   [--dry-run]` loads a JSON array of incidents (same shape as
   `data/sample-incidents.json`) into the review queue. It shares
   validation + insert with `POST /api/pipeline/ingest`
   (`backend/src/db/ingest.ts`): explicit `null`s and timezone offsets are
   fine, `is_synthetic` is carried through, a record claiming
   `verified: true` is refused, everything lands pending, the whole file is
   all-or-nothing, and records matching an existing incident (same
   `occurred_at` + `road` + `entry_type`) are skipped. First real batch:
   `data/incidents-q2-2025-media-report.json` (3 incidents from the MVA
   Fund Media Intelligence Report Q2 2025/26).

5. **Moderation / review UI.** Nothing in `incidents` should go live on the
   public map without either (a) coming from the official MVA Fund aggregate
   data, or (b) being marked `verified` by a human reviewer. — **built.**
   `frontend/admin.html` (`src/admin.ts`): password or magic-link sign-in;
   Pending / Approved / Rejected tabs with counts and a source filter;
   cards show location derivation + extraction flags; approve/reject with
   an optional note; a "Set location" map pin (`set_incident_location()`,
   pending or approved rows, note required and appended to
   `confidence_notes`); "Send back to pending" for approved/rejected rows
   (`reopen_incident()`, reason required, previous decision preserved in
   `confidence_notes`). Enforced in the database:
   no `UPDATE` policy on `incidents`; the only write path is the
   moderator-only `review_incident()` function, which also records
   `reviewed_by`/`reviewed_at`/`review_note` and refuses already-reviewed
   rows. Accounts are invite-only (dashboard → Authentication → Invite;
   the form uses `shouldCreateUser: false`), and promotion to moderator is
   still a manual `UPDATE profiles SET role = 'moderator'`.

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

- ~~Which Postgres hosting~~ — **settled: managed Supabase, independent of
  the user's Odoo Online / n8n Cloud setup.** See `docs/DECISIONS.md`.
  Provisioned in eu-west-1 (Ireland) and kept there.
- ~~Facebook/news scraping~~ — **settled: manual entry + scraping Namibian
  news sites.** Not Facebook (Graph API page-content restrictions). Still
  check each site's terms/robots.txt before scraping it.
- ~~Crowdsourced public submission in v1?~~ — **settled: yes.** Public
  reports land via `submitIncident()` as `crowdsourced`, unverified, in the
  moderation queue.
