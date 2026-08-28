import { create } from 'zustand';
import type { PublicConnectedAccount } from '@dorkos/shared/connector-provider';

/**
 * The connect flow's steps, in order. The machine's one invariant is consent
 * ordering: the auth URL exists only from `disclosure` on, and nothing in the
 * flow ever opens it — the UI renders it as a link the person clicks AFTER
 * reading the custody disclosure, then reports the click via `authOpened` to
 * begin polling.
 *
 * - `idle` — nothing in flight.
 * - `starting` — the start request is on the wire.
 * - `disclosure` — the server answered with the auth URL and the custody
 *   sentence; the UI shows the sentence and the sign-in link.
 * - `waiting` — the person opened the sign-in page; the flow is being polled.
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
  /** The vendor sign-in URL, from `disclosure` on. Never opened by the flow itself. */
  authorizeUrl: string | null;
  /** The new account, once `connected`. */
  account: PublicConnectedAccount | null;
  /** Why the flow failed, once `failed`. */
  error: string | null;
}

/** Store shape: the observable state plus the pollable flow id and actions. */
interface ConnectFlowStore extends ConnectFlowState {
  /** The opaque server flow id being polled, from `disclosure` on. */
  flowId: string | null;
  /** Enter `starting` for one toolkit, clearing any previous flow. */
  begin: (toolkit: string) => void;
  /** The start request answered: enter `disclosure` with URL + sentence. */
  startResolved: (result: { flowId: string; authorizeUrl: string; disclosure: string }) => void;
  /** The start request was rejected: enter `failed`. */
  startFailed: (error: string) => void;
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
export const useConnectFlowStore = create<ConnectFlowStore>()((set) => ({
  ...IDLE_STATE,

  begin: (toolkit) => set({ ...IDLE_STATE, step: 'starting', toolkit }),

  startResolved: ({ flowId, authorizeUrl, disclosure }) =>
    set({ step: 'disclosure', flowId, authorizeUrl, disclosure, account: null, error: null }),

  startFailed: (error) =>
    set({ step: 'failed', flowId: null, authorizeUrl: null, disclosure: null, error }),

  authOpened: () => set((prev) => (prev.step === 'disclosure' ? { step: 'waiting' } : {})),

  settleConnected: (account) => set({ step: 'connected', account }),

  settleFailed: (error) => set({ step: 'failed', error }),

  reset: () => set({ ...IDLE_STATE }),
}));
