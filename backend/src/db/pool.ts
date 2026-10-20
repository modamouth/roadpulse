import { Pool } from 'pg';
import '../env.js';

// DATABASE_URL should be Supabase's session pooler connection string
// (dashboard → Connect → Session pooler, port 5432 — see .env.example for
// why not the direct or transaction-pooler one), which connects as the
// `postgres` role and therefore bypasses Row Level Security — that's
// required for migrate.ts/seed.ts and for the pipeline ingestion route,
// all of which write rows (historical_extracted/official incidents,
// regional_stats) that the public RLS policies don't allow from an
// anon/authenticated client. Never reuse this connection string in the
// frontend; the frontend uses the Supabase anon key instead (see
// frontend/src/api/supabase.ts), which stays subject to RLS.
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env and fill it in.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
