// Talks to Supabase directly via supabase-js instead of a custom
// Express API — see docs/ARCHITECTURE.md and docs/DECISIONS.md for why
// (RLS policies in backend/src/db/schema.sql enforce the "public only
// sees verified incidents" / "crowdsourced writes land unverified"
// rules that used to live in route handlers). The one thing still
// behind a server is the extraction pipeline's write path
// (backend/src/routes/pipeline.ts), which isn't called from here.
import { supabase } from './supabase';

export type RegionStat = {
  region: string;
  year: number;
  crashes: number;
  fatalities: number;
  injuries: number;
  population: number | null;
  casualties_per_100000: number | null;
  pedestrian_pct: number;
  rollover_pct: number;
  centroid_lat: number;
  centroid_lng: number;
};

export type Incident = {
  id: number;
  occurred_at: string | null;
  occurred_at_precision: string | null;
  road: string | null;
  location_description: string | null;
  lat: number | null;
  lng: number | null;
  region: string | null;
  accident_type: string | null;
  vehicles_involved: string[] | null;
  fatalities: number | null;
  injuries_count: number | null;
  injuries_description: string | null;
  source_name: string | null;
  source_url: string | null;
  entry_type: string;
  verified: boolean;
};

export async function fetchRegions(year: number): Promise<RegionStat[]> {
  const { data, error } = await supabase
    .from('regional_stats')
    .select(
      'region, year, crashes, fatalities, injuries, population, casualties_per_100000, ' +
        'pedestrian_pct, rollover_pct, centroid_lat, centroid_lng',
    )
    .eq('year', year)
    .order('region');

  if (error) throw new Error(`fetchRegions failed: ${error.message}`);
  return data as RegionStat[];
}

// Public incident reads only ever return verified rows — not because
// this query says so, but because the RLS policy
// "incidents: public reads verified only" filters them server-side
// regardless of what's asked for here. Belt-and-suspenders: the
// explicit .eq keeps that intent visible in the client code too.
export async function fetchIncidents(): Promise<Incident[]> {
  const { data, error } = await supabase
    .from('incidents')
    .select(
      'id, occurred_at, occurred_at_precision, road, location_description, lat, lng, region, ' +
        'accident_type, vehicles_involved, fatalities, injuries_count, injuries_description, ' +
        'source_name, source_url, entry_type, verified',
    )
    .eq('verified', true)
    .order('occurred_at', { ascending: false, nullsFirst: false });

  if (error) throw new Error(`fetchIncidents failed: ${error.message}`);
  return data as Incident[];
}

export type IncidentSubmission = {
  occurred_at?: string | null;
  occurred_at_precision?: 'exact' | 'date_only' | 'relative' | 'unknown';
  road?: string;
  location_description?: string;
  lat?: number;
  lng?: number;
  region?: string;
  accident_type?: 'collision' | 'rollover' | 'pedestrian' | 'hit_and_run' | 'other';
  vehicles_involved?: string[];
  fatalities?: number;
  injuries_count?: number;
  injuries_description?: string;
  source_name?: string;
  source_url?: string;
};

// Crowdsourced submission — not wired into the UI yet (see CLAUDE.md
// open question on whether this is in scope for v1). verified/
// needs_review/entry_type are NOT accepted here on purpose: the RLS
// insert policy requires entry_type='crowdsourced', verified=false,
// needs_review=true, so this helper sets them itself rather than
// letting a caller try to override them (which the database would
// reject anyway).
//
// No `.select()` after the insert, so nothing comes back — not even the id.
// Reading the new row back needs SELECT on it, and the only public SELECT
// policy is `verified = true`, so asking for it makes PostgREST fail the
// whole request with an RLS error. If the UI later needs a receipt id,
// add a SECURITY DEFINER RPC that inserts and returns it.
export async function submitIncident(report: IncidentSubmission): Promise<void> {
  const { error } = await supabase
    .from('incidents')
    .insert({ ...report, entry_type: 'crowdsourced', verified: false, needs_review: true });

  if (error) throw new Error(`submitIncident failed: ${error.message}`);
}

// --- Moderation (requires a signed-in user with profiles.role =
// 'moderator' — see schema.sql). Not wired into any UI yet; this is
// the client-side half of CLAUDE.md step 5. Calling these while signed
// out, or signed in as a non-moderator, will come back empty / error
// out under RLS rather than leaking review-queue data.

export async function fetchReviewQueue(): Promise<Incident[]> {
  const { data, error } = await supabase
    .from('incidents')
    .select('*')
    .eq('verified', false)
    .order('created_at', { ascending: false });

  if (error) throw new Error(`fetchReviewQueue failed: ${error.message}`);
  return data as Incident[];
}

export async function setIncidentVerified(id: number, verified: boolean): Promise<void> {
  const { error } = await supabase
    .from('incidents')
    .update({ verified, needs_review: !verified })
    .eq('id', id);

  if (error) throw new Error(`setIncidentVerified failed: ${error.message}`);
}
