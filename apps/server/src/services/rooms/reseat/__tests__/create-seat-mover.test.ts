/**
 * The production seat mover writes the link a moved seat's reports follow (DOR-3720): the real
 * factory and the real ledger, in the test runtime's world of accounts, with only the runtime's own
 * reads standing in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { RoomSessionLedger } from '../../session-bindings/room-session-ledger.js';
import { createRoomSeatMover } from '../create-seat-mover.js';
import { setTestAccountWorld } from '../test-account-world.js';

vi.mock('../../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    has: () => false,
    getSessionSettings: async () => null,
    saveSessionSettings: async () => {},
  },
}));

vi.mock('../../../runtimes/shared/resolve-agent-runtime-type.js', () => ({
  resolveTurnRuntimeType: async () => 'claude-code',
}));

vi.mock('../../../session/resolution/resolve-session-defaults.js', () => ({
  readAgentExecutionDefaults: async () => ({}),
  resolveUnattendedPermissionMode: () => undefined,
}));

vi.mock('../../../session/fleet/carry-over-summary.js', () => ({
  claudeTranscriptPath: () => '/nowhere',
  gatherCarryOverSummary: async () => 'SUMMARY',
  runGitForSummary: async () => '',
}));

const SEAT = { roomId: 'room-1', authorId: 'ana', agentPath: '/agents/ana', sessionId: 'old-seat' };
const OPTS = { alreadyPosted: false, hideAccounts: false };

describe('createRoomSeatMover (DOR-3720)', () => {
  let ledger: RoomSessionLedger;

  /** The production mover, over a store that takes or refuses the move. */
  const moverWhere = (moved: boolean) =>
    createRoomSeatMover({
      store: { rebindRoomSession: () => moved, sessionLedger: ledger },
      transcripts: undefined,
      activity: () => undefined,
    });

  beforeEach(() => {
    ledger = new RoomSessionLedger(createTestDb());
    setTestAccountWorld(
      { accounts: [{ id: 'spent', limited: true }, { id: 'fresh' }], startAccount: 'spent' },
      true
    );
  });

  afterEach(() => setTestAccountWorld(null, true));

  it('writes the seat the old session held, once the room has moved it', async () => {
    const move = await moverWhere(true).afterLimit(SEAT, 'entry-1', OPTS);

    expect(move).not.toBeNull();
    expect(ledger.seatMovedFrom('old-seat')).toMatchObject({ roomId: 'room-1', authorId: 'ana' });
  });

  it('writes nothing when the room refuses the move', async () => {
    await moverWhere(false)
      .afterLimit(SEAT, 'entry-1', OPTS)
      .catch(() => undefined);

    expect(ledger.seatMovedFrom('old-seat')).toBeUndefined();
  });
});
