/**
 * The computer wall (`eslint-rules/computer-wall.js`, spec `computer-side-starts-alone` §4):
 * computer-side code adds no import of space-side or front-door code and names no space table,
 * every file under services/ is on a side, and every table name in the side map is one
 * `@dorkos/db` exports. Linted with the package's real config, so a rule left unwired fails here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as db from '@dorkos/db';
import { is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: SERVER });

/** Linting the whole config takes a few seconds on a loaded machine. */
const LINT_TIMEOUT_MS = 30_000;

/** The wall's messages for `code` linted as if it were the file at `path`. */
async function wall(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${SERVER}${path}` });
  return result!.messages
    .filter((message) => message.ruleId === 'computer-wall/wall')
    .map((message) => message.message);
}

const read = <T>(path: string) => JSON.parse(readFileSync(`${SERVER}${path}`, 'utf8')) as T;
const BASELINE = read<{ files: Record<string, Record<string, number>> }>(
  'eslint-rules/computer-wall.baseline.json'
).files;
const SIDES = read<{ tables: { computer: string[]; space: string[] } }>('eslint-rules/sides.json');

describe('the computer wall', { timeout: LINT_TIMEOUT_MS }, () => {
  it('W2: refuses a value import, a type-only import and a declare module of space-side code', async () => {
    // Purpose: fails if any of the three statement kinds §8 W2 names could cross the wall unseen.
    const code = [
      "import { taskStore } from '../../tasks/task-store.js';",
      "import type { Capability } from '../../core/capabilities/index.js';",
      "declare module '../../rooms/room-types.js' { interface RoomExtra { seat: string } }",
      'export const use = () => taskStore as unknown as Capability;',
    ].join('\n');
    const messages = await wall('src/services/runtimes/codex/scratch-example.ts', code);
    expect(messages).toEqual([
      expect.stringMatching(
        /^'\.\.\/\.\.\/tasks\/task-store\.js' is space-side code \(services\/tasks\/task-store\)/u
      ),
      expect.stringMatching(
        /^'\.\.\/\.\.\/core\/capabilities\/index\.js' is space-side code \(services\/core\/capabilities\)/u
      ),
      expect.stringMatching(/^'\.\.\/\.\.\/rooms\/room-types\.js' is space-side code/u),
    ]);
    expect(messages[0]).toMatch(/This file has 3 such imports; its baseline allows 0\.$/u);
  });

  it('counts every other statement form and the front door, as the checker does', async () => {
    // Purpose: fails if the rule and `check:computer-wall` could count one file differently.
    const code = [
      "export { listTasks } from '../tasks/list.js';",
      "export * from '../mesh/index.js';",
      "type Plan = import('../core/turn-power/index.js').Plan;",
      "import power = require('../core/turn-power/index.js');",
      "export const later = () => import('../relay/index.js');",
      "import { verifyPerson } from '../core/auth/index.js';",
      'export type { Plan };',
      'void power; void verifyPerson;',
    ].join('\n');
    const messages = await wall('src/services/workspace/scratch-example.ts', code);
    expect(messages.filter((m) => m.includes('is space-side code'))).toHaveLength(5);
    expect(messages.filter((m) => m.includes('is front-door code'))).toEqual([
      expect.stringMatching(
        /\(services\/core\/auth\)\..* This file has 1 such imports; its baseline allows 0\.$/u
      ),
    ]);
  });

  it('lets computer code reach the computer side, the kernel, packages and code outside services', async () => {
    // Purpose: fails if the rule matched text instead of resolving paths, or the longest match lost:
    // `runtimes/codex/tasks/` is computer side, and `session/turn-port` is not `session/claims`.
    const code = [
      "import { a } from './tasks/plan.js';",
      "import { b } from '../../session/turn-port/index.js';",
      "import { c } from '../../core/config-manager.js';",
      "import { d } from '../../core/config/port.js';",
      "import { e } from '../../../lib/dork-home.js';",
      "import { sessionMetadata } from '@dorkos/db';",
      "import { z } from 'zod';",
    ].join('\n');
    expect(await wall('src/services/runtimes/codex/scratch-example.ts', code)).toEqual([]);
  });

  it('W4: refuses a space table named from @dorkos/db, aliased or re-exported', async () => {
    const code = [
      "import { chatMessages, sessionMetadata } from '@dorkos/db';",
      "import { agents as meshAgents } from '@dorkos/db';",
      "export { roomSessions } from '@dorkos/db';",
      'export const tables = [chatMessages, sessionMetadata, meshAgents];',
    ].join('\n');
    const messages = await wall('src/services/session/scratch-example.ts', code);
    expect(messages).toEqual([
      expect.stringMatching(/^'chatMessages' is a space table\./u),
      expect.stringMatching(/^'agents' is a space table\./u),
      expect.stringMatching(
        /^'roomSessions' is a space table\..* names 3 space tables; its baseline allows 0\.$/u
      ),
    ]);
  });

  it('holds only computer-side files: the space side, the kernel and tests are not counted', async () => {
    const reach = "import { chatMessages } from '@dorkos/db';\nimport '../tasks/x.js';";
    expect(await wall('src/services/session/chat-messages/scratch-example.ts', reach)).toEqual([]);
    expect(await wall('src/services/core/config/scratch-example.ts', reach)).toEqual([]);
    expect(await wall('src/services/session/__tests__/scratch-example.test.ts', reach)).toEqual([]);
  });

  it('W2: fails a file in a folder the side map does not place', async () => {
    // Purpose: fails if a new folder under services/ could land without picking a side.
    for (const path of [
      'src/services/brand-new-folder/scratch-example.ts',
      'src/services/core/brand-new-file.ts',
    ]) {
      expect(await wall(path, 'export {};')).toEqual([
        `${path} is in no folder of the side map. Add its folder to apps/server/eslint-rules/sides.json as computer, space, kernel or frontDoor (spec computer-side-starts-alone §1.1).`,
      ]);
    }
  });

  it('holds a baselined file to each column: one more fails, one fewer must be locked in', async () => {
    // Purpose: fails if a column could be grown past, or a drop left unlocked.
    const path = 'src/services/core/runtime-seam/session-birth-write.ts';
    const entry = BASELINE[path]!;
    const source = readFileSync(`${SERVER}${path}`, 'utf8');
    expect(await wall(path, source)).toEqual([]);
    const grown = `import { pulseRuns } from '@dorkos/db';\n${source}`;
    expect(await wall(path, grown)).toEqual(
      Array.from({ length: entry.tables! + 1 }, () =>
        expect.stringContaining(
          `This file names ${entry.tables! + 1} space tables; its baseline allows ${entry.tables}.`
        )
      )
    );
    expect(await wall(path, 'export {};')).toEqual(
      ['space', 'tables'].map(
        (column) =>
          `This file's ${column} count is 0 and its baseline allows ${entry[column]}. Lock the drop in: pnpm check:computer-wall -- --update.`
      )
    );
  });
});

describe('the side map’s tables', () => {
  it('puts every table @dorkos/db exports on exactly one list, and names nothing else', () => {
    // Purpose: fails if a new table lands without a side, or a listed name is not a table export.
    const exported = Object.entries(db)
      .filter(([, value]) => is(value, SQLiteTable))
      .map(([name]) => name)
      .sort();
    const listed = [...SIDES.tables.computer, ...SIDES.tables.space];
    expect(
      listed.filter((name, i) => listed.indexOf(name) !== i),
      'on two lists'
    ).toEqual([]);
    expect([...listed].sort()).toEqual(exported);
  });
});
