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
    // One string literal, not `'...' + '...'`: supabase-js parses the column
    // list at the type level, and a concatenated (non-literal) string types
    // the rows as GenericStringError, which breaks `tsc`.
    .select(
      'region, year, crashes, fatalities, injuries, population, casualties_per_100000, pedestrian_pct, rollover_pct, centroid_lat, centroid_lng',
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
      'id, occurred_at, occurred_at_precision, road, location_description, lat, lng, region, accident_type, vehicles_involved, fatalities, injuries_count, injuries_description, source_name, source_url, entry_type, verified',
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
// 'moderator' — see schema.sql). Used by the review UI (admin.html).
// Calling these while signed out, or signed in as a non-moderator, comes
// back empty / errors out under RLS rather than leaking review-queue data.

export type ReviewItem = Incident & {
  occurred_at_precision: string | null;
  needs_review: boolean;
  confidence_notes: string[] | null;
  geocode_method: string | null;
  is_synthetic: boolean;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
};

// The three moderation states (see schema.sql):
//   pending  = needs_review                      (not verified=false: rejected
//   approved = verified                           rows are unverified too, but
//   rejected = !verified && !needs_review         have been reviewed)
export type ReviewStatus = 'pending' | 'approved' | 'rejected';
export type EntryType = 'historical_extracted' | 'crowdsourced' | 'official';

const STATUS_FILTER: Record<ReviewStatus, Record<string, boolean>> = {
  pending: { needs_review: true },
  approved: { verified: true },
  rejected: { verified: false, needs_review: false },
};

function filterFor(status: ReviewStatus, entryType?: EntryType): Record<string, boolean | string> {
  return entryType ? { ...STATUS_FILTER[status], entry_type: entryType } : STATUS_FILTER[status];
}

// Pending: oldest first (work the queue in order). Reviewed: most recently
// reviewed first.
export async function fetchModerationList(status: ReviewStatus, entryType?: EntryType): Promise<ReviewItem[]> {
  const q = supabase
    .from('incidents')
    .select(
      'id, occurred_at, occurred_at_precision, road, location_description, lat, lng, region, accident_type, vehicles_involved, fatalities, injuries_count, injuries_description, source_name, source_url, entry_type, verified, needs_review, confidence_notes, geocode_method, is_synthetic, created_at, reviewed_by, reviewed_at, review_note',
    )
    .match(filterFor(status, entryType));

  const { data, error } = await (status === 'pending'
    ? q.order('created_at', { ascending: true })
    : q.order('reviewed_at', { ascending: false, nullsFirst: false }));
  if (error) throw new Error(`fetchModerationList failed: ${error.message}`);
  return data as ReviewItem[];
}

export async function fetchModerationCounts(entryType?: EntryType): Promise<Record<ReviewStatus, number>> {
  const statuses: ReviewStatus[] = ['pending', 'approved', 'rejected'];
  const results = await Promise.all(
    statuses.map(async (status) => {
      const { count, error } = await supabase
        .from('incidents')
        .select('id', { count: 'exact', head: true })
        .match(filterFor(status, entryType));
      if (error) throw new Error(`fetchModerationCounts failed: ${error.message}`);
      return [status, count ?? 0] as const;
    }),
  );
  return Object.fromEntries(results) as Record<ReviewStatus, number>;
}

// Send an approved/rejected incident back to the pending queue (an approved
// one leaves the public map immediately). `note` is required; the previous
// decision is kept in confidence_notes — see reopen_incident() in schema.sql.
export async function reopenIncident(id: number, note: string): Promise<void> {
  const { error } = await supabase.rpc('reopen_incident', { p_id: id, p_note: note });
  if (error) throw new Error(`reopenIncident failed: ${error.message}`);
}

// Place/move an incident's coordinate by hand (pending or approved — see
// set_incident_location() in schema.sql). `note` is required: it's recorded
// in confidence_notes as how the location was derived.
export async function setIncidentLocation(id: number, lat: number, lng: number, note: string): Promise<void> {
  const { error } = await supabase.rpc('set_incident_location', { p_id: id, p_lat: lat, p_lng: lng, p_note: note });
  if (error) throw new Error(`setIncidentLocation failed: ${error.message}`);
}

// reviewed_by uuid → email, for showing who reviewed what.
export async function fetchReviewerEmails(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase.rpc('reviewer_emails', { p_ids: ids });
  if (error) throw new Error(`fetchReviewerEmails failed: ${error.message}`);
  return new Map((data as { reviewer_id: string; reviewer_email: string }[]).map((r) => [r.reviewer_id, r.reviewer_email]));
}

// Approve (→ public map) or reject (→ kept, hidden) a pending incident.
// Goes through the review_incident() function rather than an UPDATE: it
// records who/when/why and can't touch any other column. Fails if the row
// was already reviewed (e.g. by another moderator in the meantime).
export async function reviewIncident(id: number, approve: boolean, note?: string): Promise<void> {
  const { error } = await supabase.rpc('review_incident', { p_id: id, p_approve: approve, p_note: note ?? null });
  if (error) throw new Error(`reviewIncident failed: ${error.message}`);
}
