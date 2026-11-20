/**
 * `chat_read` of a chat that held words from outside the team marks the reader's turn (DOR-3969,
 * spec §4.7, Security's Addition A): what that chat says may quote them. A chat that only ever held
 * the team's own words leaves the reader clean, and so does a status-only read.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { CapabilityDeps } from '../../../core/capabilities/index.js';
import type { AgentIdentity } from '../../../core/agent-identity/agent-identity-service.js';
import {
  markRunningTurnOutsider,
  marksOf,
  recordTurnLevels,
} from '../../../core/turn-power/turn-levels.js';
import { marksHold } from '../../../core/turn-power/turn-marks.js';
import { setContinuationHoldDb } from '../../../core/turn-power/continuation-hold.js';
import { resetChosenTurns } from '../../../core/turn-power/full-autonomy.js';
import { resetLiveOutsiderTurns } from '../../../core/turn-power/live-outsider-turns.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { chatDomain } from '../chat-capabilities.js';
import { ChatMessageStore } from '../chat-message-store.js';
import type { ChatReadDeps } from '../chat-read.js';

const ANA = {
  agentPath: '/agents/ana',
  displayName: 'Ana',
  createdAt: '2026-11-17T12:00:00.000Z',
} as AgentIdentity;

let counter = 0;
const fresh = () => `chat-read-marks-${(counter += 1)}`;

/** Run one turn in a chat set to Full autonomy, so its level is recorded. */
async function ranAtFull(sessionId: string) {
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
  for await (const _event of runtime.sendMessage(sessionId, 'hi')) {
    // drain
  }
}

describe('chat_read marks the reader when the chat it read held outside words', () => {
  let deps: CapabilityDeps;

  beforeEach(() => {
    resetChosenTurns();
    resetLiveOutsiderTurns();
    const db = createTestDb();
    setContinuationHoldDb(db);
    const read: ChatReadDeps = {
      store: new ChatMessageStore(db),
      mayRead: async () => true,
      maySeeTitle: async () => true,
      history: async () => [],
      status: () => null,
      describe: async () => ({ title: 'Garden plan', agent: 'Bo' }),
      search: async () => [],
    };
    deps = {
      logger: noopLogger,
      chatMessageDeps: { service: { send: async () => ({}), stopChat: async () => ({}) }, read },
    } as unknown as CapabilityDeps;
  });

  afterEach(() => {
    setContinuationHoldDb(undefined);
    resetChosenTurns();
    resetLiveOutsiderTurns();
  });

  const chatRead = chatDomain.capabilities.find((capability) => capability.id === 'chat.read')!;

  /** Ana reads `target` from her own chat; whether her turn is then held. */
  async function readFrom(reader: string, target: string, include?: 'status') {
    await chatRead.invoke(
      deps,
      { chat: target, last: 5, ...(include ? { include } : {}) } as never,
      { identity: ANA, sessionId: reader }
    );
    return marksHold(marksOf(reader, ANA.agentPath));
  }

  it('marks the reader when the chat read a page in its running turn', async () => {
    const [reader, target] = [fresh(), fresh()];
    await ranAtFull(reader);
    await ranAtFull(target);
    markRunningTurnOutsider(target, '/agents/bo');
    expect(await readFrom(reader, target)).toBe(true);
  });

  it('still marks the reader after that chat moved on to a clean turn', async () => {
    const [reader, target] = [fresh(), fresh()];
    await ranAtFull(reader);
    await ranAtFull(target);
    markRunningTurnOutsider(target, '/agents/bo');
    await ranAtFull(target);
    expect(await readFrom(reader, target)).toBe(true);
  });

  it("leaves the reader clean when the chat only held the team's own words", async () => {
    const [reader, target] = [fresh(), fresh()];
    await ranAtFull(reader);
    await ranAtFull(target);
    expect(await readFrom(reader, target)).toBe(false);
  });

  it('leaves the reader clean on a status-only read', async () => {
    const [reader, target] = [fresh(), fresh()];
    await ranAtFull(reader);
    await ranAtFull(target);
    markRunningTurnOutsider(target, '/agents/bo');
    expect(await readFrom(reader, target, 'status')).toBe(false);
  });
});
