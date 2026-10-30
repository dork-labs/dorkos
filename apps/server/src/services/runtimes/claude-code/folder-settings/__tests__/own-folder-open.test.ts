/**
 * An agent's own folder setup opens only for the level a PERSON set, on an
 * unmarked turn that runs at Full (DOR-3483).
 *
 * @vitest-environment node
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
const level = vi.hoisted(() => ({ mode: 'bypassPermissions' as string | undefined, fail: false }));
vi.mock('../../../../session/resolution/agent-launch-level.js', () => ({
  resolveAgentLaunchLevel: async () => {
    if (level.fail) throw new Error('unreadable');
    return { stop: null, mode: level.mode };
  },
}));
const marks = vi.hoisted(() => ({ marked: false }));
vi.mock('../agent-extensions-deny.js', () => ({
  ownExtensionsWritable: (_session: unknown, _id: string, home: string) =>
    marks.marked ? undefined : home,
}));

import {
  appendOwnFolderBlock,
  OWN_FOLDER_BLOCK,
  resolveOwnFolderOpen,
  type OwnFolderTurn,
} from '../own-folder-open.js';

const turn = (over: Partial<OwnFolderTurn> = {}): OwnFolderTurn => ({
  home: '/agents/media',
  teammate: false,
  turnMode: 'bypassPermissions',
  session: {},
  sessionId: 'chat-1',
  capabilities: undefined,
  ...over,
});

beforeEach(() => {
  level.mode = 'bypassPermissions';
  level.fail = false;
  marks.marked = false;
});

describe('resolveOwnFolderOpen', () => {
  it('opens for an agent a person set to Full, on an unmarked Full turn', async () => {
    expect(await resolveOwnFolderOpen(turn())).toBe(true);
  });

  it('stays closed when the person set the agent below Full, whatever the session mode', async () => {
    level.mode = 'acceptEdits';
    expect(await resolveOwnFolderOpen(turn())).toBe(false);
  });

  it('stays closed when the turn runs below Full', async () => {
    expect(await resolveOwnFolderOpen(turn({ turnMode: 'acceptEdits' }))).toBe(false);
  });

  it('stays closed on a turn that read outside words', async () => {
    marks.marked = true;
    expect(await resolveOwnFolderOpen(turn())).toBe(false);
  });

  it("stays closed on a teammate's turn and with no agent home", async () => {
    expect(await resolveOwnFolderOpen(turn({ teammate: true }))).toBe(false);
    expect(await resolveOwnFolderOpen(turn({ home: undefined }))).toBe(false);
  });

  it('stays closed when the level cannot be read', async () => {
    level.fail = true;
    expect(await resolveOwnFolderOpen(turn())).toBe(false);
  });
});

describe('appendOwnFolderBlock', () => {
  it('tells the agent what it may edit and that the rest is guarded against file tools only', () => {
    const options: Options = {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: 'base' },
    };
    appendOwnFolderBlock(options);
    appendOwnFolderBlock(options);
    const append = (options.systemPrompt as { append: string }).append;
    expect(append).toBe(`base\n\n${OWN_FOLDER_BLOCK}`);
    expect(OWN_FOLDER_BLOCK).toContain('.claude/');
    expect(OWN_FOLDER_BLOCK).toContain('.mcp.json');
    expect(OWN_FOLDER_BLOCK).toContain('.dork/agent.json');
    expect(OWN_FOLDER_BLOCK).toContain('guarded against file tools only');
  });
});
