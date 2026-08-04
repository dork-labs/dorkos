/**
 * The pure derivations `room_context` reads for a bridged room (chats-as-
 * channels spec §8, §15; task 1.13): a bridge row's `visibility` mapped onto
 * the conservative `'partial' | 'full'` `room_context` reports, the fixed
 * Telegram formatting guidance, and which live adapter instances can even
 * answer the question.
 */
import { describe, it, expect } from 'vitest';
import { TELEGRAM_FORMATTING_RULES, MAX_MESSAGE_LENGTH, type RelayAdapter } from '@dorkos/relay';
import type { Bridge } from '../bridge-store.js';
import { bridgedRoomFraming, reportsVisibility } from '../room-context-framing.js';

/** A bridge row with every field overridable — visibility unset by default. */
function bridge(overrides: Partial<Bridge> = {}): Bridge {
  return {
    roomId: 'room-1',
    adapterId: 'tg-main',
    chatId: '555',
    channelType: 'group',
    platformChatType: 'group',
    bindingId: 'binding-1',
    visibility: null,
    visibilityCheckedAt: null,
    deliverNotices: false,
    lastDeliveredSeq: 0,
    lastActivityAt: null,
    createdAt: '2026-08-03T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

describe('bridgedRoomFraming (spec §8, §15)', () => {
  it('reports partial for a never-checked group bridge — the conservative default', () => {
    expect(bridgedRoomFraming(bridge({ visibility: null })).visibility).toBe('partial');
  });

  it('reports partial when the platform confirmed privacy mode is on', () => {
    expect(bridgedRoomFraming(bridge({ visibility: 'mentions-only' })).visibility).toBe('partial');
  });

  it('reports full only once the platform confirmed privacy mode is off', () => {
    expect(bridgedRoomFraming(bridge({ visibility: 'everything' })).visibility).toBe('full');
  });

  it('reports no visibility at all for a private (DM) bridge — a group-only concept', () => {
    // Even an 'everything' row must not surface a badge for a chat kind that
    // has none to report (§8: "a DM has no badge").
    expect(
      bridgedRoomFraming(bridge({ platformChatType: 'private', visibility: 'everything' }))
        .visibility
    ).toBeNull();
  });

  it('reports no visibility for a private bridge even with mentions-only stored', () => {
    expect(
      bridgedRoomFraming(bridge({ platformChatType: 'private', visibility: 'mentions-only' }))
        .visibility
    ).toBeNull();
  });

  it('carries the SAME formatting rules the adapter puts on an inbound envelope — never a second copy', () => {
    const framing = bridgedRoomFraming(bridge());
    expect(framing.formatting.instructions).toBe(TELEGRAM_FORMATTING_RULES);
    expect(framing.formatting.maxLength).toBe(MAX_MESSAGE_LENGTH);
  });

  it('formats a group and a private bridge with the same guidance — phase 1 is Telegram-only regardless of chat type', () => {
    const group = bridgedRoomFraming(bridge({ platformChatType: 'group' }));
    const dm = bridgedRoomFraming(bridge({ platformChatType: 'private' }));
    expect(group.formatting).toEqual(dm.formatting);
  });
});

describe('reportsVisibility — which live adapters can be asked (spec §11.2)', () => {
  it('accepts an adapter exposing getMe', () => {
    const adapter = { getMe: async () => null } as unknown as RelayAdapter;
    expect(reportsVisibility(adapter)).toBe(true);
  });

  it('refuses an adapter with no getMe — every non-Telegram adapter today', () => {
    const adapter = { id: 'webhook-1' } as unknown as RelayAdapter;
    expect(reportsVisibility(adapter)).toBe(false);
  });

  it('refuses an adapter whose getMe is not a function', () => {
    const adapter = { getMe: 'not a function' } as unknown as RelayAdapter;
    expect(reportsVisibility(adapter)).toBe(false);
  });
});
