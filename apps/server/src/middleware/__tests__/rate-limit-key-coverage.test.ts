import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every rate limiter in the server keys through `rateLimitKey`, enforced by
 * reading the source (DOR-1711).
 *
 * Since DOR-2796 the server has one limiter, `http/rate-limiter.ts`, and its two
 * adapters (`expressRateLimit`, `honoRateLimit`) take the key from
 * `rateLimitKey` themselves; a limiter cannot be built with any other key. What
 * is left to guard is a way around them: a limiter package brought back, or the
 * bare `createRateLimiter` counted under a key of somebody's own.
 *
 * ## Why a source scan rather than a behavioural test
 *
 * The defect this closes is an OMISSION, and an omission has no behaviour to
 * assert. Before DOR-1711 all six limiters silently took `express-rate-limit`'s
 * default key, `req.ip` — which `app.ts`'s `trust proxy, 1` derives from
 * `X-Forwarded-For`, so a caller who rotated that header got a fresh budget per
 * request. Nothing failed. The limiters ran, returned 429s in tests that drove
 * one socket, and were bypassable by anyone who thought to try.
 *
 * A per-limiter behavioural test would catch the six that exist; it cannot catch
 * the seventh somebody adds next quarter, which is the failure mode that put
 * this ticket in the backlog in the first place. So this walks the tree, finds
 * every `rateLimit({` construction site, and requires each to name the shared
 * key. It is the same shape as `scripts/assert-tests-executed.sh`: a guard whose
 * whole job is to notice something that did not happen.
 *
 * Adding a limiter therefore means building it with `expressRateLimit` or
 * `honoRateLimit`, or this fails with the file and line that went around them.
 */

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** The one module allowed to count requests under a key it was handed. */
const LIMITER_MODULE = path.join('http', 'rate-limiter.ts');

/** A limiter built somewhere, for a failure message that names the place. */
interface Site {
  /** Path relative to `apps/server/src`. */
  file: string;
  /** 1-based line. */
  line: number;
}

/** Every `.ts` file under `apps/server/src`, tests and type declarations aside. */
async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return entry.name === '__tests__' || entry.name === 'node_modules' ? [] : sourceFiles(full);
      }
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
    })
  );
  return found.flat();
}

/** Every match of `pattern` in `source`, as a site. */
function sitesOf(file: string, source: string, pattern: RegExp): Site[] {
  return [...source.matchAll(pattern)].map((match) => ({
    file,
    line: source.slice(0, match.index).split('\n').length,
  }));
}

/** Every source file under `apps/server/src`, read. */
async function readSources(): Promise<Array<{ file: string; source: string }>> {
  const files = await sourceFiles(SERVER_SRC);
  return Promise.all(
    files.map(async (file) => ({
      file: path.relative(SERVER_SRC, file),
      source: await readFile(file, 'utf8'),
    }))
  );
}

const describeSites = (sites: Site[]): string[] => sites.map((s) => `${s.file}:${s.line}`);

describe('every rate limiter keys through the shared rateLimitKey', () => {
  it('builds every limiter through the adapters that key on rateLimitKey', async () => {
    const sources = await readSources();
    const sites = sources.flatMap(({ file, source }) =>
      sitesOf(file, source, /\b(?:expressRateLimit|honoRateLimit)\s*\(\s*\{/g)
    );
    // The scan has to actually find something. A regex that silently matched
    // nothing (after a rename or a formatting change) would pass this file
    // forever while checking nothing at all.
    expect(sites.length, 'the limiter scan found no call sites at all').toBeGreaterThanOrEqual(8);
  });

  it('finds no limiter package, which would key on req.ip', async () => {
    const sources = await readSources();
    const imports = sources.flatMap(({ file, source }) =>
      sitesOf(
        file,
        source,
        /(?:from\s+|import\(\s*|require\(\s*)['"](?:express-rate-limit|hono-rate-limiter|rate-limiter-flexible|express-slow-down)['"]/g
      )
    );
    expect(
      describeSites(imports),
      'A limiter package keys on `req.ip`, which `trust proxy, 1` derives from the ' +
        'caller-written `X-Forwarded-For`. Use `expressRateLimit` or `honoRateLimit` from ' +
        '`http/rate-limiter.ts`.'
    ).toEqual([]);
  });

  it('counts under a key of its own choosing nowhere but the limiter module', async () => {
    const sources = await readSources();
    const bare = sources
      .filter(({ file }) => file !== LIMITER_MODULE)
      .flatMap(({ file, source }) => sitesOf(file, source, /\bcreateRateLimiter\s*\(/g));
    expect(
      describeSites(bare),
      '`createRateLimiter` counts under whatever key it is handed. Build the limiter ' +
        'with `expressRateLimit` or `honoRateLimit`, which key through `rateLimitKey`.'
    ).toEqual([]);
  });
});
