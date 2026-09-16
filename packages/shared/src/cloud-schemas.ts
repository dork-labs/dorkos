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

// ---------------------------------------------------------------------------
// The plan-aware surfaces (DOR-2027).
//
// These shapes wrap the `/v1` contract rather than restating it: the payloads
// themselves are `@dork-labs/cloud-api` types, and all this layer adds is the
// one thing the contract cannot express — whether THIS instance has anything to
// show. Every response below is a discriminated union on `available`, so a
// surface renders an empty state instead of guessing from a missing field, and
// an install with no cloud account gets `available: false` on every route
// without a single request leaving the machine.
//
// Catalog blindness holds through here unchanged: no plan name, plan id or
// price is ever named by this module. Amounts stay the contract's micro-unit
// DECIMAL STRINGS all the way to the renderer, so nothing rounds them through a
// float on the way to a screen.
// ---------------------------------------------------------------------------

import type {
  Balance,
  Entitlements,
  Member,
  Nudge,
  Org,
  Problem,
  Seat,
  UsageResponse,
} from '@dork-labs/cloud-api';

/**
 * `GET /api/cloud/plan` — what the plan card renders.
 *
 * `balance` is `null` when the service serves an entitlement but no credit
 * position; the card then renders the plan half alone.
 */
export type CloudPlanResponse =
  { available: false } | { available: true; entitlements: Entitlements; balance: Balance | null };

/** `GET /api/cloud/usage` — one grouped usage window for the credits gauge. */
export type CloudUsageResponse = { available: false } | { available: true; usage: UsageResponse };

/**
 * `GET /api/cloud/nudge` — the already-reduced comparison, or nothing.
 *
 * The service does the subtraction. `available: false` is the ordinary answer
 * (the route sits behind a server flag), and the nudge simply does not render.
 */
export type CloudNudgeResponse = { available: false } | { available: true; nudge: Nudge };

/** `GET /api/cloud/orgs` — the organizations this account belongs to. */
export type CloudOrgsResponse = { available: false } | { available: true; orgs: Org[] };

/**
 * `GET /api/cloud/orgs/:orgId/members` — who could hold a person seat.
 *
 * The seat surface reads this so assigning a seat picks a real subject rather
 * than asking somebody to type an opaque identifier at it.
 */
export type CloudMembersResponse = { available: false } | { available: true; members: Member[] };

/** `GET /api/cloud/orgs/:orgId/seats` — one organization's seats. */
export type CloudSeatsResponse = { available: false } | { available: true; seats: Seat[] };

/**
 * The answer to a seat write.
 *
 * A refusal arrives as the contract's own problem envelope, passed through
 * verbatim. That is what lets the app explain that an action needs a plan
 * change using the service's words — `title`, `detail` and
 * `requiredPlanDisplayName` — and never a plan name of its own.
 */
export type CloudSeatActionResponse =
  { ok: true; seat?: Seat } | { ok: false; problem: Problem } | { ok: false; message: string };

/**
 * Why a seat write answers `200` even when it refused.
 *
 * `fetchJSON` throws on every non-2xx, which would turn a refusal into an
 * exception and leave the service's own words — the whole point of the envelope
 * — somewhere the surface cannot render them. The service's status rides inside
 * `problem.status` instead, so nothing is lost and the caller writes one path.
 */

/** How far a runtime's credits wiring has got. */
export type CloudCreditsRuntimeState = 'wired' | 'follow-up';

/**
 * `GET /api/cloud/credits` — a credential-free description of the credits path.
 *
 * It carries no token, no endpoint and no amount: only whether the path is
 * armed for this process and which runtimes it reaches.
 */
export interface CloudCreditsStatus {
  /** Whether the feature flag is on for this process. Off by default. */
  enabled: boolean;
  /** Whether a live inference token is held. Never the token itself. */
  ready: boolean;
  /** Per-runtime state, so the app can say what actually works today. */
  runtimes: Record<'claude-code' | 'opencode' | 'codex', CloudCreditsRuntimeState>;
}
