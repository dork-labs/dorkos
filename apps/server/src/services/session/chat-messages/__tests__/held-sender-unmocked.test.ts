/**
 * A held sender's row is stored as held with nothing mocked (DOR-3816). The chat-message store is
 * imported first on purpose: through the hand-off outbox it once reached `turn-levels` in a loop,
 * and a loop can leave an import unset while modules load. If that ever reached the held-sender
 * path, a held row would be stored as not held, which fails open. No `vi.mock` here, so the real
 * `marksOf` is the one every reader sees.
 */
import { ChatMessageStore } from '../chat-message-store.js';
import { describe, expect, it } from 'vitest';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { marksOf, recordTurnLevels } from '../../../core/turn-power/turn-levels.js';
import { parseCarriedHold, rowsCarryHold, senderCeilingJson } from '../chat-message-ceiling.js';

/** Record one real turn for a chat through the production level recorder. */
async function recordTurn(sessionId: string, outsider: boolean) {
  const fake = new FakeAgentRuntime('claude-code');
  fake.getCapabilities.mockReturnValue(CLAUDE_CODE_CAPABILITIES);
  const runtime = recordTurnLevels(fake, () => 'bypassPermissions');
  const opts = outsider
    ? { permissionCeiling: { asks: 'always', reach: 'edit', outsider: true } as const }
    : undefined;
  for await (const _ of runtime.sendMessage(sessionId, 'fixture', opts)) {
    /* a local fake turn */
  }
}

/** Store a row the way `chat_send` does: the bound comes from the sending chat's real marks. */
function storeRowFrom(store: ChatMessageStore, sessionId: string, id: string) {
  const ceilingJson = senderCeilingJson(
    { turnLevelOf: () => ({ asks: 'never', reach: 'everything' }) },
    { sessionId, agentPath: '/agents/ana' }
  );
  store.insert({
    id,
    toSessionId: 'chat-b',
    fromSessionId: sessionId,
    fromAgentPath: '/agents/ana',
    fromAgentId: 'agent-ana',
    fromAgentName: 'Ana',
    fromChatTitle: 'Planning',
    kind: 'message',
    text: 'Made-up words',
    summary: null,
    nonce: 'a0a0a0a0',
    delivery: 'queue',
    status: 'working',
    queueMessageId: `q-${id}`,
    ceilingJson,
    replyToId: null,
  });
  return store.listByQueueMessage(`q-${id}`);
}

describe('a held sender’s row, nothing mocked', () => {
  it('stores a really held turn’s row as held, and a clean turn’s row as not held', async () => {
    const store = new ChatMessageStore(createTestDb());
    await recordTurn('held-chat', true);
    await recordTurn('clean-chat', false);
    expect(marksOf('held-chat', undefined).outsider).toBe(true);
    expect(marksOf('clean-chat', undefined).outsider).not.toBe(true);

    const held = storeRowFrom(store, 'held-chat', 'm-held');
    expect(held).toHaveLength(1);
    expect(parseCarriedHold(held[0]!.ceilingJson)).toBe(true);
    expect(rowsCarryHold(held)).toBe(true);

    const clean = storeRowFrom(store, 'clean-chat', 'm-clean');
    expect(rowsCarryHold(clean)).toBe(false);
  });
});
