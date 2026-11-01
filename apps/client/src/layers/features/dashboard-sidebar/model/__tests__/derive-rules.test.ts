/**
 * The two small derivations every section shares: the unread tier and mute
 * (§18, BC-40).
 *
 * @module features/dashboard-sidebar/model/__tests__/derive-rules
 */
import { describe, expect, it } from 'vitest';
import { prefs } from '../fixtures';
import { muteIndex } from '../rules/apply-mute-rules';
import { deriveUnreadSignal } from '@/layers/shared/lib/unread-signal';
import { rowKey, sameTarget } from '../rules/targets';

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
});

describe('target vocabulary', () => {
  it('keys every arm of the union', () => {
    expect(rowKey({ kind: 'session', sessionId: 's1', agentPath: '/a', cwd: null })).toBe(
      'session:s1'
    );
    expect(rowKey({ kind: 'room', roomId: 'r1', roomKind: 'dm' })).toBe('room:r1');
    expect(rowKey({ kind: 'agent', path: '/a' })).toBe('agent:/a');
    expect(rowKey({ kind: 'command', commandId: 'open-threads' })).toBe('command:open-threads');
    expect(rowKey({ kind: 'add-on', extensionId: 'crm', path: '' })).toBe('add-on:crm:');
  });

  it('treats two targets as one place only when their keys agree', () => {
    const room = { kind: 'room', roomId: 'r1', roomKind: 'channel' } as const;
    expect(sameTarget(room, { ...room, roomKind: 'dm' })).toBe(true);
    expect(sameTarget(room, { kind: 'room', roomId: 'r2', roomKind: 'channel' })).toBe(false);
    expect(sameTarget(room, null)).toBe(false);
  });
});
