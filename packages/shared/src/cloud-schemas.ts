/**
 * Cloud-link wire contract — the shapes exchanged over the local `/api/cloud/*`
 * routes that link this DorkOS instance to a DorkOS account (accounts-and-auth
 * P2). The server owns the state machine; these are the read/response shapes the
 * client Settings panel renders. The instance token is never part of any shape
 * here — it is server-side only and never leaves the machine.
 *
 * @module shared/cloud-schemas
 */

/**
 * The link-flow state the client UI reads.
 *
 * - `idle` — not linked, no flow in progress (also the state a user-initiated
 *   unlink returns to).
 * - `pending` — a device flow is in progress; awaiting the user to enter the code.
 * - `linked` — this instance is linked to a DorkOS account.
 * - `expired` — the device code lapsed before it was entered.
 * - `denied` — the user rejected the link request.
 * - `unlinked` — the cloud revoked this instance's key (show a re-link action).
 */
export type CloudLinkState = 'idle' | 'pending' | 'linked' | 'expired' | 'denied' | 'unlinked';

/**
 * `GET /api/cloud/link/status` — the live link-flow state machine, polled while a
 * device flow transitions from `pending` to a terminal state. `accountLabel` and
 * `lastHeartbeatAt` are present only once a heartbeat has landed.
 */
export interface CloudLinkStatus {
  state: CloudLinkState;
  /** The linked account's label (email). Absent until the first heartbeat lands. */
  accountLabel?: string;
  /** ISO timestamp of the most recent successful heartbeat. Absent until one lands. */
  lastHeartbeatAt?: string;
}

/**
 * `GET /api/cloud/status` — the settled linked/unlinked summary used for the
 * Settings panel's initial render.
 */
export interface CloudLinkSummary {
  linked: boolean;
  /** The linked account's label (email), or `null` until a heartbeat lands. */
  accountLabel: string | null;
  /** ISO timestamp of the most recent heartbeat, or `null` if none yet. */
  lastHeartbeatAt: string | null;
}

/**
 * `POST /api/cloud/link/start` — the codes the human enters to approve the link.
 * `verificationUri` is the page to open; `userCode` is the short code to type.
 */
export interface StartLinkResult {
  /** Short (8-char) code the user enters on the verification page. */
  userCode: string;
  /** URL of the activation page (e.g. `https://dorkos.ai/activate`). */
  verificationUri: string;
  /** ISO timestamp at which `userCode` expires. */
  expiresAt: string;
}
