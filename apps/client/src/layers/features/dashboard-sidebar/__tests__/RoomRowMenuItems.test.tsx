// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import type { RoomKind } from '@dorkos/shared/room-schemas';
import { buildRoomRowMenuNodes, type RoomRowMenuModel } from '../ui/rooms/RoomRowMenuItems';

/** A model with every callback stubbed, so a test names only what it varies. */
function model(overrides: Partial<RoomRowMenuModel> = {}): RoomRowMenuModel {
  return {
    kind: 'channel' as RoomKind,
    hasUnread: false,
    soleAgentPath: null,
    onMarkRead: vi.fn(),
    onAddAgents: vi.fn(),
    onOpenMembers: vi.fn(),
    onOpenAgentProfile: vi.fn(),
    onRename: vi.fn(),
    onEditTopic: vi.fn(),
    onArchive: vi.fn(),
    ...overrides,
  };
}

/** Every node's id, separators included, in order. */
function ids(overrides: Partial<RoomRowMenuModel> = {}): string[] {
  return buildRoomRowMenuNodes(model(overrides)).map((node) => node.id);
}

describe('buildRoomRowMenuNodes', () => {
  it('offers a read channel exactly these items, in this order', () => {
    expect(ids()).toEqual([
      'add',
      'members',
      'sep-settings',
      'rename',
      'topic',
      'sep-archive',
      'archive',
    ]);
  });

  it('leads with Mark as read, and its separator, only when there is unread', () => {
    expect(ids({ hasUnread: true })).toEqual([
      'mark-read',
      'sep-unread',
      'add',
      'members',
      'sep-settings',
      'rename',
      'topic',
      'sep-archive',
      'archive',
    ]);
  });

  it('drops Edit topic from a direct message — only a channel is about a subject', () => {
    expect(ids({ kind: 'dm' })).toEqual([
      'add',
      'members',
      'sep-settings',
      'rename',
      'sep-archive',
      'archive',
    ]);
  });

  it('offers Agent profile on a one-to-one, where exactly one agent is named', () => {
    expect(ids({ kind: 'dm', soleAgentPath: '/repo/ana' })).toEqual([
      'add',
      'members',
      'agent-profile',
      'sep-settings',
      'rename',
      'sep-archive',
      'archive',
    ]);
  });

  it('withholds Agent profile from a group conversation, which names no single agent', () => {
    expect(ids({ kind: 'dm', soleAgentPath: null })).not.toContain('agent-profile');
  });

  it('names the room in the archive label so the item reads out of context', () => {
    const channel = buildRoomRowMenuNodes(model()).find((n) => n.id === 'archive');
    const dm = buildRoomRowMenuNodes(model({ kind: 'dm' })).find((n) => n.id === 'archive');
    expect(channel).toMatchObject({ label: 'Archive channel', destructive: true });
    expect(dm).toMatchObject({ label: 'Archive conversation', destructive: true });
  });

  it('marks exactly the items that need more input, and only those', () => {
    const opening = buildRoomRowMenuNodes(model({ hasUnread: true, soleAgentPath: '/repo/ana' }))
      .filter((node) => node.kind === 'action' && node.opensInput)
      .map((node) => node.id);
    // Archive is absent on purpose: a confirmation alert asks whether you meant
    // it, it does not ask for input, so it earns no ellipsis.
    expect(opening).toEqual(['add', 'members', 'rename', 'topic']);
  });

  it('carries no trailing ellipsis in a label — that is the renderer’s to add', () => {
    const labels = buildRoomRowMenuNodes(model({ hasUnread: true }))
      .filter((node) => node.kind === 'action')
      .map((node) => node.label);
    expect(labels.some((label) => label.endsWith('…'))).toBe(false);
    expect(labels).toEqual([
      'Mark as read',
      'Add agents',
      'Members',
      'Rename',
      'Edit topic',
      'Archive channel',
    ]);
  });

  it('marks only Archive destructive', () => {
    const destructive = buildRoomRowMenuNodes(model({ hasUnread: true, soleAgentPath: '/repo/x' }))
      .filter((node) => node.kind === 'action' && node.destructive)
      .map((node) => node.id);
    expect(destructive).toEqual(['archive']);
  });

  it('hands Agent profile the agent path rather than making the caller find it', () => {
    const onOpenAgentProfile = vi.fn();
    const nodes = buildRoomRowMenuNodes(
      model({ kind: 'dm', soleAgentPath: '/repo/ana', onOpenAgentProfile })
    );
    const profile = nodes.find((node) => node.id === 'agent-profile');
    if (profile?.kind !== 'action') throw new Error('expected an action node');
    profile.run();
    expect(onOpenAgentProfile).toHaveBeenCalledWith('/repo/ana');
  });

  it('carries no Mute and no Move to group — both wait for the unified reference (DOR-581)', () => {
    // The rule this pins is the one that matters: nothing here may invent a
    // second, room-only mute concept before agents and rooms share one.
    const all = ids({ hasUnread: true, kind: 'dm', soleAgentPath: '/repo/ana' });
    expect(all).not.toContain('mute');
    expect(all).not.toContain('move-to-group');
  });
});
