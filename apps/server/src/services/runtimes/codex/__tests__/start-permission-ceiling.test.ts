/**
 * DOR-2714's start ceiling against Codex's app-server modes (DOR-2719 review
 * item 9): which Codex level a Claude Code chat at each of its own levels may
 * start, compared by declared asking and reach (`isNoLooserThan`), never by id.
 *
 * Codex's Ask first is declared exactly as Claude Code's Default (asks always,
 * reaches what it edits): both ask before any change, and an approved step
 * can go further. So a chat in Default, Accept edits or Auto may start a Codex
 * chat in Ask first, and only Full access may start Workspace write or Full
 * access. Plan reaches only what it reads, so it starts none of them on
 * app-server. Nothing ever climbs above its starter.
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
  const claudeMode = (id: string) => claude.find((mode) => mode.id === id)!;

  it('Ask first is declared exactly as Claude Code’s Default', () => {
    const ask = CODEX_APP_SERVER_PERMISSION_MODES.values.find((mode) => mode.id === 'default')!;
    const claudeDefault = claudeMode('default');
    expect({ asks: ask.asks, reach: ask.reach }).toEqual({
      asks: claudeDefault.asks,
      reach: claudeDefault.reach,
    });
  });

  it('on app-server: Default may start Ask first, only Full access may start the rest', () => {
    expect(
      Object.fromEntries(
        claude.map((mode) => [mode.id, startable(mode, CODEX_APP_SERVER_PERMISSION_MODES)])
      )
    ).toEqual({
      default: ['default'],
      acceptEdits: ['default'],
      plan: [],
      bypassPermissions: ['default', 'acceptEdits', 'bypassPermissions'],
      auto: ['default'],
    });
  });

  it('Default is still refused Workspace write and Full access (no climb)', () => {
    const fromDefault = startable(claudeMode('default'), CODEX_APP_SERVER_PERMISSION_MODES);
    expect(fromDefault).not.toContain('acceptEdits');
    expect(fromDefault).not.toContain('bypassPermissions');
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
    expect(startable(claudeMode('default'), exec)).toEqual(['default']);
    expect(startable(claudeMode('plan'), exec)).toEqual(['default']);
  });
});
