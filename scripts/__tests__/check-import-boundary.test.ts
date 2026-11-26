/**
 * The services import boundary's baseline (`scripts/import-boundary/check-import-boundary.ts`,
 * DOR-4924): it counts what the lint rule refuses, type-only imports left out, and its counts may
 * only fall.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  compare,
  countFile,
  lowered,
  measure,
  raisedAgainst,
  summary,
  valueSpecifiers,
  type Edges,
} from '../import-boundary/check-import-boundary.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVICES = join(ROOT, 'apps/server/src/services');

/** Time allowed for the case that reads every file under services/ (DOR-2021). */
const SCAN_TIMEOUT_MS = 30_000;

describe('valueSpecifiers', () => {
  it('reads every form that carries code, and none that is type-only', () => {
    const text = [
      "import './side-effect.js';",
      "import a from './a.js';",
      "import * as b from './b.js';",
      "import { c, type C } from './c.js';",
      "export * from './d.js';",
      "export { e } from './e.js';",
      "import f = require('./f.js');",
      "const g = () => import('./g.js');",
      "declare module './h.js' { interface H { h: string } }",
      "import type { T1 } from './t1.js';",
      "import { type T2, type T3 } from './t2.js';",
      "export type { T4 } from './t4.js';",
      "export { type T5 } from './t5.js';",
      "import type T6 = require('./t6.js');",
      "type T7 = import('./t7.js').T7;",
      'const t8 = (name: string) => import(`./${name}.js`);',
    ].join('\n');
    expect(valueSpecifiers('example.ts', text)).toEqual([
      './side-effect.js',
      './a.js',
      './b.js',
      './c.js',
      './d.js',
      './e.js',
      './f.js',
      './g.js',
      './h.js',
    ]);
  });
});

describe('countFile', () => {
  it('counts statements into another domain, each folder under core/ its own', () => {
    const text = [
      "import { a } from '../rooms/a.js';",
      "import { b } from '../rooms/b.js';",
      "import { c } from '../core/config/index.js';",
      "import { d } from '../core/config-manager.js';",
      "import { e } from './same/e.js';",
      "import { f } from '../../lib/dork-home.js';",
      "import { z } from 'zod';",
      "import type { T } from '../tasks/t.js';",
    ].join('\n');
    expect(countFile(join(SERVICES, 'scratch-domain/example.ts'), text)).toEqual({
      'scratch-domain -> core': 1,
      'scratch-domain -> core/config': 1,
      'scratch-domain -> rooms': 2,
    });
  });

  it('counts nothing in a test file or a file outside services', () => {
    const text = "import { a } from '../rooms/a.js';";
    expect(countFile(join(SERVICES, 'scratch-domain/__tests__/x.test.ts'), text)).toEqual({});
    expect(countFile(join(ROOT, 'apps/server/src/routes/x.ts'), text)).toEqual({});
  });
});

describe('compare', () => {
  it('reports a new pair, growth, a drop not locked in and a pair gone', () => {
    expect(
      compare({ 'a -> b': 3, 'b -> c': 1, 'c -> d': 1 }, { 'a -> b': 2, 'c -> d': 2, 'x -> y': 4 })
    ).toEqual([
      { kind: 'grew', pair: 'a -> b', count: 3, baseline: 2 },
      { kind: 'new', pair: 'b -> c', count: 1 },
      { kind: 'stale', pair: 'c -> d', count: 1, baseline: 2 },
      { kind: 'stale', pair: 'x -> y', count: 0, baseline: 4 },
    ]);
  });
});

describe('the baseline only goes down', () => {
  it('refuses a count raised or a pair added by hand against the base', () => {
    expect(raisedAgainst({ 'a -> b': 3, 'b -> c': 1 }, { 'a -> b': 2 })).toEqual([
      { kind: 'raised', pair: 'a -> b', count: 3, baseline: 2 },
      { kind: 'raised', pair: 'b -> c', count: 1 },
    ]);
    expect(raisedAgainst({ 'a -> b': 1 }, { 'a -> b': 2, 'b -> c': 1 })).toEqual([]);
  });

  it('--update lowers and removes pairs, and never raises or adds one', () => {
    expect(
      lowered(
        { 'a -> b': 1, 'b -> c': 5, 'new -> x': 2 },
        { 'a -> b': 3, 'b -> c': 2, 'gone -> x': 1 }
      )
    ).toEqual({ 'a -> b': 1, 'b -> c': 2 });
  });
});

describe('summary', () => {
  it('counts pairs, pairs both ways once, and statements', () => {
    const edges: Edges = { 'a -> b': 2, 'b -> a': 1, 'a -> c': 4 };
    expect(summary(edges)).toBe('3 pairs (1 both ways), 7 import statements');
  });
});

describe('the repo', () => {
  it(
    'adds no pair or statement beyond the baseline, and has locked in every drop',
    { timeout: SCAN_TIMEOUT_MS },
    () => {
      const baseline = (
        JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), 'utf8')) as { edges: Edges }
      ).edges;
      expect(
        compare(measure(ROOT).edges, baseline),
        'Depend on a port or move a shared type to packages/shared. After removing imports, run `pnpm check:import-boundary -- --update`.'
      ).toEqual([]);
    }
  );
});
