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
  it('registers both halves of the scheduled cleanup', () => {
    expect(crons.map((c) => c.path).sort()).toEqual([
      '/api/cron/event-retention',
      '/api/cron/instance-expiry',
    ]);
  });

  it.each(crons)('$path has a route handler on disk', ({ path }) => {
    expect(existsSync(join(SITE_ROOT, 'src/app', path, 'route.ts'))).toBe(true);
  });

  it.each(crons)('$path has a schedule', ({ schedule }) => {
    expect(schedule).toMatch(/^\S+( \S+){4}$/);
  });

  it('still applies both migration histories before building', () => {
    expect(config.buildCommand).toContain('pnpm db:migrate');
  });
});
