import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Loads the repo-root .env (see .env.example). Plain `import 'dotenv/config'`
// reads .env from the current working directory, and npm workspace scripts
// (`npm run dev:backend`, `db:migrate`, `db:seed`) run with cwd = backend/,
// so it would miss the root file. Resolved relative to this file instead:
// src/env.ts and dist/env.js both sit two levels below the repo root.
config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env') });
