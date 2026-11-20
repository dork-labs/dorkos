/**
 * A held turn's write into its agent's own mini apps folder is refused with the rule and the
 * personal-marketplace route named, and nothing else is touched (DOR-4851).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';
import { recordTurnLevels } from '../../../../core/turn-power/turn-levels.js';
import { resetLiveOutsiderTurns } from '../../../../core/turn-power/live-outsider-turns.js';
import { createOwnExtensionsHook, ownExtensionsMatcher } from '../own-extensions-hook.js';

const signal = { signal: new AbortController().signal };
const CEILING = { turnPermissionCeiling: { asks: 'always', reach: 'edit' } } as const;

/** Run one turn in `sessionId`, carrying `opts`, so its marks are recorded. */
async function ran(sessionId: string, opts?: MessageOpts) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

/** What the hook answers for one call. */
function answer(hook: ReturnType<typeof createOwnExtensionsHook>, tool: string, file: string) {
  return hook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: { file_path: file, content: 'x' },
      tool_use_id: 't1',
    } as never,
    't1',
    signal
  );
}

/** The refusal's reason, or undefined when the hook answered nothing. */
function reasonOf(result: unknown): string | undefined {
  return (result as { hookSpecificOutput?: { permissionDecisionReason?: string } })
    .hookSpecificOutput?.permissionDecisionReason;
}

describe('own mini apps folder refusal', () => {
  let root: string;
  let home: string;
  let app: string;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'own-ext-hook-')));
    home = path.join(root, 'ana');
    app = path.join(home, '.dork', 'extensions', 'desk');
    await fs.mkdir(app, { recursive: true });
  });
  afterEach(async () => {
    resetLiveOutsiderTurns();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses a ceilinged turn’s write there, naming the rule and the personal-marketplace route', async () => {
    const hook = createOwnExtensionsHook(CEILING as never, {
      sessionId: 'own-ext-1',
      cwd: home,
      agentHome: home,
    });
    const reason = reasonOf(await answer(hook, 'Write', path.join(app, 'server.ts')));
    expect(reason).toContain('read-only in this turn');
    expect(reason).toContain(path.join(home, '.dork', 'extensions'));
    expect(reason).toContain('someone other than your owner');
    expect(reason).toContain('marketplace_create_package');
    expect(reason).toContain('marketplace_update');
    expect(reason).toContain('Terminal');
  });

  it('refuses a marked turn’s write there, a relative path and a file not yet made included', async () => {
    await ran('own-ext-2', { permissionCeiling: 'runtime-default' });
    const hook = createOwnExtensionsHook(
      {},
      { sessionId: 'own-ext-2', cwd: home, agentHome: home }
    );
    expect(reasonOf(await answer(hook, 'Edit', '.dork/extensions/desk/new/index.ts'))).toContain(
      'personal marketplace'
    );
  });

  it('refuses a write through a link to the folder', async () => {
    const link = path.join(root, 'link');
    await fs.symlink(app, link);
    const hook = createOwnExtensionsHook(CEILING as never, {
      sessionId: 'own-ext-3',
      cwd: root,
      agentHome: home,
    });
    expect(reasonOf(await answer(hook, 'Write', path.join(link, 'index.ts')))).toBeDefined();
  });

  it('answers nothing for an unheld turn, a file elsewhere, or another tool', async () => {
    const open = createOwnExtensionsHook(
      {},
      { sessionId: 'own-ext-4', cwd: home, agentHome: home }
    );
    expect(await answer(open, 'Write', path.join(app, 'index.ts'))).toEqual({});

    const held = createOwnExtensionsHook(CEILING as never, {
      sessionId: 'own-ext-5',
      cwd: home,
      agentHome: home,
    });
    expect(await answer(held, 'Write', path.join(home, 'notes.md'))).toEqual({});
    expect(await answer(held, 'Write', path.join(home, '.dork', 'extensions-old', 'a.ts'))).toEqual(
      {}
    );
    expect(await answer(held, 'Read', path.join(app, 'index.ts'))).toEqual({});
  });

  it('a turn that runs as no agent gets nothing from it', async () => {
    const hook = createOwnExtensionsHook(CEILING as never, {
      sessionId: 'own-ext-6',
      cwd: home,
      agentHome: undefined,
    });
    expect(await answer(hook, 'Write', path.join(app, 'index.ts'))).toEqual({});
  });

  it('matches the file tools by an anchored pattern', () => {
    const matcher = ownExtensionsMatcher({}, { sessionId: 's', cwd: home, agentHome: home });
    const pattern = new RegExp(matcher.matcher!);
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
      expect(pattern.test(tool)).toBe(true);
    expect(pattern.test('Bash')).toBe(false);
    expect(pattern.test('mcp__dorkos__Write')).toBe(false);
  });
});
