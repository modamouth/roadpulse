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

-- Moderation audit trail. Added after the initial table, so ALTER ... IF NOT
-- EXISTS keeps this file re-runnable against an existing database. Only
-- review_incident() (below) writes these.
--   verified=false, needs_review=true   → pending, in the review queue
--   verified=true,  needs_review=false  → approved, on the public map
--   verified=false, needs_review=false  → rejected (kept, not shown)
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users (id) ON DELETE SET NULL;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS review_note TEXT;

CREATE INDEX IF NOT EXISTS incidents_review_queue_idx ON incidents (created_at) WHERE needs_review = true;

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
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND review_note IS NULL
  );

-- incidents: no UPDATE policy at all — the only way a public/authenticated
-- client changes an incident is review_incident() below, which can touch
-- nothing but the verification + audit columns. (This replaces an earlier
-- "moderators can update" policy that let a moderator rewrite any column.)
-- If moderators later need to correct fields (e.g. fix a coordinate), add a
-- separate, column-scoped function rather than reopening a blanket policy.
DROP POLICY IF EXISTS "incidents: moderators can update verification" ON incidents;

-- Approve or reject one pending incident. SECURITY DEFINER so it can update
-- despite there being no UPDATE policy; it does its own moderator check.
-- Only acts on rows still pending (needs_review = true), so a second
-- moderator can't silently overwrite an earlier decision.
CREATE OR REPLACE FUNCTION review_incident(p_id INTEGER, p_approve BOOLEAN, p_note TEXT DEFAULT NULL)
RETURNS void AS $$
BEGIN
  IF NOT is_moderator() THEN
    RAISE EXCEPTION 'only moderators can review incidents' USING ERRCODE = '42501';
  END IF;

  UPDATE incidents
     SET verified     = p_approve,
         needs_review = false,
         reviewed_by  = auth.uid(),
         reviewed_at  = now(),
         review_note  = NULLIF(trim(p_note), '')
   WHERE id = p_id
     AND needs_review = true;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'incident % not found or already reviewed', p_id USING ERRCODE = 'P0002';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- Supabase grants EXECUTE on new public functions to anon by default.
