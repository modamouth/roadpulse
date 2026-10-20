// npm run db:import -- <file.json> [--dry-run]
//
// Loads a JSON array of manually sourced / extracted incidents into the
// review queue (verified=false, needs_review=true). Validates every record
// first and inserts all-or-nothing in one transaction; records that match an
// existing incident (see findExistingIncident) are skipped, so re-running the
// same file is safe.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { pool } from './pool.js';
import { findExistingIncident, ingestIncidentSchema, insertPendingIncident } from './ingest.js';

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: npm run db:import -- <file.json> [--dry-run]');
    process.exit(2);
  }

  // npm workspace scripts run with cwd=backend/; resolve relative paths
  // against where the user actually ran npm from.
  const resolved = path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
  const parsed = z.array(ingestIncidentSchema).safeParse(JSON.parse(readFileSync(resolved, 'utf-8')));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      console.error(`  record ${issue.path[0]} · ${issue.path.slice(1).join('.') || '(record)'}: ${issue.message}`);
    }
    console.error(`Validation failed — nothing imported from ${resolved}`);
    process.exit(1);
  }

  const records = parsed.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let inserted = 0;
    for (const [i, r] of records.entries()) {
      const label = `[${i}] ${r.occurred_at?.slice(0, 10) ?? 'no date'} · ${r.road ?? 'no road'}`;
      const existing = await findExistingIncident(client, r);
      if (existing != null) {
        console.log(`skip    ${label} — already in incidents as #${existing}`);
        continue;
      }
      const id = await insertPendingIncident(client, r);
      inserted++;
      console.log(`${dryRun ? 'would add' : 'added  '} ${label} → #${id}${r.lat == null ? ' (no coordinates — not shown on any map)' : ''}`);
    }
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    console.log(
      dryRun
        ? `Dry run: ${inserted} of ${records.length} would be added (rolled back).`
        : `Imported ${inserted} of ${records.length} into the review queue (pending, unverified).`,
    );
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
