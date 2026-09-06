import { describe, it, expect } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Every rate limiter in the server keys through `rateLimitKey`, enforced by
 * reading the source (DOR-1711).
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
 * Adding a limiter therefore means adding `keyGenerator: rateLimitKey`, or this
 * fails with the file and line that skipped it.
 */

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Where a limiter is built, for a failure message that names the place. */
interface LimiterSite {
  /** Path relative to `apps/server/src`, e.g. `middleware/a2a-rate-limit.ts`. */
  file: string;
  /** 1-based line of the `rateLimit({` that opens the options object. */
  line: number;
  /** Whether the options object names the shared key generator. */
  usesSharedKey: boolean;
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

/**
 * Find each `rateLimit({ ... })` call and report whether its options name
 * `rateLimitKey`.
 *
 * The options object is delimited by brace depth from the opening `{`, so a
 * nested object (the `message` body every limiter has) cannot end the scan
 * early and a second limiter later in the same file is read separately.
 */
function findLimiterSites(file: string, source: string): LimiterSite[] {
  const sites: LimiterSite[] = [];
  const opener = /\brateLimit\s*\(\s*\{/g;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(source)) !== null) {
    const start = source.indexOf('{', match.index);
    let depth = 0;
    let end = start;
    for (; end < source.length; end++) {
      if (source[end] === '{') depth++;
      else if (source[end] === '}' && --depth === 0) break;
    }
    const options = source.slice(start, end + 1);
    sites.push({
      file,
      line: source.slice(0, match.index).split('\n').length,
      usesSharedKey: /keyGenerator:\s*rateLimitKey\b/.test(options),
    });
  }
  return sites;
}

describe('every rate limiter keys through the shared rateLimitKey', () => {
  it('finds no limiter that fell back to req.ip', async () => {
    const files = await sourceFiles(SERVER_SRC);
    const sites = (
      await Promise.all(
        files.map(async (file) =>
          findLimiterSites(path.relative(SERVER_SRC, file), await readFile(file, 'utf8'))
        )
      )
    ).flat();

    // The scan has to actually find something. A regex that silently matched
    // nothing — after a rename, a formatting change, or a move off
    // `express-rate-limit` — would pass this file forever while checking
    // nothing at all, which is the failure this guard exists to prevent.
    expect(sites.length, 'the limiter scan found no call sites at all').toBeGreaterThanOrEqual(6);

    const missing = sites
      .filter((site) => !site.usesSharedKey)
      .map((site) => `${site.file}:${site.line}`);

    expect(
      missing,
      'These rate limiters key on `req.ip`, which `trust proxy, 1` derives from the ' +
        'caller-written `X-Forwarded-For`. Add `keyGenerator: rateLimitKey` from ' +
        '`middleware/rate-limit-key.ts`.'
    ).toEqual([]);
  });
});
