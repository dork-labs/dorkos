/**
 * A post written from a chat that read outside words is stored with the outsider mark inside the
 * insert's own transaction (DOR-4593), the way a post's own marks are (DOR-3107). Before, the mark
 * was written after the insert, so a crash between the two left the row unmarked and the turn it
 * woke after a restart ran unmarked.
 *
 * The crash is stood in for by a marks store whose write fails: whatever the row holds then is
 * only what the insert's transaction wrote.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { RoomWithRoster } from '@dorkos/shared/room-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { recordTurnLevels, setEntryMarksStore } from '../../core/turn-power/turn-levels.js';
import { resetChosenTurns } from '../../core/turn-power/full-autonomy.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { createEntryMarksStore } from '../limits/entry-marks-store.js';
import { agentLookupFor, createRoomHarness, type RoomHarness } from './room-test-harness.js';

let counter = 0;
const fresh = (label: string) => `relay-tx-${label}-${(counter += 1)}`;

/** Record one turn sent under `sessionId`, as the runtime registry's wrapper does. */
async function ran(sessionId: string, opts?: MessageOpts) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

describe("a relaying chat's post is marked within the insert's transaction", () => {
  let harness: RoomHarness;
  let channel: RoomWithRoster;
  let bo: string;
  const outsideChats = new Set<string>();

  beforeEach(() => {
    resetChosenTurns();
    outsideChats.clear();
    // A chat an outside agent started: every turn of it is a stranger's.
    vi.spyOn(runtimeRegistry, 'getSessionLaunchOrigin').mockImplementation((id) =>
      outsideChats.has(id) ? 'outside-sender' : 'interactive'
    );
    harness = createRoomHarness({
      agents: agentLookupFor({
        '/agents/bo': { name: 'bo', displayName: 'Bo', responseMode: 'mention-only' },
      }),
    });
    channel = harness.service.createRoom(
      { kind: 'channel', title: 'Team', members: [], agentPaths: ['/agents/bo'] },
      harness.human
    );
    bo = harness.authors.resolveAgent('/agents/bo', 'Bo').id;
    // The write after the insert fails, as a crash right after the commit would leave it.
    setEntryMarksStore({
      write: () => {
        throw new Error('crashed after the insert');
      },
      read: () => null,
    });
  });

  afterEach(() => {
    setEntryMarksStore(null);
    resetChosenTurns();
    vi.restoreAllMocks();
  });

  /** What the post's row holds, read as a restarted server reads it. */
  function rowMarks(entryId: string) {
    return createEntryMarksStore(harness.db).read(channel.id, entryId);
  }

  it('a post whose level is not known', () => {
    const relay = fresh('unknown');
    outsideChats.add(relay);
    const entry = harness.service.postFromTool(channel.id, {
      authorId: bo,
      text: 'passing it on',
      callerSessionId: relay,
    });
    expect(rowMarks(entry.id)?.outsider).toBe(true);
  });

  it('a post whose level is known', async () => {
    const relay = fresh('known');
    outsideChats.add(relay);
    await ran(relay);
    const entry = harness.service.postFromTool(channel.id, {
      authorId: bo,
      text: 'passing it on',
      callerSessionId: relay,
    });
    expect(rowMarks(entry.id)?.outsider).toBe(true);
  });

  it("a clean chat's post is not marked", async () => {
    const clean = fresh('clean');
    await ran(clean);
    const entry = harness.service.postFromTool(channel.id, {
      authorId: bo,
      text: 'all good',
      callerSessionId: clean,
    });
    expect(rowMarks(entry.id)?.outsider).not.toBe(true);
  });
});
