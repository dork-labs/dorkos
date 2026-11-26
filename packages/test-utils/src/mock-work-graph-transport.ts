/**
 * The work graph's reads on a mock `Transport` (W4, DOR-4970): every chat is a
 * tree of one, and nobody has done any work. Spread into `createMockTransport`.
 *
 * @module test-utils/mock-work-graph-transport
 */
import { vi } from 'vitest';
import type { WorkGraphTransport } from '@dorkos/shared/transport-work-graph';

/** A work graph with no chats below any chat and no work. */
export function createMockWorkGraphTransport(): WorkGraphTransport {
  return {
    getChatTree: vi.fn(async (chatId: string) => ({
      chatId,
      state: { kind: 'chat' as const },
      ancestors: [],
      descendants: [],
      truncated: false,
      nextCursor: null,
    })),
    getAgentWork: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getChatWork: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
  };
}
