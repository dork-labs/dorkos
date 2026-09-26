/**
 * Every component on the `shared/ui` barrel publishes its props type too.
 *
 * `fsd-layers.md` makes a deep import an ESLint error, so a consumer who wants
 * `function MyDialog(props: ResponsiveDialogProps)` has exactly two options when
 * the type is missing: redeclare the shape by hand, or reach for
 * `React.ComponentProps<typeof X>` and hope the component forwards everything it
 * destructures. Twenty-five types were missing when this test was written and
 * fifteen were present, so the gaps read as accidents rather than as
 * encapsulation (DOR-1761).
 *
 * The second suite applies the same argument to `cva`/`tv` variant tables: a
 * `*Variants` object the barrel cannot see is a set of classes a sibling
 * component has to retype by hand. Three of fourteen were unreachable when that
 * suite was written (DOR-1871).
 *
 * This walks the real barrel and the real sources rather than pinning a list: a
 * list would go stale the next time somebody adds a component.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const BARREL = join(UI_DIR, 'index.ts');

/** Every `.ts`/`.tsx` source under `shared/ui`, tests and the barrel aside. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      return entry === '__tests__' ? [] : sourceFiles(path);
    }
    if (entry === 'index.ts' || !/\.tsx?$/.test(entry)) return [];
    return [path];
  });
}

/** Follow package leaf facades so an ownership move cannot hide an export gap. */
function ownedSources(): string[] {
  const local = sourceFiles(UI_DIR);
  const packageRoot = dirname(createRequire(import.meta.url).resolve('@dork-labs/ui/package.json'));
  const sources = new Set(local);
  for (const file of local) {
    for (const match of readFileSync(file, 'utf8').matchAll(
      /from ['"]@dork-labs\/ui\/([^'"]+)['"]/g
    )) {
      const base = join(packageRoot, 'src', match[1]);
      const target = existsSync(`${base}.tsx`) ? `${base}.tsx` : `${base}.ts`;
      expect(existsSync(target), `missing source for ${match[0]}`).toBe(true);
      sources.add(target);
    }
  }
  return [...sources];
}

/**
 * The names the barrel re-exports, split by whether they are types.
 *
 * `export type { X }` and `export { type X }` both count as a type export; the
 * second spelling is the one `index.ts` mostly uses.
 */
function barrelExports(): { values: Set<string>; types: Set<string> } {
  const src = readFileSync(BARREL, 'utf8');
  const values = new Set<string>();
  const types = new Set<string>();
  for (const match of src.matchAll(/export\s+(type\s+)?\{([^}]*)\}/g)) {
    const blockIsType = Boolean(match[1]);
    for (const raw of match[2].split(',')) {
      const entry = raw.trim();
      if (!entry) continue;
      const isType = blockIsType || entry.startsWith('type ');
      const name = entry
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      (isType ? types : values).add(name);
    }
  }
  return { values, types };
}

describe('shared/ui barrel', () => {
  it('publishes the props type of every component it publishes', () => {
    const { values, types } = barrelExports();
    // If the barrel's export regex stops matching, or `UI_DIR` moves, `values`
    // comes back empty and every candidate below is silently skipped — the
    // test would report green having checked nothing. Pin that it actually
    // parsed the barrel: 326 value exports and 112 type exports today, so a
    // floor well under either catches the regex breaking without pinning the
    // exact count.
    expect(values.size).toBeGreaterThan(100);
    expect(types.size).toBeGreaterThan(30);

    const missing: string[] = [];
    let subjects = 0;

    for (const file of ownedSources()) {
      const src = readFileSync(file, 'utf8');
      for (const match of src.matchAll(/^(?:export\s+)?(?:interface|type)\s+(\w+)Props\b/gm)) {
        const component = match[1];
        if (!values.has(component)) continue;
        subjects++;
        if (types.has(`${component}Props`)) continue;
        missing.push(`${component}Props (declared in ${relative(UI_DIR, file)})`);
      }
    }

    // Same guard, aimed at the loop itself rather than the barrel parse: a
    // named `*Props` type is only a candidate this test can see at all — see
    // the coverage gap noted below for components whose props type is an
    // inline `React.ComponentProps<...>` instead.
    expect(subjects).toBeGreaterThan(50);
    expect(missing).toEqual([]);
  });
});

describe('shared/ui variant tables', () => {
  it('publishes every `*Variants` object declared under shared/ui', () => {
    const { values } = barrelExports();
    // Same anti-vacuity guard as above: an empty `values` would make every
    // variant object below look published.
    expect(values.size).toBeGreaterThan(100);

    const missing: string[] = [];
    let subjects = 0;

    for (const file of ownedSources()) {
      const src = readFileSync(file, 'utf8');
      for (const match of src.matchAll(/^\s*(?:export\s+)?const\s+(\w+Variants)\s*=/gm)) {
        const name = match[1];
        subjects++;
        if (values.has(name)) continue;
        missing.push(`${name} (declared in ${relative(UI_DIR, file)})`);
      }
    }

    // Shared tables stay in the audit through their real leaf facades. Keep
    // the coverage floor so the source walk cannot pass vacuously.
    expect(subjects).toBeGreaterThanOrEqual(12);
    expect(missing).toEqual([]);
  });
});
