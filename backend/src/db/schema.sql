-- RoadPulse Namibia — database schema
-- See docs/ARCHITECTURE.md for the reasoning behind this shape.
--
-- Targets Postgres + PostGIS on Supabase. Supabase already provides the
-- `auth.users` table and the `anon` / `authenticated` roles referenced
-- below — this file assumes it's being applied against a Supabase
-- project (via the SQL editor or `npm run db:migrate` against the
-- Supabase connection string), not a bare Postgres instance.

-- Install into Supabase's `extensions` schema, not `public`. In `public`,
-- PostGIS's `spatial_ref_sys` table lands in the API-exposed schema with
-- RLS off and Supabase's default anon/authenticated grants — i.e. the
-- public API key could write to it. (Found when this was first run
-- against a real project.)
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;

-- ---------------------------------------------------------------------
-- regional_stats — official MVA Fund aggregate data, publicly readable.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS regional_stats (
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

-- ---------------------------------------------------------------------
-- incidents — point-level reports (historical-extracted, crowdsourced,
-- official). Enum-like columns get a CHECK constraint since there's no
-- app-layer zod validation in front of every write any more — direct
-- inserts from the frontend (via the Supabase client, under RLS) rely
-- on the database to reject garbage values.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS incidents (
  id                      SERIAL PRIMARY KEY,
  occurred_at             TIMESTAMPTZ,
  occurred_at_precision   TEXT CHECK (occurred_at_precision IN ('exact', 'date_only', 'relative', 'unknown')),
  road                    TEXT,
  location_description    TEXT,
  lat                     NUMERIC,
  lng                     NUMERIC,
  location                GEOGRAPHY(POINT, 4326),
  region                  TEXT,
  accident_type           TEXT CHECK (accident_type IN ('collision', 'rollover', 'pedestrian', 'hit_and_run', 'other')),
  vehicles_involved       TEXT[],
  fatalities              INTEGER,
  injuries_count          INTEGER,
  injuries_description    TEXT,
  source_name             TEXT,
  source_url              TEXT,
  entry_type              TEXT NOT NULL CHECK (entry_type IN ('historical_extracted', 'crowdsourced', 'official')),
  verified                BOOLEAN NOT NULL DEFAULT false,
  needs_review            BOOLEAN NOT NULL DEFAULT true,
  confidence_notes        TEXT[],
  geocode_method          TEXT CHECK (geocode_method IN ('address', 'linear_reference', 'manual_pin')),
  is_synthetic            BOOLEAN NOT NULL DEFAULT false,
  created_at              TIMESTAMPTZ DEFAULT now(),
  updated_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS incidents_location_idx ON incidents USING GIST (location);
CREATE INDEX IF NOT EXISTS incidents_verified_idx ON incidents (verified) WHERE verified = true;

-- Keep `location` in sync with lat/lng whenever a row is inserted or updated.
CREATE OR REPLACE FUNCTION incidents_set_location() RETURNS trigger AS $$
BEGIN
  IF NEW.lat IS NOT NULL AND NEW.lng IS NOT NULL THEN
    NEW.location := ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326)::geography;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, extensions;  -- ST_* live in `extensions`; don't depend on the inserting role's search_path

DROP TRIGGER IF EXISTS incidents_set_location_trigger ON incidents;
CREATE TRIGGER incidents_set_location_trigger
  BEFORE INSERT OR UPDATE ON incidents
  FOR EACH ROW EXECUTE FUNCTION incidents_set_location();

-- ---------------------------------------------------------------------
-- profiles — one row per Supabase auth user, carrying the moderator
-- flag. There's no self-serve signup flow for moderators: a new user
-- lands as role='user' and someone with DB access promotes them by
-- hand (`update profiles set role = 'moderator' where id = '...'`).
-- That's deliberately manual for v1 — the moderator team is small.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'moderator')),
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Auto-create a profile row whenever someone signs up via Supabase Auth.
CREATE OR REPLACE FUNCTION handle_new_user() RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- SECURITY DEFINER so this can read `profiles` from inside another
-- table's RLS policy without tripping that policy's own RLS on
-- `profiles` (which only lets a user read their own row).
CREATE OR REPLACE FUNCTION is_moderator() RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'moderator'
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

-- ---------------------------------------------------------------------
-- Row Level Security
--
-- This is the enforcement layer that used to live in Express route
-- handlers. The rule from docs/ARCHITECTURE.md — "never serve an
-- unverified incident on the public map, never let an unverified write
-- in as anything but unverified" — is now a database guarantee that
-- holds regardless of which client (frontend, future mobile app, a
-- stray curl) is doing the asking.
-- ---------------------------------------------------------------------

ALTER TABLE regional_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

-- regional_stats: fully public read. No public write policy — only the
-- service role (seed script, pipeline) can write, and the service role
-- bypasses RLS entirely.
DROP POLICY IF EXISTS "regional_stats readable by anyone" ON regional_stats;
CREATE POLICY "regional_stats readable by anyone"
  ON regional_stats FOR SELECT
  TO anon, authenticated
  USING (true);

-- incidents: public read of verified rows only.
DROP POLICY IF EXISTS "incidents: public reads verified only" ON incidents;
CREATE POLICY "incidents: public reads verified only"
  ON incidents FOR SELECT
  TO anon, authenticated
  USING (verified = true);

-- incidents: moderators read everything, including the review queue.
DROP POLICY IF EXISTS "incidents: moderators read all" ON incidents;
CREATE POLICY "incidents: moderators read all"
  ON incidents FOR SELECT
  TO authenticated
  USING (is_moderator());

-- incidents: anyone (anon included) can submit a crowdsourced report,
-- but only as an unverified, flagged-for-review row. historical_extracted
-- and official rows can only be written by the service role (pipeline /
-- seed script), which bypasses RLS — there's no public-insert policy
-- that would allow those entry_types.
DROP POLICY IF EXISTS "incidents: public can submit crowdsourced reports" ON incidents;
CREATE POLICY "incidents: public can submit crowdsourced reports"
  ON incidents FOR INSERT
  TO anon, authenticated
  WITH CHECK (
    entry_type = 'crowdsourced'
    AND verified = false
    AND needs_review = true
  );

-- incidents: only moderators can change verified/needs_review.
DROP POLICY IF EXISTS "incidents: moderators can update verification" ON incidents;
CREATE POLICY "incidents: moderators can update verification"
  ON incidents FOR UPDATE
  TO authenticated
  USING (is_moderator())
  WITH CHECK (is_moderator());

-- profiles: a user can read (and only read) their own row — enough for
-- the frontend to check "am I a moderator?" and show/hide the review
-- UI. Nobody can self-promote: there's no public UPDATE policy, so
-- role changes only happen via direct DB access (see comment above).
DROP POLICY IF EXISTS "profiles: read own row" ON profiles;
CREATE POLICY "profiles: read own row"
  ON profiles FOR SELECT
  TO authenticated
  USING (id = auth.uid());
