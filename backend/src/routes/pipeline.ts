import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';

export const pipelineRouter = Router();

// POST /api/pipeline/ingest — the extraction pipeline's write path.
//
// This is the one write path that still needs a server in front of it:
// `historical_extracted` and `official` rows aren't something the public
// RLS insert policy allows (see schema.sql — that policy only accepts
// entry_type = 'crowdsourced'), on purpose, so this has to go through a
// connection that bypasses RLS. `pool` here should be configured with
// Supabase's service-role connection string (SUPABASE_DB_URL /
// DATABASE_URL in .env.example), never exposed to the frontend.
//
// Not wired to an actual source yet — see CLAUDE.md step 4 (extraction
// pipeline) and pipelines/n8n/README.md. When that's built, n8n (or
// whatever runs the extraction prompt) calls this endpoint, or calls
// Postgres directly with the same credentials — either is fine, this
// route just gives the zod validation a home.
const ingestIncidentSchema = z.object({
  occurred_at: z.string().datetime().nullable().optional(),
  occurred_at_precision: z.enum(['exact', 'date_only', 'relative', 'unknown']).optional(),
  road: z.string().optional(),
  location_description: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  region: z.string().optional(),
  accident_type: z.enum(['collision', 'rollover', 'pedestrian', 'hit_and_run', 'other']).optional(),
  vehicles_involved: z.array(z.string()).optional(),
  fatalities: z.number().int().nonnegative().optional(),
  injuries_count: z.number().int().nonnegative().optional(),
  injuries_description: z.string().optional(),
  source_name: z.string().optional(),
  source_url: z.string().url().optional(),
  entry_type: z.enum(['historical_extracted', 'official']),
  confidence_notes: z.array(z.string()).optional(),
  geocode_method: z.enum(['address', 'linear_reference', 'manual_pin']).optional(),
});

pipelineRouter.post('/ingest', async (req, res) => {
  const parsed = ingestIncidentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const b = parsed.data;

  // Pipeline rows still land unverified — "extracted by an LLM" is not
  // "confirmed by a human". A moderator promotes these the same way as
  // crowdsourced reports, via the Supabase-client moderation UI under
  // the `is_moderator()` RLS policy.
  const { rows } = await pool.query(
    `INSERT INTO incidents
      (occurred_at, occurred_at_precision, road, location_description, lat, lng, region,
       accident_type, vehicles_involved, fatalities, injuries_count, injuries_description,
       source_name, source_url, entry_type, verified, needs_review, confidence_notes, geocode_method)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,false,true,$16,$17)
     RETURNING id`,
    [
      b.occurred_at ?? null, b.occurred_at_precision ?? 'unknown', b.road ?? null,
      b.location_description ?? null, b.lat ?? null, b.lng ?? null, b.region ?? null,
      b.accident_type ?? null, b.vehicles_involved ?? null, b.fatalities ?? null,
      b.injuries_count ?? null, b.injuries_description ?? null, b.source_name ?? null,
      b.source_url ?? null, b.entry_type, b.confidence_notes ?? null, b.geocode_method ?? null,
    ],
  );

  res.status(201).json({ id: rows[0].id, verified: false });
});
