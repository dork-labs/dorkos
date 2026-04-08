/**
 * Confirmation provider — gates marketplace mutation tools (install,
 * uninstall, create-package) behind explicit user approval.
 *
 * Three implementations cover the contexts in which an MCP marketplace tool
 * may be invoked:
 *
 * 1. {@link AutoApproveConfirmationProvider} — for tests and CI runs where
 *    `MARKETPLACE_AUTO_APPROVE=1` opts out of the gate entirely.
 * 2. {@link TokenConfirmationProvider} — for external MCP clients
 *    (Claude Code, Cursor, Codex). Issues short-lived single-use tokens; the
 *    user approves out-of-band in the DorkOS UI; the agent re-calls the tool
 *    with the token.
 * 3. {@link InAppConfirmationProvider} — for in-process callers that wire a
 *    callback to the existing `InstallConfirmationDialog` from spec 03.
 *
 * @module services/marketplace-mcp/confirmation-provider
 */
import { randomUUID } from 'node:crypto';
import type { PermissionPreview } from '../marketplace/types.js';

/** The kind of mutation a confirmation request is gating. */
export type ConfirmationOperation = 'install' | 'uninstall' | 'create-package';

/**
 * Result of a confirmation request, discriminated by `status`.
 *
 * - `approved` — the user (or auto-approve) consented; the caller may proceed.
 * - `declined` — the user refused; `reason` is an optional human-readable note.
 * - `pending` — the request is awaiting out-of-band approval; the caller must
 *   re-resolve the returned `token` later.
 */
export type ConfirmationResult =
  | { status: 'approved' }
  | { status: 'declined'; reason?: string }
  | { status: 'pending'; token: string };

/** Payload for {@link ConfirmationProvider.requestInstallConfirmation}. */
export interface ConfirmationRequest {
  packageName: string;
  marketplace: string;
  operation: ConfirmationOperation;
  preview?: PermissionPreview;
}

/**
 * Generic confirmation provider that gates marketplace mutation tools. Each
 * concrete implementation chooses how the user actually consents — synchronous
 * UI prompt, out-of-band token, or unconditional auto-approval.
 */
export interface ConfirmationProvider {
  /**
   * Request user confirmation for an install/uninstall/create-package
   * operation. Implementations may surface a prompt synchronously (in-app UI),
   * return a token for out-of-band approval (external MCP clients), or
   * auto-approve when explicitly configured.
   *
   * @param req - The confirmation request payload.
   */
  requestInstallConfirmation(req: ConfirmationRequest): Promise<ConfirmationResult>;

  /**
   * Look up a previously issued confirmation token. Used when an external MCP
   * client re-calls `marketplace_install` after the user approved out-of-band.
   *
   * @param token - The token previously returned via `pending`.
   */
  resolveToken(token: string): Promise<ConfirmationResult>;
}

/**
 * Confirmation provider that always returns `approved`. Used when
 * `process.env.MARKETPLACE_AUTO_APPROVE === '1'` or in unit tests that want
 * to skip the confirmation gate entirely.
 */
export class AutoApproveConfirmationProvider implements ConfirmationProvider {
  /**
   * Always returns `{ status: 'approved' }`.
   */
  async requestInstallConfirmation(): Promise<ConfirmationResult> {
    return { status: 'approved' };
  }

  /**
   * Always returns `{ status: 'approved' }` regardless of the token value.
   */
  async resolveToken(): Promise<ConfirmationResult> {
    return { status: 'approved' };
  }
}

/** Internal record tracking a single in-flight confirmation request. */
interface PendingConfirmation {
  token: string;
  packageName: string;
  marketplace: string;
  operation: ConfirmationOperation;
  createdAt: number;
  resolvedTo?: 'approved' | 'declined';
  declineReason?: string;
}

/**
 * Confirmation provider that issues short-lived (5 minute), single-use,
 * scoped tokens for external MCP clients.
 *
 * Flow:
 * 1. The agent calls `marketplace_install`; the provider returns
 *    `{ status: 'pending', token }`.
 * 2. The user opens the DorkOS UI and clicks Approve or Decline; the host
 *    forwards that decision via {@link approve} / {@link decline}.
 * 3. The agent re-calls the tool, which calls {@link resolveToken}; on the
 *    first call after a decision, the entry is removed from the pending map
 *    (single-use).
 *
 * Tokens that are never resolved expire after exactly 5 minutes. The expiry
 * check uses a strict `>` comparison so a resolve at the boundary is still
 * considered pending.
 */
