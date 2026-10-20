import { Router } from 'express';
import { pool } from '../db/pool.js';
import { findExistingIncident, ingestIncidentSchema, insertPendingIncident } from '../db/ingest.js';

export const pipelineRouter = Router();

// POST /api/pipeline/ingest — the extraction pipeline's write path.
//
// This is the one write path that still needs a server in front of it:
// `historical_extracted` and `official` rows aren't something the public
// RLS insert policy allows (see schema.sql — that policy only accepts
// entry_type = 'crowdsourced'), on purpose, so this has to go through a
// connection that bypasses RLS (DATABASE_URL — see db/pool.ts), never
// exposed to the frontend.
//
// Not wired to an actual source yet — see CLAUDE.md step 4 (extraction
// pipeline) and pipelines/n8n/README.md. When that's built, n8n (or
// whatever runs the extraction prompt) calls this endpoint. Validation and
// the insert live in db/ingest.ts, shared with `npm run db:import`.
pipelineRouter.post('/ingest', async (req, res) => {
  const parsed = ingestIncidentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const existing = await findExistingIncident(pool, parsed.data);
  if (existing != null) {
    return res.status(409).json({ error: 'duplicate', id: existing });
  }

  const id = await insertPendingIncident(pool, parsed.data);
  res.status(201).json({ id, verified: false });
});
