/** The note stamp's record of a room turn that answered someone from outside (DOR-3440). */
import { describe, expect, it, vi } from 'vitest';
import { noteRoomTurnWords, roomTurnReadOutsideWords } from '../outside-words.js';
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
