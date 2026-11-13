import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A spec that changes the test-mode runtime's DEFAULT scenario puts it back.
 *
 * The scenario store is server-global, and the test-mode projects share one
 * server per shard. A spec that selects a default scenario (a
 * `POST /api/test/scenario` without a `sessionId`) and leaves it on changes how
 * every later turn on that server answers — in DOR-2422's merge-queue runs the
 * browser-driving spec left `browser-driving` on, and #team's fallback seat in
 * the next spec never replied. Which spec suffers depends on how the shards
 * happen to be dealt, so the failure is reported far from its cause.
 *
 * So: a `*.spec.ts` that selects a default scenario other than `simple-text`
 * (the store's own default) must have a `test.afterEach` or `test.afterAll`
 * that resets the store (`/api/test/reset`) or selects `simple-text` again.
 */

const TESTS_DIR = join(import.meta.dirname, '..', 'tests');

function specFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return specFiles(path);
    return name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** Whether the source selects a default scenario other than `simple-text`. */
function setsDefaultScenario(source: string): boolean {
  const calls = source.matchAll(/\/api\/test\/scenario[`'"]\s*,\s*\{\s*data:\s*\{([^}]*)\}/g);
  return [...calls].some(
    ([, data]) => !/\bsessionId\b/.test(data!) && !/'simple-text'/.test(data!)
  );
}

/** The bodies of every `test.afterEach(...)` / `test.afterAll(...)` hook. */
function afterHookBodies(source: string): string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(/test\.after(?:Each|All)\(/g)) {
    let depth = 1;
    let index = match.index! + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      index += 1;
    }
    bodies.push(source.slice(start, index));
  }
  return bodies;
}

/** Whether one of these hook bodies resets the store or selects `simple-text`. */
function putsItBack(bodies: string[]): boolean {
  return bodies.some((body) => body.includes('/api/test/reset') || body.includes("'simple-text'"));
}

/**
 * Shared setup a spec may call instead of writing the hook itself, and the file
 * that defines it. The `chat-mock*.spec.ts` files all call `useMockServer()`,
 * whose `test.afterEach` resets the store; the last case below holds that file
 * to the same rule, so the exemption cannot outlive the hook it stands for.
 */
const SHARED_SETUP = [{ call: 'useMockServer()', file: 'chat/mock-server.ts' }];

describe('specs that change the default scenario', () => {
  it('put it back after themselves', () => {
    const offenders = specFiles(TESTS_DIR)
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        if (!setsDefaultScenario(source)) return false;
        if (SHARED_SETUP.some(({ call }) => source.includes(call))) return false;
        return !putsItBack(afterHookBodies(source));
      })
      .map((file) => relative(TESTS_DIR, file));
    expect(offenders).toEqual([]);
  });

  it('accepts shared setup only where that setup puts it back', () => {
    for (const { file } of SHARED_SETUP) {
      expect(putsItBack(afterHookBodies(readFileSync(join(TESTS_DIR, file), 'utf8'))), file).toBe(
        true
      );
    }
  });

  it('still recognises the specs it is meant to police', () => {
    // A guard whose matcher silently stopped matching would pass forever.
    const policed = specFiles(TESTS_DIR)
      .filter((file) => setsDefaultScenario(readFileSync(file, 'utf8')))
      .map((file) => relative(TESTS_DIR, file));
    expect(policed).toEqual(
      expect.arrayContaining(['workbench/browser-driving.spec.ts', 'streams/session-queue.spec.ts'])
    );
  });
});
