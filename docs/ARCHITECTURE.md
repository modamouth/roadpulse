# Architecture

## Overview

Database host is **Supabase** (hosted Postgres + PostGIS + Auth), used for
more than hosting: reads and most writes go straight from the frontend to
Supabase via `supabase-js`, with Row Level Security doing the enforcement
that used to live in Express route handlers. See `docs/DECISIONS.md` for the
reasoning (Postgres/PostGIS vs. MongoDB, and why "full Supabase" over
"Supabase as a dumb Postgres host").

```
┌───────────────────────────┐        ┌─────────────────────────────┐
│  frontend/ (Vite + TS)      │──────▶│  Supabase                     │
│  Leaflet map, moderation UI  │ RLS- │  Postgres + PostGIS            │
│  supabase-js (anon key,      │◀──── │  Auth (moderator accounts)      │
│  user's own session)          │enforced│  regional_stats, incidents, │
└───────────────────────────┘        │  profiles — RLS policies in   │
                                       │  backend/src/db/schema.sql     │
                                       └──────────────▲─────────────────┘
                                                        │ service-role
                                                        │ connection
                                                        │ (bypasses RLS)
                                        ┌───────────────┴──────────────┐
                                        │  backend/ — pipeline-only now │
                                        │  Express (TS): migrate/seed +  │
                                        │  POST /api/pipeline/ingest      │
                                        └───────────────▲──────────────────┘
                                                          │
                                           ┌──────────────┴─────────────┐
                                           │  pipelines/                  │
                                           │  - extraction (news → LLM)    │
                                           │  - geocoding (OSM linear       │
                                           │    referencing)                 │
                                           │  - n8n (orchestration)           │
                                           └───────────────────────────────────┘
```

The `backend/` Express app shrank on purpose: it no longer serves
`GET /api/regions`, `GET /api/incidents`, the review queue, or the
verify/crowdsourced-submit endpoints — those are now direct Supabase
queries from the frontend, protected by RLS instead of route-handler
logic. What's left is the one write path RLS deliberately doesn't allow
from a public client: ingesting `historical_extracted`/`official` rows
from the extraction pipeline, which needs service-role credentials that
must never reach the browser.

## Database schema

Two core tables. PostGIS is used for the `location` geometry column so
spatial queries (nearest-road, within-bounding-box) are available later;
plain `lat`/`lng` columns are kept too for simplicity in the API layer.

### `regional_stats`

Official MVA Fund regional aggregate data. No coordinates — this is a
choropleth/heatmap layer, keyed by region name + year.

```sql
CREATE TABLE regional_stats (
  id                      SERIAL PRIMARY KEY,
  region                  TEXT NOT NULL,
  year                    INTEGER NOT NULL,
  crashes                 INTEGER,
  fatalities              INTEGER,
  injuries                INTEGER,
  population              INTEGER,
  casualties_per_100000   NUMERIC,
  pedestrian_pct          INTEGER,
  rollover_pct            INTEGER,
  centroid_lat            NUMERIC NOT NULL,
  centroid_lng            NUMERIC NOT NULL,
  source                  TEXT DEFAULT 'MVA Fund Road Crash & Claims Report',
  created_at              TIMESTAMPTZ DEFAULT now(),
  UNIQUE (region, year)
);
```

`centroid_lat`/`centroid_lng` are approximate region-capital coordinates
used for marker placement (see `data/mva-fund-2024/README.md` — this is a
placeholder until real region boundary polygons are sourced; a proper
choropleth needs GeoJSON polygons, which weren't available via the usual
GitHub-hosted sources when this was last checked — try geoBoundaries.org
directly, or Namibia's own NSA/surveying authority, rather than assuming a
GitHub mirror exists).

### `incidents`

