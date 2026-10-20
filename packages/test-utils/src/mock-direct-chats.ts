/**
 * Transport mocks for the Direct chat calls (rule S12, DOR-2997), the
 * reaction toggle beside them, and moving a room agent to another account
 * (re-seat), kept out of `mock-factories.ts`, which may only shrink.
 *
 * @module test-utils/mock-direct-chats
 */
import { vi } from 'vitest';
import type { Transport } from '@dorkos/shared/transport';

/** The Direct chat, reaction and re-seat methods of a mock transport. */
export function directChatTransportMocks(): Pick<
  Transport,
  | 'openDirectChat'
  | 'findDirectChat'
  | 'toggleReaction'
  | 'getRoomReseatOptions'
  | 'reseatRoomAgent'
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
    // Re-seat: nowhere to move by default, so a test about the picker says
    // which accounts it offers.
    getRoomReseatOptions: vi.fn().mockResolvedValue({ current: null, accounts: [], seated: false }),
    reseatRoomAgent: vi.fn().mockResolvedValue({ sessionId: 'reseated-session' }),
  };
}
