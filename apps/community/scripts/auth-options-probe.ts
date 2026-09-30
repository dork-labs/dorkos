/**
 * Answer `GET /api/v1/auth-options` as a Community booted with the given settings would, with no
 * database and no network: the settings are validated by the real `parseConfig` and the answer
 * comes from the real route. Reads the environment as one JSON object on stdin and prints the
 * response body. Run as `pnpm --filter @dorkos/community auth-options:probe`.
 *
 * The launcher's offline package proof (`pnpm --filter dorkos test:community-package`) feeds it
 * exactly what a launch hands the Community (the Fly config's `[env]` and the staged secrets), so
 * "a launched Community offers no DorkOS sign-in" is checked against the real server code before
 * any paid run reads the same route live (DOR-2593).
 *
 * @module community/scripts/auth-options-probe
 */
import type { Pool } from 'pg';
import { createCommunityApp } from '../src/app.js';
import { parseConfig } from '../src/config.js';

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const environment = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, string>;
// The route reads settings only, so a pool that refuses every query is enough. (Better Auth's own
// background schema check fails against it and logs; that has no bearing on the answer.)
const pool = {
  query: () => Promise.reject(new Error('auth-options must not touch the database')),
  connect: () => Promise.reject(new Error('auth-options must not touch the database')),
} as unknown as Pool;
const app = createCommunityApp({ config: parseConfig(environment), pool });
const response = await app.request('/api/v1/auth-options');
if (response.status !== 200) throw new Error(`auth-options answered ${response.status}`);
process.stdout.write(`${JSON.stringify(await response.json())}\n`);
