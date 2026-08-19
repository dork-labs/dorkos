/**
 * The two small derivations every zone shares: the unread tier and mute (§18,
 * BC-40).
 *
 * @module features/dashboard-sidebar/model/__tests__/derive-rules
 */
import { describe, expect, it } from 'vitest';
import type { SidebarRowModel } from '../build-sidebar-model';
import { prefs } from '../fixtures';
import { applyMuteRules, isMuted, muteIndex } from '../rules/apply-mute-rules';
import { deriveUnreadSignal } from '../rules/derive-unread-signal';
import { basename, interactionKeyOf, rowKey } from '../rules/targets';

/** A bare row pointing at one target. */
function row(target: SidebarRowModel['target'], overrides: Partial<SidebarRowModel> = {}) {
  return {
    key: rowKey(target),
    target,
    glyph: { kind: 'hash' },
    primary: 'row',
    reservesVerbLine: false,
    unread: { tier: 'none' },
    muted: false,
    draggable: false,
    reason: 'today:interaction-recency',
    ...overrides,
  } as SidebarRowModel;
}

describe('deriveUnreadSignal', () => {
  it('makes a busy channel bold and nothing more', () => {
    expect(deriveUnreadSignal({ unreadCount: 400, directed: false, muted: false })).toEqual({
      tier: 'activity',
    });
  });

  it('gives an unread DM a number', () => {
    expect(deriveUnreadSignal({ unreadCount: 3, directed: true, muted: false })).toEqual({
      tier: 'directed',
      count: 3,
    });
  });

  it('gives an @mention a number in any room', () => {
    expect(
      deriveUnreadSignal({ unreadCount: 20, directed: false, mentionCount: 2, muted: false })
    ).toEqual({ tier: 'directed', count: 2 });
  });

  it('says nothing when there is nothing', () => {
    expect(deriveUnreadSignal({ unreadCount: 0, directed: true, muted: false })).toEqual({
      tier: 'none',
    });
  });

  it('treats a non-member’s null count as nothing', () => {
    expect(deriveUnreadSignal({ unreadCount: null, directed: false, muted: false })).toEqual({
      tier: 'none',
    });
  });

  it('mute kills bold and badge', () => {
    expect(deriveUnreadSignal({ unreadCount: 9, directed: true, muted: true })).toEqual({
      tier: 'none',
    });
  });

  it('an @mention pierces mute', () => {
    expect(
      deriveUnreadSignal({ unreadCount: 9, directed: false, mentionCount: 1, muted: true })
    ).toEqual({ tier: 'directed', count: 1 });
  });

  it('rounds a DM toward what the reader will find when they open it', () => {
    expect(
      deriveUnreadSignal({ unreadCount: 2, directed: true, mentionCount: 5, muted: false })
    ).toEqual({ tier: 'directed', count: 5 });
  });
});

describe('mute resolution', () => {
  const state = prefs({
    muted: [{ kind: 'room', roomId: 'noisy' }],
    groups: [
      {
        id: 'g1',
        name: 'Quiet ones',
        kind: 'manual',
        items: [{ kind: 'agent', path: '/a/one' }],
        collapsed: false,
        sortMode: 'manual',
        displayFilter: 'all',
        muted: true,
      },
      {
        id: 'g2',
        name: 'Smart',
        kind: 'smart',
        items: [{ kind: 'agent', path: '/a/two' }],
        collapsed: false,
        sortMode: 'name',
        displayFilter: 'all',
        muted: true,
        rules: { runtimes: ['codex'] },
      },
    ],
  });

  it('reads both the individual list and a muted group’s membership', () => {
    const index = muteIndex(state);
    expect(index.rooms.has('noisy')).toBe(true);
    expect(index.agents.has('/a/one')).toBe(true);
  });

  it('ignores a smart group’s stored items', () => {
    expect(muteIndex(state).agents.has('/a/two')).toBe(false);
  });

  it('a session inherits its agent’s mute', () => {
    const index = muteIndex(state);
    expect(
      isMuted(row({ kind: 'session', sessionId: 's', agentPath: '/a/one', cwd: '/a/one' }), index)
    ).toBe(true);
  });

  it('drops muted rows where mute means ineligible', () => {
    const rows = [
      row({ kind: 'room', roomId: 'noisy', roomKind: 'channel' }),
      row({ kind: 'room', roomId: 'calm', roomKind: 'channel' }),
    ];
    expect(
      applyMuteRules(rows, muteIndex(state), { dropMuted: true }).map((entry) => entry.key)
    ).toEqual(['room:calm']);
  });

  it('keeps and marks them where it does not', () => {
    const rows = [row({ kind: 'room', roomId: 'noisy', roomKind: 'channel' })];
    const kept = applyMuteRules(rows, muteIndex(state), { dropMuted: false });
    expect(kept).toHaveLength(1);
    expect(kept[0]?.muted).toBe(true);
  });

  it('exempts the row the operator is standing in', () => {
    const rows = [row({ kind: 'room', roomId: 'noisy', roomKind: 'channel' })];
    expect(
      applyMuteRules(rows, muteIndex(state), { dropMuted: true, exemptKey: 'room:noisy' })
    ).toHaveLength(1);
  });
});

describe('target vocabulary', () => {
  it('keys every arm of the union', () => {
    expect(rowKey({ kind: 'session', sessionId: 's1', agentPath: '/a', cwd: null })).toBe(
      'session:s1'
    );
    expect(rowKey({ kind: 'room', roomId: 'r1', roomKind: 'dm' })).toBe('room:r1');
    expect(rowKey({ kind: 'agent', path: '/a' })).toBe('agent:/a');
    expect(rowKey({ kind: 'attention', signalId: 'x', deepLink: '/' })).toBe('attention:x');
    expect(rowKey({ kind: 'rollup', rollup: 'working' })).toBe('rollup:working');
    expect(rowKey({ kind: 'suggestion', suggestionId: 'suggestion:ask-dorkbot' })).toBe(
      'suggestion:ask-dorkbot'
    );
    expect(rowKey({ kind: 'digest' })).toBe('digest:today');
    expect(rowKey({ kind: 'command', commandId: 'new-session' })).toBe('command:new-session');
  });

  it('gives a thread its room’s interaction key', () => {
    expect(interactionKeyOf({ kind: 'room', roomId: 'r1', roomKind: 'thread' })).toBe('room:r1');
  });

  it('gives a rollup no interaction key at all', () => {
    expect(interactionKeyOf({ kind: 'rollup', rollup: 'automated' })).toBeNull();
  });

  it('reads a basename on either separator', () => {
    expect(basename('/repos/dorkos')).toBe('dorkos');
    expect(basename('C:\\code\\dorkos')).toBe('dorkos');
    expect(basename('/repos/dorkos//')).toBe('dorkos');
    expect(basename('dorkos')).toBe('dorkos');
  });
});
