/** Public results and waiting options for the approval lifecycle. */
/** What a requester gets back: an id to watch, and a token to retry with. */
export interface ApprovalTicket {
  /** Display-only code matching the pending card, when a card was raised. */
  requestCode?: string;
  /** ULID of the new approval. Safe to show a person or log. */
  approvalId: string;
  /**
   * The one-time token. This is the ONLY time it is available — it is not stored
   * in recoverable form and must never be logged or returned again.
   */
  token: string;
  /** When the token stops being honored. ISO 8601 UTC. */
  expiresAt: string;
}

/** The action a token must match to be spent. */
export interface ApprovalBinding {
  /** Capability the caller is about to invoke. */
  capabilityId: string;
  /** Canonical hash of the input the caller is about to invoke it with. */
  inputHash: string;
  /** Current authenticated connector binding; absent for ordinary capabilities. */
  authorityBindingDigest?: string;
}

/**
 * The outcome of presenting a token, discriminated by `outcome`.
 *
 * - `granted` — the operator said yes and this call spent the token.
 * - `pending` — nobody has decided yet; present the token again later.
 * - `denied` — the operator said no; the token is spent either way.
 * - `expired` — the decision window closed; the token is written off.
 * - `consumed` — already spent (or written off) by an earlier call.
 * - `unknown` — no such token.
 * - `mismatched` — a real, live token for a DIFFERENT action. Deliberately not
 *   spent: the approval stays available for the action it was granted for.
 */
export type ApprovalConsumeResult =
  | {
      outcome: 'granted';
      approvalId: string;
      capabilityId: string;
      requestedBy?: string;
      authorityBindingDigest?: string;
      /** The signed-in account that said yes; absent when nobody was signed in. */
      decidedByUserId?: string;
    }
  | { outcome: 'pending'; approvalId: string; expiresAt: string; requestCode?: string }
  | { outcome: 'denied' | 'incomplete'; approvalId: string; reason?: string }
  | { outcome: 'expired'; approvalId: string }
  | { outcome: 'consumed'; approvalId: string }
  | { outcome: 'unknown' }
  | { outcome: 'mismatched'; approvalId: string };

/** Options for {@link ApprovalService.awaitDecision}. */
export interface AwaitDecisionOptions {
  /** Longest the hold waits before it resolves `timeout`. Required — a hold with no cap could outlive the tool call it blocks. */
  timeoutMs: number;
  /** Abort the wait (the SDK aborted the held tool call); resolves `timeout`. */
  signal?: AbortSignal;
}