export class TokenConfirmationProvider implements ConfirmationProvider {
  /** Time-to-live for an issued token, in milliseconds (5 minutes). */
  private readonly ttlMs = 5 * 60 * 1000;

  /** In-memory map of issued, unresolved tokens. */
  private readonly pending = new Map<string, PendingConfirmation>();

  /**
   * Issue a new pending confirmation token. The returned token must be passed
   * back to {@link resolveToken} after the user has approved or declined
   * out-of-band.
   *
   * @param req - The confirmation request payload.
   */
  async requestInstallConfirmation(req: ConfirmationRequest): Promise<ConfirmationResult> {
    const token = randomUUID();
    this.pending.set(token, {
      token,
      packageName: req.packageName,
      marketplace: req.marketplace,
      operation: req.operation,
      createdAt: Date.now(),
    });
    return { status: 'pending', token };
  }

  /**
   * Mark a previously issued token as approved. Called by the DorkOS UI when
   * the user clicks Approve. A no-op for unknown tokens.
   *
   * @param token - The token returned by {@link requestInstallConfirmation}.
   */
  approve(token: string): void {
    const entry = this.pending.get(token);
    if (entry) entry.resolvedTo = 'approved';
  }

  /**
   * Mark a previously issued token as declined. Called by the DorkOS UI when
   * the user clicks Decline. A no-op for unknown tokens.
   *
   * @param token - The token returned by {@link requestInstallConfirmation}.
   * @param reason - Optional human-readable explanation.
   */
  decline(token: string, reason?: string): void {
    const entry = this.pending.get(token);
    if (entry) {
      entry.resolvedTo = 'declined';
      entry.declineReason = reason;
    }
  }

  /**
   * Resolve a previously issued token to its current status. After the first
   * resolution to `approved` or `declined` (or after expiry), the entry is
   * removed from the pending map — every subsequent call returns
   * `{ status: 'declined', reason: 'Unknown or expired token' }`.
   *
   * @param token - The token previously returned via `pending`.
   */
  async resolveToken(token: string): Promise<ConfirmationResult> {
    const entry = this.pending.get(token);
    if (!entry) return { status: 'declined', reason: 'Unknown or expired token' };

    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.pending.delete(token);
      return { status: 'declined', reason: 'Token expired' };
    }

    if (entry.resolvedTo === 'approved') {
      this.pending.delete(token);
      return { status: 'approved' };
    }

    if (entry.resolvedTo === 'declined') {
      this.pending.delete(token);
      return { status: 'declined', reason: entry.declineReason };
    }

    return { status: 'pending', token };
  }
}

/**
 * Callback signature for {@link InAppConfirmationProvider}. The host wires
 * this to the existing `InstallConfirmationDialog` from spec 03.
 */
export type InAppConfirmationCallback = (
  req: ConfirmationRequest
) => Promise<{ status: 'approved' } | { status: 'declined'; reason?: string }>;

/**
 * Confirmation provider for in-process callers (the DorkOS server-side
 * install path). Delegates to a callback that the host wires to the existing
 * `InstallConfirmationDialog` pattern from spec 03; returns `approved` or
 * `declined` synchronously and issues no tokens.
 */
export class InAppConfirmationProvider implements ConfirmationProvider {
  /**
   * Construct an in-app provider backed by the given callback.
   *
   * @param callback - Host-supplied function that surfaces the confirmation
   *   dialog and resolves with the user's decision.
   */
  constructor(private readonly callback: InAppConfirmationCallback) {}

  /**
   * Delegate to the injected callback. The callback is responsible for
   * surfacing the confirmation UI and resolving with the user's decision.
   *
   * @param req - The confirmation request payload.
   */
  async requestInstallConfirmation(req: ConfirmationRequest): Promise<ConfirmationResult> {
    return this.callback(req);
  }

  /**
   * In-app confirmations are synchronous — this provider never issues tokens,
   * so any `resolveToken` call is a programming error and is reported as a
   * declined result.
   */
  async resolveToken(): Promise<ConfirmationResult> {
    return { status: 'declined', reason: 'In-app provider does not issue tokens' };
  }
}
