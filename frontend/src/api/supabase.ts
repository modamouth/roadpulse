import { createClient } from '@supabase/supabase-js';

// Safe to ship in frontend code: this is the anon key, which only ever
// grants what the RLS policies in backend/src/db/schema.sql allow an
// anon/authenticated client — public reads of regional_stats and
// verified incidents, plus crowdsourced inserts that are forced to
// land unverified. It is NOT the service-role key (that one lives only
// in backend/.env, server-side — see db/pool.ts).
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set — copy .env.example to frontend/.env ' +
      'and fill them in from your Supabase project settings.',
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
