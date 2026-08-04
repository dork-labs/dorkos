/**
 * What a bridged room's turn is told about the chat it projects — the
 * `room_context` half of chats-as-channels spec §8 (privacy-mode honesty) and
 * §15 (message formatting across the boundary). Task 1.13.
 *
 * These small, pure derivations live here rather than in `room-context.ts`
 * itself, for the reason `bridge-store.ts`'s header states: the rooms domain
 * must not know Telegram exists, so anything platform-shaped stays in this
 * package and `RoomService` wires it in through a predicate — the same
 * pattern `isBridgedRoom` already used before this task widened it.
 * {@link reportsVisibility} is the same idea applied to `AdapterManager`'s
 * visibility-refresh call: it decides WHETHER an adapter can report
 * visibility at all, so `adapter-manager.ts` never has to know Telegram is
 * the only one that can, today.
 *
 * @module server/services/relay/chat-bridge/room-context-framing
 */
import type { RelayAdapter } from '@dorkos/relay';
import { MAX_MESSAGE_LENGTH, TELEGRAM_FORMATTING_RULES } from '@dorkos/relay';
import type { Bridge, BridgeStore } from './bridge-store.js';

/** What `room_context` needs about a bridged room (spec §8, §15). */
export interface BridgedRoomFraming {
  /**
   * `null` for a bridged DM: privacy mode is a group-only switch, and
   * Telegram delivers every private-chat message regardless of it, so there
   * is nothing partial to report for one (spec §8, "a DM has no badge").
   */
  visibility: 'partial' | 'full' | null;
  /** Guidance only — the outbound adapter remains the enforcement backstop. */
  formatting: { instructions: string; maxLength: number };
}

/**
 * Project a bridge row onto what `room_context` reports (task 1.13).
 *
 * **Phase 1 is Telegram-only** (chats-as-channels spec §12): every bridge row
 * that exists today came from the Telegram adapter, so `formatting` is that
 * platform's fixed rules unconditionally. A later phase that bridges Slack
 * adds platform dispatch here — on `bridge.channelType` or a stored platform
 * column — rather than this function guessing from `adapterId`.
 *
 * @param bridge - The room's bridge row.
 */
export function bridgedRoomFraming(bridge: Bridge): BridgedRoomFraming {
  return {
    visibility: bridge.platformChatType === 'private' ? null : resolveVisibility(bridge),
    formatting: { instructions: TELEGRAM_FORMATTING_RULES, maxLength: MAX_MESSAGE_LENGTH },
  };
}

/**
 * The FLAG this task resolves (spec §8): the spec fixes the source
 * (`getMe().can_read_all_group_messages`) but not the refresh cadence for
 * `visibilityCheckedAt`. Refresh is wired at bridge-create time
 * ({@link BridgeLifecycle.bridge}) and at adapter start/reconnect
 * (`AdapterManager.emitAdapterLifecycle`'s `'connected'` branch) — the same
 * event `BridgeCatchUp.scanAdapter` already rides for the identical reason:
 * this codebase has no separate "reconnect" signal, only a fresh `'connected'`
 * emit.
 *
 * **A never-checked or not-yet-refreshed value degrades to `'partial'`, the
 * conservative direction.** `bridge.visibility` is `null` until the first
 * refresh completes, and a refresh that throws (a network error, a revoked
 * token) leaves it exactly where it was — so `null` and "the last check said
 * mentions-only" read identically here. This function does not additionally
 * age out an old-but-successful check against `visibilityCheckedAt`: with no
 * periodic refresh in phase 1, a numeric staleness window would flip an
 * accurate answer to `'partial'` after an arbitrary clock's-worth of an
 * adapter that never reconnected, which is not obviously more honest than
 * trusting the last confirmed read. The gap this leaves — an operator
 * flipping Telegram's privacy switch mid-session, with no message and no
 * reconnect to notice it — is the same gap spec §8's own honesty list already
 * names for the bot-wide-not-per-group case, not a new one.
 */
function resolveVisibility(bridge: Bridge): 'partial' | 'full' {
  return bridge.visibility === 'everything' ? 'full' : 'partial';
}

/**
 * The stored forum-topic name for a batch of entries, keyed by entry id
 * (chats-as-channels spec §5.6) — already sanitized once at write time
 * (`ingest.ts`), and carried through here UNSANITIZED on purpose: the caller
 * (`room-context.ts`) hands it to `RoomContextEntry.topicLabel` unchanged, and
 * the renderer (`room-context-block.ts`) sanitizes it again at render, because
 * §9.2 requires both.
 *
 * @param bridges - The bridge store to read refs from.
 * @param entryIds - The entries to look up.
 */
export function topicNamesForEntries(
  bridges: BridgeStore,
  entryIds: readonly string[]
): Map<string, string> {
  const names = new Map<string, string>();
  for (const [entryId, ref] of bridges.findRefsByEntries(entryIds)) {
    if (ref.threadName) names.set(entryId, ref.threadName);
  }
  return names;
}

/** An adapter that can report Telegram's privacy-mode switch (spec §8, §11.2). */
export interface VisibilityReportingAdapter {
  getMe(): Promise<{ username: string; canReadAllGroupMessages: boolean } | null>;
}

/**
 * Whether a live adapter instance exposes `getMe` at all — true for Telegram
 * only today (spec §12: phase 1 is Telegram-only). A structural check rather
 * than an `instanceof TelegramAdapter`, so `AdapterManager`'s visibility
 * refresh (task 1.13's "on adapter start" trigger) stays correct for a future
 * platform that gains the same accessor without needing to import its class.
 *
 * @param adapter - The live adapter instance from `AdapterRegistry.get`.
 */
export function reportsVisibility(
  adapter: RelayAdapter
): adapter is RelayAdapter & VisibilityReportingAdapter {
  return typeof (adapter as { getMe?: unknown }).getMe === 'function';
}
