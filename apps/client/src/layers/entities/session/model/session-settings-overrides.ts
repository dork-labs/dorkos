/**
 * Optimistic overrides for the four session settings a person can change from
 * the status line: model, permission mode, reasoning effort, and fast mode.
 *
 * These used to be `useState` inside `useSessionStatus`, which meant every
 * component calling that hook held its OWN optimism. Two surfaces reading the
 * same session then disagreed for the length of a PATCH round-trip — the status
 * line's permission item showed `plan` the instant it was clicked while the
 * status strip above it (a second `useSessionStatus` instance in `ChatPanel`)
 * still read `default`. Keyed per session in one store, every reader converges
 * on the same value in the same tick, however many of them there are.
 *
 * Entries are short-lived: `useSessionStatus`'s convergence effect drops each
 * key as soon as the server confirms it, and a failed PATCH clears it outright.
 *
 * @module entities/session/model/session-settings-overrides
 */
import { create } from 'zustand';
import type { EffortLevel, PermissionMode } from '@dorkos/shared/types';

/** The session settings that can be optimistically ahead of the server. */
export interface SessionSettingsOverride {
  /** User-selected model option value, pending server confirmation. */
  model?: string;
  /** Pending permission mode. */
  permissionMode?: PermissionMode;
  /** Pending reasoning effort. */
  effort?: EffortLevel;
  /** Pending fast-mode flag. */
  fastMode?: boolean;
}

/** Keys of {@link SessionSettingsOverride} — the unit `clear` operates on. */
export type SessionSettingsOverrideKey = keyof SessionSettingsOverride;

interface SessionSettingsOverridesState {
  /** Pending settings per session id. Absent means "nothing pending". */
  bySession: Record<string, SessionSettingsOverride>;
  /** Merge pending settings onto a session (no-op for an empty patch). */
  apply: (sessionId: string, patch: SessionSettingsOverride) => void;
  /** Drop the named pending settings from a session. */
  clear: (sessionId: string, keys: readonly SessionSettingsOverrideKey[]) => void;
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

  clear: (sessionId, keys) =>
    set((state) => {
      const current = state.bySession[sessionId];
      if (!current) return state;
      const next = { ...current };
      let changed = false;
      for (const key of keys) {
        if (key in next) {
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
