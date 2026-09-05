/**
 * Optimistic overrides for the four session settings a person can change from
 * the status line: model, permission mode, reasoning effort, and fast mode.
 *
 * These used to be `useState` inside `useSessionStatus`, which meant every
 * component calling that hook held its OWN optimism. Two concrete defects
 * followed, both on `main`:
 *
 * - **Readers disagreed for a whole PATCH round-trip.** `ChatPanel` and
 *   `ChatStatusSection` each call `useSessionStatus`, so changing the model from
 *   the status line flipped the line's own item instantly while the second
 *   instance kept serving the old value to everything reading through it —
 *   including the `bypassPermissions` verb list the streaming strip seeds from
 *   `permissionMode`, which kept rotating the wrong verbs mid-turn.
 * - **Optimism leaked across a session switch.** The state was keyed to the
 *   component instance, not the session, so a pending model change survived a
 *   switch and briefly asserted itself about the session you had just opened.
 *
 * Keyed per session in one store, every reader converges on the same value in the
 * same tick, however many of them there are, and switching sessions reads a
 * different key.
 *
 * Entries are short-lived: `useSessionStatus`'s convergence effect drops each key
 * as soon as the server confirms it, and a failed PATCH clears its own.
 *
 * @module entities/session/model/settings/session-settings-overrides
 */
import { create } from 'zustand';
import type { EffortLevel } from '@dorkos/shared/types';

/** The session settings that can be optimistically ahead of the server. */
export interface SessionSettingsOverride {
  /** User-selected model option value, pending server confirmation. */
  model?: string;
  /**
   * Pending permission mode — any id the runtime declares (DOR-811), which is
   * wider than {@link PermissionMode}'s known names. The picker already hands
   * this hook descriptor ids verbatim, so `string` is the honest type rather
   * than a cast at every writer (DOR-820).
   */
  permissionMode?: string;
  /** Pending reasoning effort. */
  effort?: EffortLevel;
  /** Pending fast-mode flag. */
  fastMode?: boolean;
}

/** Keys of {@link SessionSettingsOverride} — one pending setting. */
type SessionSettingsOverrideKey = keyof SessionSettingsOverride;

/** One `[key, value]` pair of a patch, with the value narrowed to that key's type. */
type SessionSettingsOverrideEntry = [
  SessionSettingsOverrideKey,
  SessionSettingsOverride[SessionSettingsOverrideKey],
];

interface SessionSettingsOverridesState {
  /** Pending settings per session id. Absent means "nothing pending". */
  bySession: Record<string, SessionSettingsOverride>;
  /** Merge pending settings onto a session (no-op for an empty patch). */
  apply: (sessionId: string, patch: SessionSettingsOverride) => void;
  /**
   * Drop pending settings that still hold the value the caller applied.
   *
   * Value-scoped, not key-scoped, because two writers can have the same key in
   * flight at once. Key-scoped, a FAILED first PATCH reverted a second writer's
   * still-pending optimism: A sets `model: X`, B sets `model: Y`, A rejects, and
   * A's rollback dropped the key — snapping every reader back to the server value
   * while B's request was still live. A key whose current value is no longer the
   * caller's belongs to a later writer and is left alone.
   */
  clear: (sessionId: string, applied: SessionSettingsOverride) => void;
}

/**
 * Stable empty override, so a session with nothing pending returns the same
 * object on every render and never re-renders its subscribers.
 */
const NO_OVERRIDE: SessionSettingsOverride = Object.freeze({});

export const useSessionSettingsOverridesStore = create<SessionSettingsOverridesState>()((set) => ({
  bySession: {},

  apply: (sessionId, patch) =>
    set((state) => {
      const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (entries.length === 0) return state;
      return {
        bySession: {
          ...state.bySession,
          [sessionId]: { ...state.bySession[sessionId], ...Object.fromEntries(entries) },
        },
      };
    }),

  clear: (sessionId, applied) =>
    set((state) => {
      const current = state.bySession[sessionId];
      if (!current) return state;
      const next = { ...current };
      let changed = false;
      for (const [key, value] of Object.entries(applied) as SessionSettingsOverrideEntry[]) {
        // Only what is still ours: a key a later writer has since overwritten is
        // that writer's pending value, and dropping it would revert them.
        if (value !== undefined && next[key] === value) {
          delete next[key];
          changed = true;
        }
      }
      // Identity-stable when nothing was pending: repeated convergence effects
      // (one per `useSessionStatus` instance) must not each notify the store.
      if (!changed) return state;
      const bySession = { ...state.bySession };
      if (Object.keys(next).length === 0) delete bySession[sessionId];
      else bySession[sessionId] = next;
      return { bySession };
    }),
}));

/**
 * The pending settings for one session — session-scoped, so an override on
 * another session never re-renders this one.
 *
 * @param sessionId - Session id, or `''` when no session is active.
 */
export function useSessionSettingsOverride(sessionId: string): SessionSettingsOverride {
  return useSessionSettingsOverridesStore((s) => s.bySession[sessionId] ?? NO_OVERRIDE);
}
