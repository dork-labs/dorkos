/**
 * Transport mocks for the Direct chat calls (rule S12, DOR-2997) and the
 * reaction toggle beside them, kept out of `mock-factories.ts`, which may only
 * shrink.
 *
 * @module test-utils/mock-direct-chats
 */
import { vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';

/** The Direct chat and reaction methods of a mock transport. */
export function directChatTransportMocks(): Pick<
  Transport,
  'openDirectChat' | 'findDirectChat' | 'toggleReaction'
> {
  return {
    // No Direct chat unless a test opens one: an ordinary chat is the default.
    openDirectChat: vi.fn().mockRejectedValue(new Error('No Direct chat in this test')),
    findDirectChat: vi.fn().mockResolvedValue(null),
    // Answers as if the emoji went ON, and hands back the shipped quick row —
    // the shape a capsule reads without a second request.
    toggleReaction: vi.fn().mockResolvedValue({
      accepted: true,
      entryId: 'entry-mock',
      emoji: '👍',
      reacted: true,
      frequents: ['👍', '❤️', '🎉'],
    }),
  };
}
