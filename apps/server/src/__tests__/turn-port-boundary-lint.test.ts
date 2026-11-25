/**
 * The turn port's ratchet (`eslint-rules/turn-port-boundary.js`, spec
 * `turns-survive-restarts` §3.4): a space-side domain reaches turn code only
 * through the turn port, the run record only through the computer face's
 * barrel, and turn code never reaches the run record. Linted with the
 * package's real config, so a rule left unwired fails here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: SERVER });

/** Linting the whole config takes a few seconds on a loaded machine. */
const LINT_TIMEOUT_MS = 30_000;

/** The ratchet's messages for `code` linted as if it were the file at `path`. */
async function boundary(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${SERVER}${path}` });
  return result!.messages
    .filter((message) => message.ruleId === 'turn-port/boundary')
    .map((message) => message.message);
}

/** The baseline's entries. */
const BASELINE = (
  JSON.parse(readFileSync(`${SERVER}eslint-rules/turn-port-boundary.baseline.json`, 'utf8')) as {
    files: Record<string, number>;
  }
).files;

describe('the turn port ratchet', { timeout: LINT_TIMEOUT_MS }, () => {
  it('refuses a scratch space-side import of turn code, by every import form, type-only included', async () => {
    // Purpose: fails if a space-side domain could reach turn code by a side-effect, named,
    // type-only, re-export or dynamic import.
    const code = [
      "import '../session/message-dispatcher.js';",
      "import { dispatchMessage } from '../session/message-dispatcher.js';",
      "import type { DispatchPlan } from '../session/message-dispatcher/types.js';",
      "export { getMessageQueueStore } from '../session/message-queue-store.js';",
      "export const later = () => import('../runtimes/claude-code/index.js');",
      'export type { DispatchPlan };',
      'void dispatchMessage;',
    ].join('\n');
    const messages = await boundary('src/services/rooms/scratch-example.ts', code);
    expect(messages).toHaveLength(5);
    expect(messages[0]).toMatch(
      /is turn code\. .* This file has 5 such imports; its baseline allows 0\./u
    );
  });

  it('counts the type-query and require forms too, as the baseline script does', async () => {
    // Purpose: fails if the rule and `check:turn-port` could count one file differently.
    const code = [
      "type Plan = import('../session/message-dispatcher/types.js').DispatchPlan;",
      "import queue = require('../session/message-queue-store.js');",
      'export type { Plan };',
      'void queue;',
    ].join('\n');
    expect(await boundary('src/services/rooms/scratch-example.ts', code)).toHaveLength(2);
  });

  it('lets a space-side domain reach the turn port, chat messages and its own folders', async () => {
    // Purpose: fails if the rule matched text instead of resolving paths: `tasks/session/` and
    // `session/chat-messages/` are not turn code.
    expect(
      await boundary(
        'src/services/extensions/scratch-example.ts',
        [
          "import { turnPort } from '../runs/index.js';",
          "import { defuseMarkers } from '../session/chat-messages/chat-message-fence.js';",
        ].join('\n')
      )
    ).toEqual([]);
    expect(
      await boundary(
        'src/services/tasks/scratch-example.ts',
        "import { x } from './session/run-session.js';"
      )
    ).toEqual([]);
  });

  it('holds services/runs to the computer face’s barrel', async () => {
    expect(
      await boundary(
        'src/services/runs/scratch-example.ts',
        "import { chatKeyOf } from '../session/turn-port/index.js';"
      )
    ).toEqual([]);
    expect(
      await boundary(
        'src/services/runs/effects/scratch-example.ts',
        "import type { DispatchPlan } from '../../session/message-dispatcher/types.js';"
      )
    ).toEqual([expect.stringMatching(/only through services\/session\/turn-port\/index\.js/u)]);
  });

  it('refuses turn code that imports the run record', async () => {
    expect(
      await boundary('src/services/session/scratch-example.ts', "import '../runs/index.js';")
    ).toEqual([expect.stringMatching(/is the run record/u)]);
    expect(
      await boundary(
        'src/services/runtimes/claude-code/scratch-example.ts',
        "import type { TurnRun } from '../../runs/run-store.js';"
      )
    ).toEqual([expect.stringMatching(/is the run record/u)]);
  });

  it('holds a baselined file to its entry: one more import fails, one fewer must be locked in', async () => {
    // Purpose: fails if the baseline could be grown past, or a drop left unlocked.
    const path = 'src/services/extensions/start-work.ts';
    const allowed = BASELINE[path]!;
    const source = readFileSync(`${SERVER}${path}`, 'utf8');
    expect(await boundary(path, source)).toEqual([]);
    const grown = `import '../session/message-dispatcher.js';\n${source}`;
    expect(await boundary(path, grown)).toEqual(
      Array.from({ length: allowed + 1 }, () =>
        expect.stringContaining(
          `This file has ${allowed + 1} such imports; its baseline allows ${allowed}.`
        )
      )
    );
    expect(await boundary(path, 'export {};')).toEqual([
      `This file has 0 imports of turn code and its baseline allows ${allowed}. Lock the drop in: pnpm check:turn-port -- --update.`,
    ]);
  });

  it('never checks tests', async () => {
    expect(
      await boundary(
        'src/services/rooms/__tests__/scratch-example.test.ts',
        "import { dispatchMessage } from '../../session/message-dispatcher.js';"
      )
    ).toEqual([]);
  });
});
