/**
 * Whose chip tray is open — held outside the row that the turn's end remounts.
 *
 * @module features/chat/ui/chips/use-tray-expansion
 */
import { useCallback } from 'react';
import { create } from 'zustand';
import type { MessagePart } from '@dorkos/shared/types';

/** The set of turns whose tray the reader has opened. */
interface TrayExpansionState {
  /** Keys of the open trays. A tray that is shut is simply absent. */
  open: Record<string, true>;
  /**
   * Open a shut tray, or shut an open one.
   *
   * @param key - The turn's identity, from {@link trayExpansionKey}.
   */
  toggle: (key: string) => void;
}

/**
 * The open trays, one entry per turn the reader has opened.
 *
 * Exported for tests, which reset it between cases the way a fresh tab starts.
 * Nothing else should reach for it: {@link useTrayExpansion} is the whole API.
 */
export const useTrayExpansionStore = create<TrayExpansionState>((set) => ({
  open: {},
  toggle: (key) =>
    set((state) => {
      const open = { ...state.open };
      if (open[key]) delete open[key];
      else open[key] = true;
      return { open };
    }),
}));

/**
 * The identity a turn's tray state is filed under: its FIRST tool call.
 *
 * The obvious identity — the message's id — is the one thing that cannot be
 * used, because it is what changes. A running turn renders under a synthetic id
 * (`__in_progress_turn__`); the moment it finishes, the reconcile swaps the
 * whole projection for canonical history and the same turn reappears under its
 * real id. The message list keys rows by that id, so React tears the row down
 * and builds it again at exactly the moment the strip settles — and a tray the
 * reader opened mid-turn was destroyed by the turn finishing (DOR-827).
 *
 * A tool call's id survives that swap untouched: it is the model's own id for
 * the call, streamed live and then written into the transcript, so both sides of
 * the swap name it identically. The FIRST one is used because it is the one part
 * of a growing turn that never changes — later calls are still arriving.
 *
 * The session scopes it. Tool ids are unique in practice, but a fixture or a
 * test-mode runtime may well reuse one, and two sessions sharing a tray is a
 * confusing thing to debug.
 *
 * @param sessionId - The open session, or `null` outside one (a showcase).
 * @param parts - The turn's parts, in transcript order.
 * @returns A key that is stable for the life of the turn.
 */
export function trayExpansionKey(sessionId: string | null, parts: readonly MessagePart[]): string {
  const scope = sessionId ?? 'detached';
  for (const part of parts) {
    if (part.type === 'tool_call') return `${scope}:${part.toolCallId}`;
  }
  // Unreachable while a strip is on screen: chips are folded from tool calls, so
  // a turn with none renders no strip at all. Named rather than thrown, because
  // a bucket nothing can see is not worth crashing a transcript over.
  return `${scope}:no-tool`;
}

/**
 * Read and toggle one turn's tray, by a key that outlives its row.
 *
 * @param key - The turn's identity, from {@link trayExpansionKey}.
 * @returns Whether the tray is open, and a toggle for it.
 */
export function useTrayExpansion(key: string): [boolean, () => void] {
  const expanded = useTrayExpansionStore((state) => state.open[key] === true);
  const toggleKey = useTrayExpansionStore((state) => state.toggle);
  const toggle = useCallback(() => toggleKey(key), [key, toggleKey]);
  return [expanded, toggle];
}
