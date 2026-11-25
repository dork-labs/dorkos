/**
 * The turn port's ratchet baseline (`scripts/turn-port/check-turn-port-boundary.ts`,
 * spec `turns-survive-restarts` §3.4): it measures what the lint rule counts,
 * and its numbers may only fall.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  compare,
  countCrossings,
  lowered,
  measure,
  raisedAgainst,
} from '../turn-port/check-turn-port-boundary.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVICES = join(ROOT, 'apps/server/src/services');

/** Time allowed for the case that reads every space-side file (DOR-2021). */
const SCAN_TIMEOUT_MS = 30_000;

describe('countCrossings', () => {
  it('counts every import form into turn code, type-only included, by resolved path', () => {
    const text = [
      "import '../session/message-dispatcher.js';",
      "import type { DispatchPlan } from '../session/message-dispatcher/types.js';",
      "export { x } from '../runtimes/claude-code/index.js';",
      "const later = () => import('../session/message-queue-store.js');",
    ].join('\n');
    expect(countCrossings(join(SERVICES, 'rooms/example.ts'), text)).toBe(4);
    const typeForms = [
      "type Plan = import('../session/message-dispatcher/types.js').DispatchPlan;",
      "import queue = require('../session/message-queue-store.js');",
    ].join('\n');
    expect(countCrossings(join(SERVICES, 'rooms/example.ts'), typeForms)).toBe(2);
  });

  it('never counts the turn port, chat messages, a package, or a folder named session elsewhere', () => {
    const text = [
      "import { turnPort } from '../runs/index.js';",
      "import { fence } from '../session/chat-messages/chat-message-fence.js';",
      "import { z } from 'zod';",
      "import { run } from './session/run-session.js';",
    ].join('\n');
    expect(countCrossings(join(SERVICES, 'tasks/example.ts'), text)).toBe(0);
  });
});

describe('compare', () => {
  it('reports growth, a new file, a drop the baseline has not locked in, and a file gone', () => {
    expect(
      compare({ 'a.ts': 3, 'b.ts': 1, 'c.ts': 1 }, { 'a.ts': 2, 'c.ts': 2, 'gone.ts': 4 })
    ).toEqual([
      { kind: 'grew', file: 'a.ts', count: 3, baseline: 2 },
      { kind: 'new', file: 'b.ts', count: 1 },
      { kind: 'stale', file: 'c.ts', count: 1, baseline: 2 },
      { kind: 'stale', file: 'gone.ts', baseline: 4 },
    ]);
  });
});

describe('the baseline only goes down', () => {
  it('refuses an entry raised or added by hand against the base', () => {
    expect(raisedAgainst({ 'a.ts': 3, 'b.ts': 1 }, { 'a.ts': 2 })).toEqual([
      { kind: 'raised', file: 'a.ts', count: 3, baseline: 2 },
      { kind: 'raised', file: 'b.ts', count: 1 },
    ]);
    expect(raisedAgainst({ 'a.ts': 1 }, { 'a.ts': 2, 'b.ts': 1 })).toEqual([]);
  });

  it('--update lowers and removes entries, and never raises or adds one', () => {
    expect(
      lowered({ 'a.ts': 1, 'b.ts': 5, 'new.ts': 2 }, { 'a.ts': 3, 'b.ts': 2, 'c.ts': 1 })
    ).toEqual({ 'a.ts': 1, 'b.ts': 2 });
  });
});

describe('the repo', () => {
  it(
    'adds no import of turn code beyond the baseline, and has locked in every drop',
    { timeout: SCAN_TIMEOUT_MS },
    () => {
      const baseline = (
        JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), 'utf8')) as {
          files: Record<string, number>;
        }
      ).files;
      expect(
        compare(measure(ROOT), baseline),
        'Start, watch and stop turns through services/runs. After removing imports, run `pnpm check:turn-port -- --update`.'
      ).toEqual([]);
    }
  );
});
