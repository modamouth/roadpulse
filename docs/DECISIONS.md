# Decisions

A record of choices already made, so they aren't silently re-litigated.
Dates are approximate to the conversation they came from.

## Ushahidi vs. custom build

**Considered:** Ushahidi — open-source crowdsourcing/mapping platform,
widely used for crisis reporting. Has bulk CSV import, moderation workflow,
SMS/WhatsApp intake channels out of the box.

**Rejected in favor of a custom build.** Reasoning:

- The core requirement — mixing historical (news-extracted) data with live
  crowdsourced reports in one queryable schema, with a separate regional
  aggregate layer on top — is easy when you control the schema and fiddly
  to bend Ushahidi's survey/import structure around.
- Ushahidi's strength is reports feeding a map; this project needs more
  structured analytics (regional comparisons, time-of-day patterns,
  crash-type breakdowns) that fit a normal relational schema better than
  Ushahidi's form-centric model.
- Ushahidi would still need OpenStreetMap underneath for the actual map
  rendering — so using Ushahidi doesn't avoid needing OSM/Leaflet expertise,
  it adds a layer on top of it.

Ushahidi could still be reconsidered if: SMS-shortcode intake becomes a hard
requirement (needs telco partnership either way), or if the moderation UI
build-out becomes a bigger lift than expected and Ushahidi's out-of-the-box
version would save real time.

## Map stack: Leaflet + OpenStreetMap, not Google Maps

OSM has solid Namibia road coverage. Leaflet + OSM tiles are free with no
API key; Nominatim handles geocoding (place name → coordinates) for free at
low volume. Google Maps would work too but adds billing/API-key management
for no clear benefit at this stage.

## Two-layer data model: regional aggregate vs. point incidents

The MVA Fund's own report (`data/mva-fund-2024/`) is regional/aggregate —
14 regions, no coordinates. It's authoritative but can't show "which stretch
of this road is dangerous." Point-level incident data (from news extraction,
eventually crowdsourcing) is the opposite: potentially precise locations but
unofficial and needs verification.

Decision: keep these as two distinct tables/layers rather than trying to
force them into one. The regional layer is always trustworthy but coarse;
the incident layer is granular but needs a trust/verification flag on every
record. See `ARCHITECTURE.md` for the schema.

## Geocoding "distance along a road" references

Real example worked through: a news post said a crash happened
"approximately 120 kilometres from Otjiwarongo" on the Okahandja–Otjiwarongo
road, with no other towns on that stretch (confirmed by the user, who has
driven the road). This is common phrasing in Namibian news/crash reports —
distance from a town along a known road, not a street address.

**Naive approach (used in the prototype):** straight-line interpolation
between the two towns' coordinates. Works as an approximation when the road
is fairly direct, but introduces error (the real B1 distance between these
two towns is ~190km by road vs. ~170km straight-line) — a few km of error
on this stretch, potentially much more on winding roads.

**Correct approach (not yet built):** pull the actual road geometry from
OpenStreetMap (Overpass API query for the relevant `way`), then do proper
linear referencing — walk the real line distance along the road's actual
path. This removes the straight-line error and generalizes to any road.
Ambiguous cases (multiple towns on a route, the road forking, "from X"
without a clear single route) still need a human to confirm which path
before the calculation runs — flag with `needs_review`, don't guess.

See `pipelines/geocoding/README.md`.

## Extraction pipeline approach

Tested against a real example (an Informanté Facebook post about a fatal
Okahandja–Otjiwarongo crash). An LLM extraction prompt
(`pipelines/extraction/prompt.md`) reliably pulls structured fields (date,
road, vehicles, fatalities, injuries) from free-text news/social posts, and
flags ambiguous fields (vague injury counts, relative dates, distance-only
locations) via a `confidence_notes` array rather than guessing.

Decision: every extracted record gets `needs_review: true` by default.
Nothing from this pipeline is marked `verified` without a human check — the
extraction is a speed-up for data entry, not a replacement for verification.

Open question, not yet decided: which sources to pull from at scale. News
sites are more straightforward to scrape/fetch than Facebook, which has real
API restrictions on page content access. This needs resolving before the
pipeline is built out past the single worked example.

## Database: Postgres/PostGIS (via Supabase), not MongoDB

**Considered:** MongoDB, prompted by asking whether the backend should use
it instead of Postgres.

**Rejected in favor of Postgres + PostGIS.** Reasoning:

- The schema is genuinely relational: two fixed-column tables
  (`regional_stats`, `incidents`) with a `UNIQUE (region, year)`
  constraint and enum-like fields that benefit from real `CHECK`
  constraints — nothing here is deeply nested or variably shaped enough
  to need document flexibility.
- PostGIS is purpose-built for the geospatial work already planned
  (bounding-box queries for the map viewport, nearest-road lookups, and
  the linear-referencing geocoding work in `pipelines/geocoding/`).
  MongoDB's `2dsphere` indexes can do point/polygon queries, but it's a
  lighter feature on a document database, not a dedicated GIS engine.
- Aggregation for the KPI tiles (national totals, year-over-year
  comparisons) is simpler in SQL than in Mongo's aggregation pipeline for
  this shape of data.

MongoDB isn't disqualified by anything project-specific — it would work —
it just doesn't buy anything here and gives up PostGIS and SQL
aggregation for no offsetting benefit.

## Supabase, and going "full Supabase" rather than using it as a bare Postgres host

Once Postgres was settled, the next question was where to run it.
**Decision: Supabase**, used deeply — RLS, Auth, and direct `supabase-js`
reads from the frontend — not just as a managed Postgres instance behind
the original Express API.

Reasoning:

- Supabase *is* Postgres with PostGIS available as an extension, so the
  schema in `docs/ARCHITECTURE.md` needed no changes to target it.
- **Row Level Security replaces hand-rolled auth middleware** for the
  rule that mattered most in this schema: unverified incidents must never
  reach the public map. That rule now lives as a policy on the
  `incidents` table (`backend/src/db/schema.sql`), enforced for every
  client — the original Express routes, a future mobile app, or a stray
  `curl` — rather than re-implemented per endpoint.
- **Supabase Auth** answers the "moderation endpoints have no auth yet"
  gap flagged in the original scaffold (`docs/ARCHITECTURE.md`'s "known
  simplifications"), with no custom auth code to write or maintain.
- **Direct `supabase-js` reads from the frontend** (`fetchRegions`,
  `fetchIncidents`) replace the equivalent Express GET routes entirely —
  less backend code to maintain, and the RLS policy is the only place
  the "verified only" rule is expressed, instead of being duplicated in
  a route handler that could drift from it.
- The custom Express layer wasn't dropped entirely: `backend/` remains
  for the one thing RLS deliberately doesn't allow a public client to
  do — write `historical_extracted`/`official` incident rows from the
  extraction pipeline, which needs service-role credentials kept off the
  frontend. See `docs/ARCHITECTURE.md`'s "Auth & RLS" section for the
  full policy table.
- Fits how the user already works — already comfortable with hosted
  services for other projects (n8n Cloud, Odoo Online) rather than
  self-hosting infrastructure, so Supabase continues that pattern.

Revisit if: the moderator team outgrows manual `profiles.role` promotion
(would want a real admin flow at that point), or if a need emerges for
write logic complex enough that RLS policies become unwieldy to express
(at which point more of that logic would move back behind a server
endpoint, the same way pipeline ingestion already is).
