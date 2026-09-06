import { create } from 'zustand';
import type { PublicConnectedAccount } from '@dorkos/shared/connector-provider';

/**
 * The connect flow's steps, in order. The machine's one invariant is consent
 * ordering: an auth URL exists only from `disclosure` on, and nothing in the
 * flow ever opens it — the UI renders it as a link the person clicks AFTER
 * reading the custody disclosure, then reports the click via `authOpened` to
 * begin polling.
 *
 * - `idle` — nothing in flight.
 * - `starting` — the start request is on the wire.
 * - `disclosure` — the server answered with the auth URL and the custody
 *   sentence; the UI shows the sentence and the sign-in link.
 * - `waiting` — the browser step finished, or no browser step was needed; the flow is being polled.
 * - `connected` — terminal; `account` holds the new account.
 * - `failed` — terminal; `error` says why.
 */
export type ConnectFlowStep =
  'idle' | 'starting' | 'disclosure' | 'waiting' | 'connected' | 'failed';

/** The connect flow's observable state. */
export interface ConnectFlowState {
  /** Where the flow is; see {@link ConnectFlowStep}. */
  step: ConnectFlowStep;
  /** The service slug being connected, from `starting` on. */
  toolkit: string | null;
  /** The server-composed custody sentence, from `disclosure` on. */
  disclosure: string | null;
  /** The vendor sign-in URL, from `disclosure` on when browser action is required. */
  authorizeUrl: string | null;
  /** The new account, once `connected`. */
  account: PublicConnectedAccount | null;
  /** Why the flow failed, once `failed`. */
  error: string | null;
}

/** Store shape: the observable state plus the pollable flow id and actions. */
interface ConnectFlowStore extends ConnectFlowState {
  /** Monotonic request generation used to ignore late start responses after reset/replacement. */
  generation: number;
  /** The opaque server flow id being polled, from `disclosure` on. */
  flowId: string | null;
  /** Enter `starting`, clearing any previous flow, and return this request's generation. */
  begin: (toolkit: string) => number;
  /** The start request answered: disclose a browser URL, or begin polling when none is needed. */
  startResolved: (
    generation: number,
    result: { flowId: string; authorizeUrl?: string; disclosure: string }
  ) => void;
  /** The start request was rejected: enter `failed`. */
  startFailed: (generation: number, error: string) => void;
  /** The person opened the sign-in page: `disclosure → waiting`. No-op elsewhere. */
  authOpened: () => void;
  /** A poll observed the terminal `connected` state. */
  settleConnected: (account: PublicConnectedAccount | null) => void;
  /** A poll observed the terminal `failed` state (or the poll itself died). */
  settleFailed: (error: string) => void;
  /** Abandon tracking and return to `idle`. */
  reset: () => void;
}

const IDLE_STATE: ConnectFlowState & { flowId: string | null } = {
  step: 'idle',
  toolkit: null,
  disclosure: null,
  authorizeUrl: null,
  account: null,
  error: null,
  flowId: null,
};

/**
 * The ONE in-flight connect flow, held app-wide rather than inside any
 * dialog's component state — so closing the connect dialog (or leaving and
 * returning to the page) mid-grant does not orphan a sign-in the person then
 * completes in the vendor tab. Whatever surface mounts `useConnectFlow` keeps
 * polling a `waiting` flow and records the account when it lands; a dialog is
 * just a view of this state.
 *
 * Single-flow by design: starting a new connect replaces the old tracking,
 * mirroring the server's process-scoped flow bindings (one person, one
 * consent screen at a time).
 */
export const useConnectFlowStore = create<ConnectFlowStore>()((set, get) => ({
  ...IDLE_STATE,
  generation: 0,

  begin: (toolkit) => {
    const nextGeneration = get().generation + 1;
    set({ ...IDLE_STATE, generation: nextGeneration, step: 'starting', toolkit });
    return nextGeneration;
  },

  startResolved: (generation, { flowId, authorizeUrl, disclosure }) => {
    const current = get();
    if (current.generation !== generation || current.step !== 'starting') return;
    set({
      step: authorizeUrl ? 'disclosure' : 'waiting',
      flowId,
      authorizeUrl: authorizeUrl ?? null,
      disclosure,
      account: null,
      error: null,
    });
  },

  startFailed: (generation, error) => {
    const current = get();
    if (current.generation !== generation || current.step !== 'starting') return;
    set({ step: 'failed', flowId: null, authorizeUrl: null, disclosure: null, error });
  },

  authOpened: () => set((prev) => (prev.step === 'disclosure' ? { step: 'waiting' } : {})),

  settleConnected: (account) => set({ step: 'connected', account }),

  settleFailed: (error) => set({ step: 'failed', error }),

  reset: () => set((prev) => ({ ...IDLE_STATE, generation: prev.generation + 1 })),
}));
