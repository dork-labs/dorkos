/**
 * One query key for `GET /api/config`, and one request for it.
 *
 * **The defect this catches is invisible in every other way.** A hook that
 * spells `['config']` and a hook that calls `configKeys.current()` are two cache
 * entries and two round trips for the same file on disk — both compile, both
 * type-check, both work. The visible symptom is a second beat on boot: the
 * sidebar's pins, groups and mute state restructured a round trip after the
 * panel had already painted, and the digest's once-a-day latch read `undefined`
 * prefs because its own copy had not landed yet (spec `sidebar-simplification`
 * D6, "one fetch per fact").
 *
 * So the literal is banned, and `configKeys` is the only place it may appear.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `apps/client/src`. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The one file allowed to spell the key.
 *
 * It lives in `shared/` rather than `entities/config` because `shared/` reads
 * config too and may not import an entity — which is exactly why three hooks
 * down there used to hand-spell it.
 */
const KEY_FACTORY = 'layers/shared/model/server-config/query-keys.ts';

/** This file, which spells the banned shapes on purpose to prove it sees them. */
const SELF = '__tests__/one-config-query-key.test.ts';

/**
 * The bare key, as source text — the shape the rule is written about.
 *
 * Built by concatenation so this file does not trip its own rule.
 */
const BARE_KEY = `['${'config'}']`;

/**
 * An array literal that IS a config query key.
 *
 * Deliberately wider than the one literal the review found: `["config"]` is the
 * same cache entry in different quotes, and `['config', 'current']` is the same
 * entry again spelled by hand instead of through the factory — which is exactly
 * how `useClaudeAccounts` came to hold its own copy of the key.
 *
 * And deliberately no wider than that. The two forms above are the whole key
 * space (`configKeys.all` and `configKeys.current()`), so requiring the array to
 * END there is what separates a query key from an ordinary array whose first
 * word happens to be "config" — the Dev Playground's search keywords, for
 * instance, which are prose and not a cache entry.
 *
 * The leading class rejects an indexed type (`AdapterListItem['config']`),
 * where an identifier or a closing bracket sits immediately before the `[`.
 */
const KEY_LITERAL = /(^|[^\w\]$])\[\s*['"]config['"]\s*(\]|,\s*['"]current['"]\s*\])/;

/**
 * The 1-based line numbers on which `source` mints a config key by hand.
 *
 * Two shapes are deliberately allowed through: a comment, which is prose about
 * the key rather than a use of it, and an indexed TYPE (`SomeType['config']`),
 * which is a property lookup and not a query key at all.
 *
 * @param source - A TypeScript file's text.
 */
function bareKeyOffenders(source: string): number[] {
  const lines = source.split('\n');
  const offenders: number[] = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;
    if (!KEY_LITERAL.test(line)) continue;
    offenders.push(index + 1);
  }
  return offenders;
}

/** Every `.ts`/`.tsx` file under `apps/client/src`. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('one config query key', () => {
  it('finds the bare key nowhere but the factory that defines it', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      // The factory, which defines the key, and this file, whose fixtures spell
      // the offending shapes on purpose to prove the scanner sees them.
      if (rel === KEY_FACTORY || rel === SELF) continue;
      for (const line of bareKeyOffenders(readFileSync(file, 'utf8'))) {
        offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('catches a query that reintroduces the bare key', () => {
    // The scanner, proven on the exact shape it exists to stop — otherwise the
    // sweep above could be green because the search never matches anything.
    const source = ['const q = useQuery({', `  queryKey: ${BARE_KEY},`, '});'].join('\n');
    expect(bareKeyOffenders(source)).toEqual([2]);
  });

  it('catches the other quotes and the hand-spelled current key', () => {
    // The two shapes the first cut of this scanner would have missed. Both are
    // the same cache entry as the factory's, reached without it — which is how
    // `shared/model` came to hold its own copy of the key in the first place.
    const source = [
      'const a = useQuery({ queryKey: ["config"] });',
      "const b = useQuery({ queryKey: ['config', 'current'] });",
      'const c = ["config", "current"] as const;',
    ].join('\n');
    expect(bareKeyOffenders(source)).toEqual([1, 2, 3]);
  });

  it('leaves an indexed type and a comment alone', () => {
    const source = [
      `// The old ${BARE_KEY} entry is gone.`,
      `type Config = AdapterListItem${BARE_KEY};`,
      'const d = someList[0]["config"];',
      'const e = configKeys.current();',
    ].join('\n');
    expect(bareKeyOffenders(source)).toEqual([]);
  });
});
