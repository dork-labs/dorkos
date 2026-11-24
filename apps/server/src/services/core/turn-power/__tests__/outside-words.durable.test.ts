/**
 * The outside-words note is saved with the chat (DOR-4148): a spin-off a stranger's words reached
 * stays noted after a restart, a clean turn clears it for good, a seat moved after a restart keeps
 * it, and a saved note that cannot be read counts as noted. "A restart" here is what one leaves:
 * the same database rows, nothing in this process's memory.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  noteRoomTurnWords,
  roomTurnReadOutsideWords,
  setOutsideWordsDb,
} from '../outside-words.js';
import { chatReadOutsideWords } from '../chat-outside-words.js';
import { aliasTurnLevel, carryTurnLevel } from '../turn-levels.js';
import { runtimeRegistry } from '../../runtime-registry.js';
import { holdBlocksSteer } from '../../../session/chat-messages/chat-message-ceiling.js';
import { persistSdkSessionRebind } from '../../../runtimes/claude-code/sessions/identity/sdk-session-rebind.js';
import { discardUnstartedSession } from '../../../runtimes/claude-code/mcp-tools/session-start-setup.js';

/** The table the note is saved in, as its migration creates it. */
const CREATE_TABLE =
  'CREATE TABLE `session_outside_words` ' +
  '(`session_id` text PRIMARY KEY NOT NULL, `noted_at` text NOT NULL)';

afterEach(() => {
  setOutsideWordsDb(undefined);
  vi.restoreAllMocks();
});

/** A clean launch origin, so only the saved note can say a chat read outside words. */
function interactiveOrigins(): void {
  vi.spyOn(runtimeRegistry, 'getSessionLaunchOrigin').mockReturnValue('interactive');
}

describe('the outside-words note across a restart', () => {
  it('keeps a spin-off a stranger’s words reached noted after a restart', () => {
    interactiveOrigins();
    const db = createTestDb();
    setOutsideWordsDb(db);
    // `session_start` notes the new chat, and its canonical id, before its first turn runs.
    noteRoomTurnWords('spin-off', true);
    noteRoomTurnWords('spin-off-canonical', true);

    setOutsideWordsDb(db);

    expect(roomTurnReadOutsideWords('spin-off')).toBe(true);
    expect(roomTurnReadOutsideWords('spin-off-canonical')).toBe(true);
    // What memory, the browser, spending and a seat's carry read.
    expect(chatReadOutsideWords('spin-off-canonical')).toBe(true);
    expect(chatReadOutsideWords('never-noted')).toBe(false);
  });

  it('clears for good when the chat’s next turn is clean', () => {
    const db = createTestDb();
    setOutsideWordsDb(db);
    noteRoomTurnWords('seat', true);
    noteRoomTurnWords('seat', false);

    setOutsideWordsDb(db);

    expect(roomTurnReadOutsideWords('seat')).toBe(false);
  });

  it('goes with a seat moved, or a chat renamed, after a restart', () => {
    const db = createTestDb();
    setOutsideWordsDb(db);
    noteRoomTurnWords('old-seat', true);
    noteRoomTurnWords('first-id', true);

    setOutsideWordsDb(db);
    carryTurnLevel('old-seat', 'new-seat');
    aliasTurnLevel('first-id', 'canonical-id');

    setOutsideWordsDb(db);
    expect(roomTurnReadOutsideWords('new-seat')).toBe(true);
    expect(roomTurnReadOutsideWords('canonical-id')).toBe(true);
  });

  it('reads clean after a restart once a clean turn followed the noted one', () => {
    const db = createTestDb();
    setOutsideWordsDb(db);
    noteRoomTurnWords('survivor', true);
    setOutsideWordsDb(db);
    expect(roomTurnReadOutsideWords('survivor')).toBe(true);
    noteRoomTurnWords('survivor', false);

    setOutsideWordsDb(db);

    expect(roomTurnReadOutsideWords('survivor')).toBe(false);
  });

  it('tries the save again on the next note when the first one failed', () => {
    const db = createTestDb();
    setOutsideWordsDb(db);
    db.$client.exec('DROP TABLE session_outside_words');
    noteRoomTurnWords('retried', true);
    // Still noted in this process, though nothing was saved.
    expect(roomTurnReadOutsideWords('retried')).toBe(true);
    db.$client.exec(CREATE_TABLE);
    noteRoomTurnWords('retried', true);

    setOutsideWordsDb(db);

    expect(roomTurnReadOutsideWords('retried')).toBe(true);
  });

  it('keeps a noted sender out of a running turn whose own note cannot be read', () => {
    interactiveOrigins();
    const db = createTestDb();
    setOutsideWordsDb(db);
    noteRoomTurnWords('noted-sender', true);
    noteRoomTurnWords('clean-target', false);
    expect(holdBlocksSteer('noted-sender', 'clean-target')).toBe(true);

    setOutsideWordsDb(db);
    noteRoomTurnWords('noted-sender', true);
    db.$client.exec('DROP TABLE session_outside_words');

    expect(holdBlocksSteer('noted-sender', 'unreadable-target')).toBe(true);
  });

  it('goes with a chat whose runtime id rotates after a restart', async () => {
    const db = createTestDb();
    setOutsideWordsDb(db);
    noteRoomTurnWords('sdk-before', true);

    setOutsideWordsDb(db);
    await persistSdkSessionRebind(undefined, 'sdk-before', 'sdk-after');

    setOutsideWordsDb(db);
    expect(roomTurnReadOutsideWords('sdk-after')).toBe(true);
  });

  it('drops the note of a started chat whose launch never ran', async () => {
    vi.spyOn(runtimeRegistry, 'discardSessionSettings').mockResolvedValue();
    const db = createTestDb();
    setOutsideWordsDb(db);
    noteRoomTurnWords('never-started', true);
    await discardUnstartedSession('never-started');

    setOutsideWordsDb(db);
    expect(roomTurnReadOutsideWords('never-started')).toBe(false);
  });

  it('counts a saved note that cannot be read as noted', () => {
    const db = createTestDb();
    setOutsideWordsDb(db);
    db.$client.exec('DROP TABLE session_outside_words');

    expect(roomTurnReadOutsideWords('unreadable')).toBe(true);
    expect(chatReadOutsideWords('unreadable')).toBe(true);
  });

  it('counts a launch origin that cannot be read as outside words, once the store is wired', () => {
    vi.spyOn(runtimeRegistry, 'getSessionLaunchOrigin').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    expect(chatReadOutsideWords('early-boot')).toBe(false);

    setOutsideWordsDb(createTestDb());
    expect(chatReadOutsideWords('unreadable-origin')).toBe(true);
  });

  it('keeps the in-memory note with no database, as before', () => {
    noteRoomTurnWords('memory-only', true);
    expect(roomTurnReadOutsideWords('memory-only')).toBe(true);
    expect(roomTurnReadOutsideWords('unknown')).toBe(false);
  });
});
