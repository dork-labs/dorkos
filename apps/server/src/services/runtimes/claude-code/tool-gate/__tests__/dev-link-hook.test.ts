/**
 * A held turn's file-tool write into a dev-linked folder is refused (DOR-4896). A dev link runs
 * whatever its folder holds with no click (DOR-2696), so an edit there is new code that would run
 * on a person's earlier yes. A turn that read words from someone other than the owner, or runs
 * under a limit, may not make it; every other turn, and every other folder, is untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CARRIED_OUTSIDER_LEVEL } from '@dorkos/shared/permission-semantics';
import { DEV_LINKS_FILE } from '@dorkos/shared/marketplace-schemas';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtime-constants.js';
import { recordTurnLevels } from '../../../../core/turn-power/turn-levels.js';
import { resetLiveOutsiderTurns } from '../../../../core/turn-power/live-outsider-turns.js';
import { noteRoomTurnWords } from '../../../../core/turn-power/outside-words.js';
import { writeDenyRules } from '../../messaging/directory-grants.js';
import { applyLaunchDevLinkDeny, devLinkFolderNames } from '../../folder-settings/dev-link-deny.js';
import { createDevLinkHook } from '../dev-link-hook.js';

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
function answer(hook: ReturnType<typeof createDevLinkHook>, tool: string, file: string) {
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

describe('dev-linked folder refusal', () => {
  let root: string;
  let dorkHome: string;
  let home: string;
  let work: string;
  let slot: string;
  const folders = () => devLinkFolderNames(dorkHome);

  /** Write the registry with one link per `[slot, target]` pair. */
  async function recordLinks(pairs: Array<[string, string]>) {
    await fs.mkdir(path.dirname(path.join(dorkHome, DEV_LINKS_FILE)), { recursive: true });
    await fs.writeFile(
      path.join(dorkHome, DEV_LINKS_FILE),
      JSON.stringify({
        version: 1,
        links: pairs.map(([linkSlot, target], index) => ({
          name: `sample-plugin${index === 0 ? '' : `-${index}`}`,
          type: 'plugin',
          scope: 'global',
          slot: linkSlot,
          target,
          linkedAt: '2026-11-21T00:00:00.000Z',
          linkedVia: 'app',
        })),
      })
    );
  }

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dev-link-hook-')));
    dorkHome = path.join(root, 'dork');
    home = path.join(root, 'ana');
    work = path.join(root, 'work', 'sample-plugin');
    slot = path.join(dorkHome, 'plugins', 'sample-plugin');
    await fs.mkdir(path.join(work, '.dork', 'extensions', 'desk'), { recursive: true });
    await fs.mkdir(path.dirname(slot), { recursive: true });
    await fs.mkdir(home, { recursive: true });
    await fs.symlink(work, slot);
    await recordLinks([[slot, work]]);
  });
  afterEach(async () => {
    resetLiveOutsiderTurns();
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('refuses a marked turn’s write into the linked folder, naming why', async () => {
    await ran('dev-link-1', { permissionCeiling: CARRIED_OUTSIDER_LEVEL });
    const hook = createDevLinkHook(
      {},
      { sessionId: 'dev-link-1', cwd: home, agentHome: home, devLinkFolders: folders }
    );
    const reason = reasonOf(
      await answer(hook, 'Write', path.join(work, '.dork', 'extensions', 'desk', 'server.ts'))
    );
    expect(reason).toBe(
      `${work} is linked for development, so it’s read-only in this turn. ` +
        'This turn read words from outside your team, or runs under a limit. ' +
        'Tell your owner the change instead. Don’t ask anyone to copy files in.'
    );
  });

  it('refuses a ceilinged turn’s write through the slot link, and a relative path', async () => {
    const hook = createDevLinkHook(CEILING as never, {
      sessionId: 'dev-link-2',
      cwd: work,
      agentHome: home,
      devLinkFolders: folders,
    });
    expect(reasonOf(await answer(hook, 'Edit', path.join(slot, 'index.ts')))).toBeDefined();
    expect(reasonOf(await answer(hook, 'MultiEdit', 'hooks/new.sh'))).toBeDefined();
  });

  it('refuses a turn that only carries the outside-words note (a relay of outside words)', async () => {
    noteRoomTurnWords('dev-link-note', true);
    const hook = createDevLinkHook(
      {},
      { sessionId: 'dev-link-note', cwd: home, agentHome: home, devLinkFolders: folders }
    );
    expect(reasonOf(await answer(hook, 'Write', path.join(work, 'index.ts')))).toContain(
      'linked for development'
    );
  });

  it('refuses once a mark lands after launch, and once a link is made after launch', async () => {
    const hook = createDevLinkHook(
      {},
      { sessionId: 'dev-link-late', cwd: home, agentHome: home, devLinkFolders: folders }
    );
    expect(await answer(hook, 'Write', path.join(work, 'index.ts'))).toEqual({});
    await ran('dev-link-late', { permissionCeiling: CARRIED_OUTSIDER_LEVEL });
    expect(reasonOf(await answer(hook, 'Write', path.join(work, 'index.ts')))).toBeDefined();

    const later = path.join(root, 'work', 'later-plugin');
    await fs.mkdir(later, { recursive: true });
    expect(await answer(hook, 'Write', path.join(later, 'index.ts'))).toEqual({});
    await recordLinks([
      [slot, work],
      [path.join(dorkHome, 'plugins', 'later-plugin'), later],
    ]);
    expect(reasonOf(await answer(hook, 'Write', path.join(later, 'index.ts')))).toBeDefined();
  });

  it('refuses a write through another link to the folder, and a path under ~', async () => {
    const alias = path.join(root, 'alias');
    await fs.symlink(work, alias);
    vi.stubEnv('HOME', root);
    const hook = createDevLinkHook(CEILING as never, {
      sessionId: 'dev-link-alias',
      cwd: home,
      agentHome: home,
      devLinkFolders: folders,
    });
    expect(reasonOf(await answer(hook, 'Write', path.join(alias, 'new', 'x.ts')))).toBeDefined();
    expect(reasonOf(await answer(hook, 'Write', '~/work/sample-plugin/x.ts'))).toBeDefined();
  });

  it('answers nothing for an unheld turn, a file elsewhere, or a read', async () => {
    const open = createDevLinkHook(
      {},
      { sessionId: 'dev-link-3', cwd: home, agentHome: home, devLinkFolders: folders }
    );
    expect(await answer(open, 'Write', path.join(work, 'index.ts'))).toEqual({});

    const held = createDevLinkHook(CEILING as never, {
      sessionId: 'dev-link-4',
      cwd: home,
      agentHome: home,
      devLinkFolders: folders,
    });
    expect(await answer(held, 'Write', path.join(home, 'notes.md'))).toEqual({});
    expect(await answer(held, 'Read', path.join(work, 'index.ts'))).toEqual({});
  });

  it('adds deny rules for the linked folder to a held launch only', async () => {
    const heldOptions: Options = {};
    await applyLaunchDevLinkDeny(heldOptions, {
      session: CEILING as never,
      sessionId: 'dev-link-5',
      agentHome: home,
      dorkHome,
    });
    const deny = (heldOptions.settings as { permissions?: { deny?: string[] } }).permissions?.deny;
    expect(deny).toEqual(
      expect.arrayContaining([
        ...writeDenyRules(work, 'folder')!,
        ...writeDenyRules(slot, 'folder')!,
      ])
    );

    const openOptions: Options = {};
    await applyLaunchDevLinkDeny(openOptions, {
      session: {},
      sessionId: 'dev-link-6',
      agentHome: home,
      dorkHome,
    });
    expect(openOptions.settings).toBeUndefined();
  });
});
