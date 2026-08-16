// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { Bell, BellOff } from 'lucide-react';
import type { RoomKind } from '@dorkos/shared/room-schemas';
import { buildRoomRowMenuNodes, type RoomRowMenuModel } from '../ui/rooms/RoomRowMenuItems';

/** A model with every callback stubbed, so a test names only what it varies. */
function model(overrides: Partial<RoomRowMenuModel> = {}): RoomRowMenuModel {
  return {
    kind: 'channel' as RoomKind,
    hasUnread: false,
    isMuted: false,
    currentGroupId: null,
    groups: [],
    soleAgentPath: null,
    canLeave: true,
    onMarkRead: vi.fn(),
    onToggleMute: vi.fn(),
    onMoveToGroup: vi.fn(),
    onNewGroup: vi.fn(),
    onAddAgents: vi.fn(),
    onOpenMembers: vi.fn(),
    onOpenAgentProfile: vi.fn(),
    onRename: vi.fn(),
    onEditTopic: vi.fn(),
    onLeave: vi.fn(),
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
      'mute',
      'move-to-group',
      'sep-organize',
      'add',
      'members',
      'sep-settings',
      'rename',
      'topic',
      'sep-destructive',
      'leave',
      'archive',
    ]);
  });

  it('leads with Mark as read, and its separator, only when there is unread', () => {
    expect(ids({ hasUnread: true })).toEqual([
      'mark-read',
      'sep-unread',
      'mute',
      'move-to-group',
      'sep-organize',
      'add',
      'members',
      'sep-settings',
      'rename',
      'topic',
      'sep-destructive',
      'leave',
      'archive',
    ]);
  });

  it('drops Edit topic from a direct message — only a channel is about a subject', () => {
    expect(ids({ kind: 'dm' })).toEqual([
      'mute',
      'move-to-group',
      'sep-organize',
      'add',
      'members',
      'sep-settings',
      'rename',
      'sep-destructive',
      'leave',
      'archive',
    ]);
  });

  it('offers Agent profile on a one-to-one, where exactly one agent is named', () => {
    expect(ids({ kind: 'dm', soleAgentPath: '/repo/ana' })).toEqual([
      'mute',
      'move-to-group',
      'sep-organize',
      'add',
      'members',
      'agent-profile',
      'sep-settings',
      'rename',
      'sep-destructive',
      'leave',
      'archive',
    ]);
  });

  it('withholds Leave while this viewer’s own author id is not known yet', () => {
    // The gap is a beat on a cold sidebar (the team roster still loading),
    // never a standing state — see `RoomRowMenuModel.canLeave`.
    expect(ids({ canLeave: false })).not.toContain('leave');
  });

  it('names the room in the leave label, same as archive, so it reads out of context', () => {
    const channel = buildRoomRowMenuNodes(model()).find((n) => n.id === 'leave');
    const dm = buildRoomRowMenuNodes(model({ kind: 'dm' })).find((n) => n.id === 'leave');
    expect(channel).toMatchObject({ label: 'Leave channel', destructive: true, opensInput: false });
    expect(dm).toMatchObject({ label: 'Leave conversation', destructive: true, opensInput: false });
  });

  it('runs the leave callback the caller supplied', () => {
    const onLeave = vi.fn();
    const leave = buildRoomRowMenuNodes(model({ onLeave })).find((n) => n.id === 'leave');
    if (leave?.kind !== 'action') throw new Error('expected an action node');
    leave.run();
    expect(onLeave).toHaveBeenCalledTimes(1);
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
    // Leave and Archive are both absent on purpose: a confirmation alert asks
    // whether you meant it, it does not ask for input, so neither earns an
    // ellipsis.
    expect(opening).toEqual(['add', 'members', 'rename', 'topic']);
  });

  it('carries no trailing ellipsis in a label — that is the renderer’s to add', () => {
    const labels = buildRoomRowMenuNodes(model({ hasUnread: true }))
      .filter((node) => node.kind === 'action')
      .map((node) => node.label);
    expect(labels.some((label) => label.endsWith('…'))).toBe(false);
    expect(labels).toEqual([
      'Mark as read',
      'Mute channel',
      'Add agents',
      'Members',
      'Rename',
      'Edit topic',
      'Leave channel',
      'Archive channel',
    ]);
  });

  it('marks Leave and Archive destructive, and nothing else', () => {
    const destructive = buildRoomRowMenuNodes(model({ hasUnread: true, soleAgentPath: '/repo/x' }))
      .filter((node) => node.kind === 'action' && node.destructive)
      .map((node) => node.id);
    expect(destructive).toEqual(['leave', 'archive']);
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

  // -------------------------------------------------------------------------
  // Mute + Move to group (rooms-in-groups, DOR-581)
  // -------------------------------------------------------------------------

  /** The submenu's contents, which is where every group target lives. */
  function moveItems(overrides: Partial<RoomRowMenuModel> = {}) {
    const sub = buildRoomRowMenuNodes(model(overrides)).find((n) => n.id === 'move-to-group');
    if (sub?.kind !== 'submenu') throw new Error('expected a submenu node');
    return sub.items;
  }

  it('names mute after the room it acts on, and flips both word and icon when muted', () => {
    const muteOf = (overrides: Partial<RoomRowMenuModel>) =>
      buildRoomRowMenuNodes(model(overrides)).find((n) => n.id === 'mute');

    expect(muteOf({})).toMatchObject({ label: 'Mute channel', icon: BellOff });
    expect(muteOf({ isMuted: true })).toMatchObject({ label: 'Unmute channel', icon: Bell });
    expect(muteOf({ kind: 'dm' })).toMatchObject({ label: 'Mute conversation' });
    expect(muteOf({ kind: 'dm', isMuted: true })).toMatchObject({ label: 'Unmute conversation' });
  });

  it('runs the mute toggle the caller supplied, rather than deciding the direction itself', () => {
    const onToggleMute = vi.fn();
    const mute = buildRoomRowMenuNodes(model({ isMuted: true, onToggleMute })).find(
      (n) => n.id === 'mute'
    );
    if (mute?.kind !== 'action') throw new Error('expected an action node');
    mute.run();
    expect(onToggleMute).toHaveBeenCalledTimes(1);
  });

  it('lists every group in the submenu and ticks the one the room is already in', () => {
    const items = moveItems({
      groups: [
        { id: 'g1', name: 'Clients' },
        { id: 'g2', name: 'Infra' },
      ],
      currentGroupId: 'g2',
    });
    expect(items.filter((n) => n.kind === 'choice')).toEqual([
      expect.objectContaining({ id: 'group-g1', label: 'Clients', checked: false }),
      expect.objectContaining({ id: 'group-g2', label: 'Infra', checked: true }),
    ]);
  });

  it('moves the room by group id, and out of every group with null', () => {
    const onMoveToGroup = vi.fn();
    const items = moveItems({
      groups: [{ id: 'g1', name: 'Clients' }],
      currentGroupId: 'g1',
      onMoveToGroup,
    });

    const target = items.find((n) => n.id === 'group-g1');
    if (target?.kind !== 'choice') throw new Error('expected a choice node');
    target.run();
    expect(onMoveToGroup).toHaveBeenCalledWith('g1');

    const remove = items.find((n) => n.id === 'remove-from-group');
    if (remove?.kind !== 'action') throw new Error('expected an action node');
    remove.run();
    expect(onMoveToGroup).toHaveBeenLastCalledWith(null);
  });

  it('withholds Remove from group from a room that is in none — there is nothing to leave', () => {
    expect(moveItems({ currentGroupId: null }).map((n) => n.id)).not.toContain('remove-from-group');
  });

  it('offers New group even with no groups yet, so the submenu is never a dead end', () => {
    const items = moveItems({ groups: [] });
    const newGroup = items.find((n) => n.id === 'new-group');
    // `opensInput` is what earns it the renderer's ellipsis — it mounts the
    // inline name editor rather than creating a group on the spot.
    expect(newGroup).toMatchObject({ label: 'New group', opensInput: true });
  });

  it('starts the group-create flow from the row, without naming a group first', () => {
    const onNewGroup = vi.fn();
    const newGroup = moveItems({ onNewGroup }).find((n) => n.id === 'new-group');
    if (newGroup?.kind !== 'action') throw new Error('expected an action node');
    newGroup.run();
    expect(onNewGroup).toHaveBeenCalledTimes(1);
  });

  it('offers only the groups it was given — a smart group is never a move target', () => {
    // The builder is pure, so what it must guarantee is that it invents no
    // target of its own: the caller filters smart groups out, because a room
    // filed into one is counted as grouped and drawn by nobody, and vanishes.
    // `RoomRow` is where that filter lives and where its own test pins it.
    expect(moveItems({ groups: [] }).filter((n) => n.kind === 'choice')).toEqual([]);
  });
});
