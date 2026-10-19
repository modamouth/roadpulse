import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

// The compact per-region dataset produced when the MVA Fund report was
// first extracted (see data/mva-fund-2024/README.md for how it was built,
// and docs/ARCHITECTURE.md for why centroid_lat/lng are approximate).
const REGIONS_PATH = path.join(REPO_ROOT, 'frontend/src/data/regions.json');
const SAMPLE_INCIDENTS_PATH = path.join(REPO_ROOT, 'data/sample-incidents.json');

type RegionRecord = {
  crashes_2024: number; crashes_2023: number;
  injuries_2024: number; injuries_2023: number;
  fatalities_2024: number; fatalities_2023: number;
  population?: number; casualties_per_100000?: number;
  pedestrian_pct: number; rollover_pct: number;
  lat: number; lng: number;
};

async function seedRegionalStats() {
  const regions: Record<string, RegionRecord> = JSON.parse(readFileSync(REGIONS_PATH, 'utf-8'));
  const years = [2023, 2024] as const;

  for (const [name, r] of Object.entries(regions)) {
    for (const year of years) {
      await pool.query(
        `INSERT INTO regional_stats
          (region, year, crashes, fatalities, injuries, population,
           casualties_per_100000, pedestrian_pct, rollover_pct, centroid_lat, centroid_lng)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (region, year) DO UPDATE SET
           crashes = EXCLUDED.crashes,
           fatalities = EXCLUDED.fatalities,
           injuries = EXCLUDED.injuries`,
        [
          name,
          year,
          r[`crashes_${year}` as 'crashes_2024' | 'crashes_2023'],
          r[`fatalities_${year}` as 'fatalities_2024' | 'fatalities_2023'],
          r[`injuries_${year}` as 'injuries_2024' | 'injuries_2023'],
          r.population ?? null,
          // casualties_per_100000 is only published for 2024 in the source report
          year === 2024 ? (r.casualties_per_100000 ?? null) : null,
          r.pedestrian_pct,
          r.rollover_pct,
          r.lat,
          r.lng,
        ],
      );
    }
  }
  console.log(`Seeded regional_stats for ${Object.keys(regions).length} regions × ${years.length} years.`);
}

async function seedSampleIncidents() {
  const incidents = JSON.parse(readFileSync(SAMPLE_INCIDENTS_PATH, 'utf-8'));

  for (const inc of incidents) {
    await pool.query(
      `INSERT INTO incidents
        (occurred_at, occurred_at_precision, road, location_description, lat, lng, region,
         accident_type, vehicles_involved, fatalities, injuries_count, injuries_description,
         source_name, source_url, entry_type, verified, needs_review, confidence_notes,
         geocode_method, is_synthetic)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        inc.occurred_at, inc.occurred_at_precision, inc.road, inc.location_description,
        inc.lat, inc.lng, inc.region, inc.accident_type, inc.vehicles_involved,
        inc.fatalities, inc.injuries_count, inc.injuries_description,
        inc.source_name, inc.source_url, inc.entry_type, inc.verified, inc.needs_review,
        inc.confidence_notes, inc.geocode_method, inc.is_synthetic,
      ],
    );
  }
  console.log(`Seeded ${incidents.length} sample incident(s).`);
}

async function seed() {
  await seedRegionalStats();
  await seedSampleIncidents();
  await pool.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
