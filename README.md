# RoadPulse Namibia

A road accident reporting and mapping platform for Namibia. It combines official
regional crash statistics (MVA Fund) with individually sourced incident reports —
news-extracted historically, crowdsourced going forward — on a single OpenStreetMap
/ Leaflet map.

**Status:** early prototype. A working single-file HTML dashboard exists
(`docs/prototype-dashboard.html`) proving the map/data concept. This repo is the
scaffold to turn that into a real app with a backend, a database, and the
ingestion pipeline that was only sketched out in conversation.

## Why this exists

Namibia has no public, map-based view of where road accidents happen. The MVA
Fund publishes a strong annual report, but it's regional aggregate data (14
regions), not point-level — you can't see which stretch of a specific road is
dangerous. This project aims to add that layer: a live-updating map of actual
incidents, backed by the official regional data as context.

## Decisions already made (read before changing direction)

See `docs/DECISIONS.md` for the full reasoning. Short version:

- **Not using Ushahidi.** Considered and rejected — see DECISIONS.md. Custom
  build instead, because mixing historical (news-extracted) data with live
  crowdsourced reports in one schema is simpler when we control the schema.
- **Map stack: Leaflet.js + OpenStreetMap tiles + Nominatim geocoding.** Free,
  no API keys, good Namibia coverage. Not Google Maps, not Ushahidi's own map.
- **Two data layers, one schema:** `regional_stats` (official MVA Fund
  aggregates, no coordinates, used for a choropleth/heatmap layer) and
  `incidents` (point-level, lat/lng, from news extraction now and
  crowdsourced submission later).
- **Postgres + PostGIS via Supabase, not MongoDB, and not a bare
  self-hosted Postgres.** PostGIS backs the spatial work (viewport
  queries, road-geometry geocoding); Supabase's Row Level Security
  enforces "public only sees verified incidents" at the database layer
  and Supabase Auth backs moderator accounts, so most reads/writes go
  straight from the frontend to Supabase. See `docs/DECISIONS.md`.
- **Geocoding "distance along a road" references** (e.g. "120km from
  Otjiwarongo") needs linear referencing against real road geometry (OSM way
  data via Overpass), not simple point interpolation — see
  `pipelines/geocoding/README.md`. The prototype uses straight-line
  interpolation between two towns as an approximation; that's a known
  simplification to fix.
- **Extraction pipeline is LLM-assisted, not fully automatic.** News/social
  posts get run through an extraction prompt (see
  `pipelines/extraction/prompt.md`) that outputs structured JSON plus a
  `confidence_notes` field; anything flagged goes to human review before it's
  marked `verified` in the database.

## Repo layout

```
roadpulse-namibia/
├── frontend/        Leaflet map app (Vite + TS), talks to Supabase directly
├── backend/          Pipeline-only service now (Express + TS) + schema/seed
│                      for the Supabase Postgres + PostGIS database
├── pipelines/
│   ├── extraction/    LLM-assisted news/social → structured incident data
│   ├── geocoding/      Linear-referencing helper for "Xkm from Y" locations
│   └── n8n/             Workflow notes for the automation layer
├── data/
│   └── mva-fund-2024/  Extracted MVA Fund Road Crash & Claims Report 2024
├── docs/
│   ├── ARCHITECTURE.md      Schema, data flow, open questions
│   ├── DECISIONS.md         Why Ushahidi was rejected, why this stack
│   └── prototype-dashboard.html   The working single-file proof of concept
└── CLAUDE.md          Instructions for Claude Code picking this up
```

## Getting started

```bash
npm install

# Create a Supabase project (supabase.com) — PostGIS is available as a
# toggleable extension, enabled automatically by schema.sql, so there's
# no extra setup step beyond creating the project — then:
cp .env.example .env
# fill in DATABASE_URL (Project Settings → Database → Connection string)
# and SUPABASE_SERVICE_ROLE_KEY

cp .env.example frontend/.env
# fill in VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (Project Settings → API)

npm run db:migrate   # applies backend/src/db/schema.sql — tables + RLS policies
npm run db:seed      # loads data/mva-fund-2024/ and data/sample-incidents.json

npm run dev:frontend   # map app on :5173 — reads/writes Supabase directly
npm run dev:backend    # pipeline-ingest service on :4000 — not needed for the map itself
```

See `docs/ARCHITECTURE.md` for the database schema, RLS policies, and auth
model, and `CLAUDE.md` for what's built vs. what's next.

## Data sources

- MVA Fund, *Road Crash and Claims Report 2024* — regional aggregate stats,
  extracted into `data/mva-fund-2024/` (33 CSV tables + combined JSON).
- Individual incidents — currently one worked example (a collision on the
  B1 near Okahandja–Otjiwarongo, sourced from an Informanté Facebook post),
  seeded in `data/sample-incidents.json`. The extraction pipeline that would
  produce more of these at scale is designed (`pipelines/extraction/`) but
  not yet wired up to a live news source.
