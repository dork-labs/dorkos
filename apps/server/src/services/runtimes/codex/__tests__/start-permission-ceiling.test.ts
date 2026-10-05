/**
 * DOR-2714's start ceiling against Codex's app-server modes (DOR-2719 review
 * item 9): which Codex level a Claude Code chat at each of its own levels may
 * start, compared by declared asking and reach (`isNoLooserThan`), never by id.
 *
 * The app-server modes all reach the workspace, and every Claude level below
 * Full access reaches only what it edits, so those chats cannot start a Codex
 * chat on app-server at all. That is fail-closed and deliberate (NOTES.md): on
 * exec, a Claude chat in Default could start Codex in Read only.
 */
import { describe, expect, it } from 'vitest';
import { isNoLooserThan } from '@dorkos/shared/permission-semantics';
import { CLAUDE_CODE_CAPABILITIES } from '../../claude-code/runtime-constants.js';
import { CODEX_APP_SERVER_PERMISSION_MODES, CODEX_CAPABILITIES } from '../runtime-constants.js';

const startable = (
  ceiling: (typeof CLAUDE_CODE_CAPABILITIES.permissionModes.values)[number],
  target: typeof CODEX_APP_SERVER_PERMISSION_MODES
) => target.values.filter((mode) => isNoLooserThan(ceiling, mode)).map((mode) => mode.id);

describe('a Claude Code chat starting a Codex chat (DOR-2714 ceiling)', () => {
  const claude = CLAUDE_CODE_CAPABILITIES.permissionModes.values;

  it('on app-server: only Full access may start one, and never above itself', () => {
    expect(
      Object.fromEntries(
        claude.map((mode) => [mode.id, startable(mode, CODEX_APP_SERVER_PERMISSION_MODES)])
      )
    ).toEqual({
      default: [],
      acceptEdits: [],
      plan: [],
      bypassPermissions: ['default', 'acceptEdits', 'bypassPermissions'],
      auto: [],
    });
  });

  it('no Codex level it may start asks less or reaches further than the starter', () => {
    const asks = { always: 2, 'when-risky': 1, never: 0 } as const;
    const reach = { read: 0, edit: 1, workspace: 2, everything: 3 } as const;
    for (const ceiling of claude) {
      for (const id of startable(ceiling, CODEX_APP_SERVER_PERMISSION_MODES)) {
        const mode = CODEX_APP_SERVER_PERMISSION_MODES.values.find((m) => m.id === id)!;
        expect(reach[mode.reach]).toBeLessThanOrEqual(reach[ceiling.reach]);
        expect(asks[mode.asks]).toBeGreaterThanOrEqual(asks[ceiling.asks]);
      }
    }
  });

  it('on exec (unchanged): Default and Plan may still start Codex in Read only', () => {
    const exec = CODEX_CAPABILITIES.permissionModes;
    expect(
      startable(
        claude.find((m) => m.id === 'default')!,
        exec
      )
    ).toEqual(['default']);
    expect(
      startable(
        claude.find((m) => m.id === 'plan')!,
        exec
      )
    ).toEqual(['default']);
  });
});