-- The moderator check would refuse anon anyway; this keeps it off the
-- anon surface entirely.
REVOKE EXECUTE ON FUNCTION review_incident(INTEGER, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION review_incident(INTEGER, BOOLEAN, TEXT) TO authenticated;

-- Send an approved or rejected incident back to the pending queue, e.g. to
-- re-check it or correct a mistaken decision. An approved row leaves the
-- public map immediately. The reason is required, and the previous decision
-- (who, when, their note) is appended to confidence_notes before the review
-- columns are cleared, so the history isn't lost when it's reviewed again.
CREATE OR REPLACE FUNCTION reopen_incident(p_id INTEGER, p_note TEXT)
RETURNS void AS $$
DECLARE
  prev     RECORD;
  who      TEXT;
  prev_who TEXT;
BEGIN
  IF NOT is_moderator() THEN
    RAISE EXCEPTION 'only moderators can reopen incidents' USING ERRCODE = '42501';
  END IF;
  IF p_note IS NULL OR trim(p_note) = '' THEN
    RAISE EXCEPTION 'a reason for sending this back to pending is required' USING ERRCODE = '22023';
  END IF;

  SELECT verified, reviewed_by, reviewed_at, review_note INTO prev
    FROM incidents WHERE id = p_id AND needs_review = false FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'incident % not found or already pending', p_id USING ERRCODE = 'P0002';
  END IF;

  SELECT email INTO who FROM auth.users WHERE id = auth.uid();
  SELECT email INTO prev_who FROM auth.users WHERE id = prev.reviewed_by;

  UPDATE incidents
     SET verified     = false,
         needs_review = true,
         reviewed_by  = NULL,
         reviewed_at  = NULL,
         review_note  = NULL,
         confidence_notes = coalesce(confidence_notes, '{}') || format(
           'sent back to pending by %s on %s: %s (was %s by %s on %s%s)',
           coalesce(who, 'a moderator'),
           to_char(now() AT TIME ZONE 'Africa/Windhoek', 'YYYY-MM-DD'),
           trim(p_note),
           CASE WHEN prev.verified THEN 'approved' ELSE 'rejected' END,
           coalesce(prev_who, 'unknown'),
           coalesce(to_char(prev.reviewed_at AT TIME ZONE 'Africa/Windhoek', 'YYYY-MM-DD'), 'unknown date'),
           CASE WHEN prev.review_note IS NOT NULL THEN format(', note: "%s"', prev.review_note) ELSE '' END)
   WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION reopen_incident(INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reopen_incident(INTEGER, TEXT) TO authenticated;

-- Place (or move) a pending incident's coordinate by hand — the review UI's
-- "Set location" map pin. Column-scoped on purpose (lat/lng/geocode_method/
-- confidence_notes only), per the note on the missing UPDATE policy above.
--
-- Per CLAUDE.md, an estimated location must say how it was derived: the
-- moderator's note is required, and is appended to confidence_notes along
-- with who pinned it and any coordinate it replaced. Pinning never changes
-- the review status: a pending row stays pending (pinning is not
-- approving). Approved rows can be pinned too — an incident can be verified
-- as real before its exact spot is known — and that pin is public at once.
-- Rejected rows can't be.
CREATE OR REPLACE FUNCTION set_incident_location(p_id INTEGER, p_lat NUMERIC, p_lng NUMERIC, p_note TEXT)
RETURNS void AS $$
DECLARE
  prev RECORD;
  who  TEXT;
BEGIN
  IF NOT is_moderator() THEN
    RAISE EXCEPTION 'only moderators can set incident locations' USING ERRCODE = '42501';
  END IF;
  IF p_note IS NULL OR trim(p_note) = '' THEN
    RAISE EXCEPTION 'a note on how this location was chosen is required' USING ERRCODE = '22023';
  END IF;
  -- Namibia's extent, padded slightly; catches a mis-click into the ocean or
  -- a neighbouring country rather than validating precisely.
  IF p_lat IS NULL OR p_lng IS NULL
     OR p_lat NOT BETWEEN -29.5 AND -16.5
     OR p_lng NOT BETWEEN 11.5 AND 25.5 THEN
    RAISE EXCEPTION 'location (%, %) is outside Namibia', p_lat, p_lng USING ERRCODE = '22023';
  END IF;

  SELECT lat, lng, geocode_method INTO prev
    FROM incidents WHERE id = p_id AND (needs_review = true OR verified = true) FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'incident % not found or rejected', p_id USING ERRCODE = 'P0002';
  END IF;

  SELECT email INTO who FROM auth.users WHERE id = auth.uid();

  UPDATE incidents
     SET lat = round(p_lat, 6),
         lng = round(p_lng, 6),
         geocode_method = 'manual_pin',
         confidence_notes = coalesce(confidence_notes, '{}') || format(
           'location manually pinned by %s on %s: %s%s',
           coalesce(who, 'a moderator'),
           to_char(now() AT TIME ZONE 'Africa/Windhoek', 'YYYY-MM-DD'),
           trim(p_note),
           CASE WHEN prev.lat IS NOT NULL
                THEN format(' (replaced %s, %s from %s)', prev.lat, prev.lng, coalesce(prev.geocode_method, 'unknown method'))
                ELSE '' END)
   WHERE id = p_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION set_incident_location(INTEGER, NUMERIC, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_incident_location(INTEGER, NUMERIC, NUMERIC, TEXT) TO authenticated;

-- Reviewer emails for the review UI's Approved/Rejected tabs. Moderators can
-- only read their own `profiles` row and never `auth.users`, so this resolves
-- reviewed_by ids for them — and only ids that actually reviewed something,
-- so it can't be used to look up arbitrary accounts.
CREATE OR REPLACE FUNCTION reviewer_emails(p_ids UUID[])
RETURNS TABLE (reviewer_id UUID, reviewer_email TEXT) AS $$
BEGIN
  IF NOT is_moderator() THEN
    RAISE EXCEPTION 'only moderators can look up reviewers' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT u.id, u.email::text
      FROM auth.users u
     WHERE u.id = ANY (p_ids)
       AND EXISTS (SELECT 1 FROM incidents i WHERE i.reviewed_by = u.id);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

REVOKE EXECUTE ON FUNCTION reviewer_emails(UUID[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reviewer_emails(UUID[]) TO authenticated;

-- profiles: a user can read (and only read) their own row — enough for
-- the frontend to check "am I a moderator?" and show/hide the review
-- UI. Nobody can self-promote: there's no public UPDATE policy, so
-- role changes only happen via direct DB access (see comment above).
DROP POLICY IF EXISTS "profiles: read own row" ON profiles;
CREATE POLICY "profiles: read own row"
  ON profiles FOR SELECT
  TO authenticated
  USING (id = auth.uid());
