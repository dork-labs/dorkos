/**
 * The route census (DOR-2793): the real server's routes must equal the
 * committed baseline, so adding or removing a route is an edit a reviewer sees.
 * To regenerate it after an intended change:
 *
 *   pnpm --filter @dorkos/server census:update
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { censusProblems, ROUTE_CENSUS_PATH, type RouteCensus } from '../route-census/census.js';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  type ComposedServer,
} from './contract/harness.js';

const BASELINE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'route-census.baseline.json'
);

const UPDATE = process.env.UPDATE_ROUTE_CENSUS === '1';

describe('route census', () => {
  let server: ComposedServer | undefined;
  beforeAll(async () => {
    server = await bootComposedServer();
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it('serves exactly the baseline routes', async () => {
    const res = await fetch(`${server!.baseUrl}${ROUTE_CENSUS_PATH}`);
    expect(res.status).toBe(200);
    const actual = (await res.json()) as RouteCensus;
    // The census must have found the app at all: an empty walk passes nothing.
    expect(actual.routes.length).toBeGreaterThan(100);

    if (UPDATE) {
      await writeFile(BASELINE, `${JSON.stringify(actual, null, 2)}\n`);
      return;
    }
    const baseline = JSON.parse(await readFile(BASELINE, 'utf8')) as RouteCensus;
    // A subsystem that failed to start mounts nothing, which reads as dozens of
    // routes gone; the server's own log says why.
    expect(censusProblems(actual, baseline), server!.log()).toEqual([]);
  });
});
