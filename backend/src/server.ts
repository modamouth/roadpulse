import express from 'express';
import cors from 'cors';
import './env.js';
import { pipelineRouter } from './routes/pipeline.js';

// This server's job shrank on purpose: regions/incidents reads, the
// moderation queue, and crowdsourced submission all moved to direct
// Supabase client calls from the frontend, enforced by the RLS
// policies in src/db/schema.sql — see docs/ARCHITECTURE.md for why.
//
// What's left here is the one write path RLS deliberately doesn't
// allow from a public client: the extraction pipeline's ingestion of
// historical/official incident rows, which needs the service-role
// connection (DATABASE_URL in .env.example) and server-side validation.
// This process should never be reachable with the Supabase anon key —
// only with service-role credentials, from a trusted place (e.g. an
// n8n workflow), per CLAUDE.md step 4.

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/api/pipeline', pipelineRouter);

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`RoadPulse pipeline service listening on :${port}`);
});