Point-level reports — historical (news-extracted) and, eventually, live
(crowdsourced). This is the table the extraction pipeline writes to.

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE incidents (
  id                    SERIAL PRIMARY KEY,
  occurred_at            TIMESTAMPTZ,             -- nullable: source may only give a relative date
  occurred_at_precision   TEXT,                      -- 'exact' | 'date_only' | 'relative' | 'unknown'
  road                    TEXT,
  location_description    TEXT,                       -- raw text, e.g. "approx. 120km from Otjiwarongo"
  lat                      NUMERIC,
  lng                      NUMERIC,
  location                 GEOGRAPHY(POINT, 4326),      -- derived from lat/lng, for spatial queries
  region                   TEXT,                         -- derived or manually tagged
  accident_type            TEXT,                          -- collision | rollover | pedestrian | hit_and_run | other
  vehicles_involved        TEXT[],
  fatalities                INTEGER,
  injuries_count            INTEGER,
  injuries_description       TEXT,                           -- raw text when count isn't given
  source_name                TEXT,
  source_url                  TEXT,
  entry_type                   TEXT NOT NULL,                   -- 'historical_extracted' | 'crowdsourced' | 'official'
  verified                      BOOLEAN DEFAULT false,
  needs_review                   BOOLEAN DEFAULT true,
  confidence_notes                TEXT[],                          -- extraction pipeline's own flags
  geocode_method                   TEXT,                             -- 'address' | 'linear_reference' | 'manual_pin' | null
  is_synthetic                      BOOLEAN DEFAULT false,            -- true only for dev/test seed data
  created_at                         TIMESTAMPTZ DEFAULT now(),
  updated_at                          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX incidents_location_idx ON incidents USING GIST (location);
CREATE INDEX incidents_verified_idx ON incidents (verified) WHERE verified = true;
```

**Never serve an unverified incident on the public map by default** — this
used to be an Express route's `WHERE verified = true` clause; it's now a
Row Level Security policy on the `incidents` table itself (see "Auth & RLS"
below), so it holds no matter which client is asking.

## Auth & RLS

Supabase Auth provides accounts; there's no custom auth code. A `profiles`
table (one row per `auth.users` row, auto-created by a trigger) carries a
`role` column (`'user' | 'moderator'`). Promoting someone to moderator is a
manual `UPDATE profiles SET role = 'moderator' WHERE id = '...'` — no
self-serve signup flow for that, the moderator team is small enough that
this is fine for v1.

RLS policies (full SQL in `backend/src/db/schema.sql`):

| Table | Policy | Effect |
|---|---|---|
| `regional_stats` | public SELECT | Anyone reads the aggregate layer; no public write policy — only the service role (seed script) writes |
| `incidents` | public SELECT, `verified = true` | Anonymous/authenticated clients only ever see verified rows |
| `incidents` | moderator SELECT, `is_moderator()` | Signed-in moderators also see the unverified review queue |
| `incidents` | public INSERT, `WITH CHECK (entry_type = 'crowdsourced' AND verified = false AND needs_review = true)` | Crowdsourced submissions are always forced unverified; `historical_extracted`/`official` can't be inserted this way at all |
| `incidents` | moderator UPDATE, `is_moderator()` | Only moderators can flip `verified`/`needs_review` |
| `profiles` | self SELECT, `id = auth.uid()` | A user can check their own role (to show/hide the moderation UI); can't read or change anyone else's |

`is_moderator()` is a `SECURITY DEFINER` SQL function so it can check
`profiles` from inside another table's policy without being blocked by
`profiles`' own RLS.

## Frontend ↔ database surface (via `supabase-js`, RLS-enforced)

| Call (in `frontend/src/api/client.ts`) | Backs onto |
|---|---|
| `fetchRegions(year)` | `SELECT` on `regional_stats` |
| `fetchIncidents()` | `SELECT` on `incidents` (RLS limits this to verified rows regardless of the query) |
| `submitIncident(report)` | `INSERT` on `incidents`, forced to `entry_type: 'crowdsourced', verified: false, needs_review: true` |
| `fetchModerationList(status, entryType?)` / `fetchModerationCounts(entryType?)` | `SELECT` on `incidents` by moderation state (pending / approved / rejected) — pending and rejected rows only come back for a moderator |
| `setIncidentLocation(id, lat, lng, note)` | `set_incident_location()` RPC — moderator-only map pin for pending or approved rows; sets `geocode_method = 'manual_pin'` and appends the required note (+ who, + any replaced coordinate) to `confidence_notes` |
| `reopenIncident(id, note)` | `reopen_incident()` RPC — moderator-only; sends an approved/rejected row back to pending (an approved one leaves the public map at once). Reason required; the previous decision is appended to `confidence_notes` before the review columns are cleared |
| `fetchReviewerEmails(ids)` | `reviewer_emails()` RPC — moderator-only; resolves `reviewed_by` ids that actually reviewed something |
| `reviewIncident(id, approve, note?)` | `review_incident()` RPC — moderator-only; sets `verified`, clears `needs_review`, records `reviewed_by`/`reviewed_at`/`review_note`. There is no `UPDATE` policy on `incidents`, so this is the only client write path after insert. |

Moderation states: pending (`needs_review = true`), approved
(`verified = true`), rejected (`verified = false, needs_review = false` —
kept for the record, never shown publicly).

The moderator review UI is `frontend/admin.html` (`src/admin.ts`):
magic-link sign-in for invited accounts only (`src/api/auth.ts`), the
pending queue with location derivation and extraction flags, and
approve/reject. `submitIncident` exists in the client but no public
submission form calls it yet.

## Remaining server endpoint

| Endpoint | Purpose |
|---|---|
| `POST /api/pipeline/ingest` | Extraction-pipeline write path for `historical_extracted`/`official` incidents — needs service-role credentials, not reachable with the Supabase anon key. See `backend/src/routes/pipeline.ts`. |

## Frontend

Vite + TypeScript, Leaflet for the map. Port the structure from
`docs/prototype-dashboard.html`:

- Dark map-console theme (CSS custom properties, already defined in the
  prototype's `:root`)
- Region layer: `L.circleMarker` sized/colored by a sequential severity
  scale (see prototype's `severityColor()` — one red hue, light → dark,
  per the dataviz approach used when the prototype was built)
- Incident layer: `L.circleMarker`, single accent color (identity, not
  magnitude — these are individual events, not a scale)
- Sidebar: year/metric controls, KPI tiles, legend, source attribution

Fetch from the backend API instead of inlined JS objects; otherwise the
prototype's rendering logic is a reasonable starting point.

## Known simplifications to revisit

- `regional_stats.centroid_lat/lng` are approximate town coordinates, not
  real region centroids or boundaries. A real choropleth needs region
  boundary GeoJSON — not yet sourced.
- Geocoding for "distance from town" references uses straight-line
  interpolation in the prototype; needs real road-geometry linear
  referencing (see `pipelines/geocoding/README.md`).
- Moderator promotion (`profiles.role = 'moderator'`) is a manual DB edit,
  not a UI flow — fine while the moderator team is small, revisit if it
  grows.
- Crowdsourced submission has a client function (`submitIncident`) but no
  public form calling it yet.
- Moderators can approve/reject but not correct an incident's fields (e.g.
  fix a coordinate) — add a column-scoped function for that if needed, not
  a blanket `UPDATE` policy.
