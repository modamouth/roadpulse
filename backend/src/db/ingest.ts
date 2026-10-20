import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';

// Validation + insert for non-public incident writes (historical_extracted /
// official) — shared by POST /api/pipeline/ingest and the `db:import` CLI.
// These entry_types can't come through the public RLS insert policy, so
// they go through the RLS-bypassing DATABASE_URL connection instead.
//
// Fields are .nullish(), not just .optional(): the extraction prompt and
// hand-assembled files use explicit `null` for "not in the source".
export const ingestIncidentSchema = z.object({
  occurred_at: z.string().datetime({ offset: true }).nullish(),
  occurred_at_precision: z.enum(['exact', 'date_only', 'relative', 'unknown']).nullish(),
  road: z.string().nullish(),
  location_description: z.string().nullish(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  region: z.string().nullish(),
  accident_type: z.enum(['collision', 'rollover', 'pedestrian', 'hit_and_run', 'other']).nullish(),
  vehicles_involved: z.array(z.string()).nullish(),
  fatalities: z.number().int().nonnegative().nullish(),
  injuries_count: z.number().int().nonnegative().nullish(),
  injuries_description: z.string().nullish(),
  source_name: z.string().nullish(),
  source_url: z.string().url().nullish(),
  entry_type: z.enum(['historical_extracted', 'official']),
  confidence_notes: z.array(z.string()).nullish(),
  geocode_method: z.enum(['address', 'linear_reference', 'manual_pin']).nullish(),
  // Carried through so synthetic dev data stays labelled (CLAUDE.md).
  is_synthetic: z.boolean().optional(),
  // Accepted so files can carry them, but ignored on insert: everything
  // lands pending review. Refused outright if a record claims to be verified,
  // rather than silently downgrading it.
  verified: z.literal(false).optional(),
  needs_review: z.literal(true).optional(),
}).refine((r) => (r.lat == null) === (r.lng == null), {
  message: 'lat and lng must both be set or both be null',
  path: ['lat'],
});

export type IngestIncident = z.infer<typeof ingestIncidentSchema>;

// Extraction-sourced rows always land unverified — "extracted by an LLM" or
// "copied from a report" is not "confirmed by a human". A moderator approves
// them in the review UI (admin.html) like any other pending incident.
export async function insertPendingIncident(db: Pool | PoolClient, b: IngestIncident): Promise<number> {
  const { rows } = await db.query(
    `INSERT INTO incidents
      (occurred_at, occurred_at_precision, road, location_description, lat, lng, region,
       accident_type, vehicles_involved, fatalities, injuries_count, injuries_description,
       source_name, source_url, entry_type, verified, needs_review, confidence_notes, geocode_method,
       is_synthetic)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,true,$16,$17,$18)
     RETURNING id`,
    [
      b.occurred_at ?? null, b.occurred_at_precision ?? 'unknown', b.road ?? null,
      b.location_description ?? null, b.lat ?? null, b.lng ?? null, b.region ?? null,
      b.accident_type ?? null, b.vehicles_involved ?? null, b.fatalities ?? null,
      b.injuries_count ?? null, b.injuries_description ?? null, b.source_name ?? null,
      b.source_url ?? null, b.entry_type, b.confidence_notes ?? null, b.geocode_method ?? null,
      b.is_synthetic ?? false,
    ],
  );
  return rows[0].id;
}

// Same incident already in the table? Matched on occurred_at + road +
// entry_type — loose on purpose: re-importing a file, or the pipeline seeing
// the same story twice, shouldn't create a second row. Two genuinely
// different crashes on one road at the same timestamp would need a manual
// insert.
export async function findExistingIncident(db: Pool | PoolClient, b: IngestIncident): Promise<number | null> {
  const { rows } = await db.query(
    `SELECT id FROM incidents
      WHERE occurred_at IS NOT DISTINCT FROM $1::timestamptz
        AND road IS NOT DISTINCT FROM $2
        AND entry_type = $3
      LIMIT 1`,
    [b.occurred_at ?? null, b.road ?? null, b.entry_type],
  );
  return rows[0]?.id ?? null;
}
