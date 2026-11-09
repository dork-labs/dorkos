/** The note stamp's record of a room turn that answered someone from outside (DOR-3440). */
import { describe, expect, it, vi } from 'vitest';
import { noteRoomTurnWords, roomTurnReadOutsideWords } from '../outside-words.js';
import { aliasTurnLevel, carryTurnLevel } from '../turn-levels.js';
import {
  onPermissionsChanged,
  recordPermissionChange,
} from '../../permissions/permission-history.js';

describe('a room turn’s words', () => {
  it('stamps while the latest turn answered an outsider, and clears on the next', () => {
    noteRoomTurnWords('seat', true);
    expect(roomTurnReadOutsideWords('seat')).toBe(true);
    noteRoomTurnWords('seat', false);
    expect(roomTurnReadOutsideWords('seat')).toBe(false);
  });

  // Security M1 on #3576: every rename the turn's level follows, its outside words follow too.
  it('goes with the session to a renamed id (the projector’s alias) and a moved seat', () => {
    noteRoomTurnWords('first-turn', true);
    aliasTurnLevel('first-turn', 'first-turn-canonical');
    expect(roomTurnReadOutsideWords('first-turn-canonical')).toBe(true);

    noteRoomTurnWords('old-seat', true);
    carryTurnLevel('old-seat', 'new-seat');
    expect(roomTurnReadOutsideWords('new-seat')).toBe(true);

    aliasTurnLevel('clean-turn', 'clean-turn-canonical');
    expect(roomTurnReadOutsideWords('clean-turn-canonical')).toBe(false);
  });
});

describe('a permission change', () => {
  it('tells what follows an agent’s level, with or without an Activity writer', async () => {
    const listener = vi.fn();
    onPermissionsChanged(listener);
    const record = { changes: [{}] } as unknown as Parameters<typeof recordPermissionChange>[1];
    await recordPermissionChange(undefined, record);
    expect(listener).toHaveBeenCalledTimes(1);
    await recordPermissionChange(undefined, { ...record, changes: [] });
    expect(listener).toHaveBeenCalledTimes(1);
    onPermissionsChanged(undefined);
  });
});
