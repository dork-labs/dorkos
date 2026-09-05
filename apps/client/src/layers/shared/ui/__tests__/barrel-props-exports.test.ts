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
 * This walks the real barrel and the real sources rather than pinning a list: a
 * list would go stale the next time somebody adds a component.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
      const name = entry.replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim();
      (isType ? types : values).add(name);
    }
  }
  return { values, types };
}

describe('shared/ui barrel', () => {
  it('publishes the props type of every component it publishes', () => {
    const { values, types } = barrelExports();
    const missing: string[] = [];

    for (const file of sourceFiles(UI_DIR)) {
      const src = readFileSync(file, 'utf8');
      for (const match of src.matchAll(/^(?:export\s+)?(?:interface|type)\s+(\w+)Props\b/gm)) {
        const component = match[1];
        if (!values.has(component)) continue;
        if (types.has(`${component}Props`)) continue;
        missing.push(`${component}Props (declared in ${file.slice(UI_DIR.length + 1)})`);
      }
    }

    expect(missing).toEqual([]);
  });
});
