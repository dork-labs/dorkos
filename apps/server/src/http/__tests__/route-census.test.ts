/**
 * The route census (DOR-2793, plan rule 2): the real server's routes, split by
 * which framework serves them, must equal the committed baseline, and no route
 * may be served by both.
 *
 * A move PR changes the baseline only by moving entries from `express` to
 * `hono`. Adding or removing a route edits the baseline in plain sight. To
 * regenerate it after an intended change:
 *
 *   pnpm --filter @dorkos/server census:update
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { censusProblems, type RouteCensus } from '../route-census/census.js';
import { BOOT_TIMEOUT_MS, bootComposedServer, type ComposedServer } from './contract/harness.js';

const BASELINE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'route-census.baseline.json'
);

const UPDATE = process.env.UPDATE_ROUTE_CENSUS === '1';

describe('route census', () => {
  let server: ComposedServer | undefined;
  beforeAll(async () => {
    server = await bootComposedServer();
  }, BOOT_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it('serves every baseline route from exactly one framework', async () => {
    const res = await fetch(`${server!.baseUrl}/api/test/route-census`);
    expect(res.status).toBe(200);
    const actual = (await res.json()) as RouteCensus;
    // The census must have found the app at all: an empty walk passes nothing.
    expect(actual.express.length + actual.hono.length).toBeGreaterThan(100);

    if (UPDATE) {
      await writeFile(BASELINE, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(await readFile(BASELINE, 'utf8')) as RouteCensus;
    expect(censusProblems(actual, baseline)).toEqual([]);
  });
});
