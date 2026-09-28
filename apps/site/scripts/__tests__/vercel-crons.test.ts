/**
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// A cron route that exists but is not in vercel.json is never called, and a
// vercel.json entry with no route 404s on a schedule. Neither shows up in any
// other gate, and the risk is live from the moment one cron job becomes two.
const SITE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

type VercelConfig = { crons?: { path: string; schedule: string }[]; buildCommand?: string };

const config = JSON.parse(readFileSync(join(SITE_ROOT, 'vercel.json'), 'utf8')) as VercelConfig;
const crons = config.crons ?? [];

describe('vercel.json crons', () => {
  // instance-expiry's Vercel Cron entry is gone: DORKOS_CLOUD_ACCOUNTS_ORIGIN is
  // permanently set in production, the route has answered
  // `{ skipped: 'accounts-service' }` since the accounts hand-over, and DorkOS
  // Cloud's own scheduler now runs that sweep. event-retention stays — it
  // belongs to managed connections, which move separately. See
  // contributing/authentication.md#cleanup-jobs-dor-194.
  it('registers the half of the scheduled cleanup the site still owns', () => {
    expect(crons.map((c) => c.path).sort()).toEqual(['/api/cron/event-retention']);
  });

  it.each(crons)('$path has a route handler on disk', ({ path }) => {
    expect(existsSync(join(SITE_ROOT, 'src/app', path, 'route.ts'))).toBe(true);
  });

  it.each(crons)('$path has a schedule', ({ schedule }) => {
    expect(schedule).toMatch(/^\S+( \S+){4}$/);
  });

  it('applies the public migration history before building, and only that one', () => {
    // `db:migrate` is the public half alone; `deploy-migrations.test.ts` pins
    // what it runs. The control-plane half must never be named here.
    expect(config.buildCommand).toContain('pnpm db:migrate');
    expect(config.buildCommand).not.toMatch(/control-plane/);
  });
});
