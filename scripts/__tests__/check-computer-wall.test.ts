/**
 * The computer wall's baseline (`scripts/computer-wall/check-computer-wall.ts`,
 * spec `computer-side-starts-alone` §4): it measures what the lint rule
 * counts, its numbers may only fall, and the side map places each path once.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readSides } from '../../apps/server/eslint-rules/computer-wall.js';
import {
  BASELINE_PATH,
  checkSides,
  compare,
  countFile,
  lowered,
  measure,
  raisedAgainst,
  type Counts,
} from '../computer-wall/check-computer-wall.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVICES = join(ROOT, 'apps/server/src/services');

/** Time allowed for the case that reads every file under services/ (DOR-2021). */
const SCAN_TIMEOUT_MS = 30_000;

const n = (space: number, frontDoor = 0, tables = 0): Counts => ({ space, frontDoor, tables });

describe('countFile', () => {
  it('W2 and W4: counts a value import, a type-only import, a declare module and a space table', () => {
    const text = [
      "import { taskStore } from '../../tasks/task-store.js';",
      "import type { Capability } from '../../core/capabilities/index.js';",
      "declare module '../../rooms/room-types.js' { interface RoomExtra { seat: string } }",
      "import { chatMessages, sessionMetadata } from '@dorkos/db';",
    ].join('\n');
    expect(countFile(join(SERVICES, 'runtimes/codex/example.ts'), text)).toEqual(n(3, 0, 1));
  });

  it('counts every other form and the front door, the same set the rule counts', () => {
    const text = [
      "export { listTasks } from '../tasks/list.js';",
      "export * from '../mesh/index.js';",
      "type Plan = import('../core/turn-power/index.js').Plan;",
      "import power = require('../core/turn-power/index.js');",
      "export const later = () => import('../relay/index.js');",
      "import { verifyPerson } from '../core/auth/index.js';",
      "import { agents as meshAgents } from '@dorkos/db';",
      "export { roomSessions } from '@dorkos/db';",
    ].join('\n');
    expect(countFile(join(SERVICES, 'workspace/example.ts'), text)).toEqual(n(5, 1, 2));
  });

  it('never counts the computer side, the kernel, packages, code outside services, or a space-side file', () => {
    const text = [
      "import { a } from './tasks/plan.js';",
      "import { b } from '../../session/turn-port/index.js';",
      "import { c } from '../../core/config-manager.js';",
      "import { e } from '../../../lib/dork-home.js';",
      "import { sessionMetadata } from '@dorkos/db';",
      "const r = require('../../tasks/task-store.js');",
    ].join('\n');
    expect(countFile(join(SERVICES, 'runtimes/codex/example.ts'), text)).toEqual(n(0));
    const reach = "import { chatMessages } from '@dorkos/db';\nimport '../tasks/x.js';";
    expect(countFile(join(SERVICES, 'session/claims/example.ts'), reach)).toEqual(n(0));
  });
});

describe('compare', () => {
  it('reports growth, a new file, a drop not locked in and a file gone, column by column', () => {
    expect(
      compare(
        { 'a.ts': n(3, 1), 'b.ts': n(0, 0, 1), 'c.ts': n(1, 2) },
        { 'a.ts': n(2, 1), 'c.ts': n(2, 2), 'gone.ts': n(4) }
      )
    ).toEqual([
      { kind: 'grew', file: 'a.ts', column: 'space', count: 3, baseline: 2 },
      { kind: 'new', file: 'b.ts', column: 'tables', count: 1 },
      { kind: 'stale', file: 'c.ts', column: 'space', count: 1, baseline: 2 },
      { kind: 'stale', file: 'gone.ts', baseline: 4 },
    ]);
  });
});

describe('W1: the baseline only goes down', () => {
  it('refuses a column raised or a file added by hand against the base', () => {
    expect(raisedAgainst({ 'a.ts': n(2, 3), 'b.ts': n(1) }, { 'a.ts': n(2, 2) })).toEqual([
      { kind: 'raised', file: 'a.ts', column: 'frontDoor', count: 3, baseline: 2 },
      { kind: 'raised', file: 'b.ts', count: 1 },
    ]);
    expect(raisedAgainst({ 'a.ts': n(1) }, { 'a.ts': n(2, 1), 'b.ts': n(1) })).toEqual([]);
  });

  it('--update lowers and removes entries, and never raises or adds one', () => {
    expect(
      lowered(
        { 'a.ts': n(1, 0, 2), 'b.ts': n(5, 5, 5), 'new.ts': n(2) },
        { 'a.ts': n(3, 1, 2), 'b.ts': n(2, 0, 1), 'c.ts': n(1), 'd.ts': n(1) }
      )
    ).toEqual({ 'a.ts': n(1, 0, 2), 'b.ts': n(2, 0, 1) });
    expect(lowered({ 'a.ts': n(0, 0, 0) }, { 'a.ts': n(1) })).toEqual({});
  });
});

describe('checkSides', () => {
  it('refuses a path on two sides, a path that does not exist, and a table on both lists', () => {
    const sides = {
      sides: {
        computer: ['runtimes', 'core/no-such-folder'],
        space: ['runtimes', 'core/mcp-server.ts', 'core/agent-home.ts'],
        kernel: [],
        frontDoor: [],
      },
      tables: { computer: ['workspaces'], space: ['agents', 'workspaces'] },
    };
    expect(checkSides(ROOT, sides)).toEqual([
      { kind: 'sides', file: 'core/no-such-folder', detail: 'no such folder' },
      { kind: 'sides', file: 'runtimes', detail: 'on computer and space' },
      { kind: 'sides', file: 'core/agent-home.ts', detail: 'no such file' },
      { kind: 'sides', file: 'workspaces', detail: 'on the computer and space tables' },
    ]);
  });
});

describe('the repo', () => {
  it(
    'places every file, adds nothing beyond the baseline, and has locked in every drop',
    { timeout: SCAN_TIMEOUT_MS },
    () => {
      const baseline = (
        JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), 'utf8')) as {
          files: Record<string, Counts>;
        }
      ).files;
      const { counts, unplaced } = measure(ROOT);
      expect(checkSides(ROOT, readSides()), 'the side map').toEqual([]);
      expect(unplaced, 'files the side map does not place').toEqual([]);
      expect(
        compare(counts, baseline),
        'Reach the space side through a port. After removing imports, run `pnpm check:computer-wall -- --update`.'
      ).toEqual([]);
    }
  );
});
