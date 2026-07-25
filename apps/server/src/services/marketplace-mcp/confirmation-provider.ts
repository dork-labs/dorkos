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
 * ## These are wrappers, not a mechanism
 *
 * The token state machine lives in `services/core/approvals` (spec
 * `agent-trust` §3.3) — one approval primitive shared with capability tier
 * enforcement, so an operator sees marketplace installs and every other gated
 * action on the same cockpit card. This module only translates between that
 * primitive and the `ConfirmationResult` shape the marketplace tools speak.
 *
 * @module services/marketplace-mcp/confirmation-provider
 */
import type { PermissionPreview } from '../marketplace/types.js';
import { hashApprovalInput, type ApprovalService } from '../core/approvals/index.js';

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

/**
 * Payload for {@link ConfirmationProvider.requestInstallConfirmation}.
 *
 * Every field except `preview` is part of what the user actually agreed to, so
 * every field except `preview` is hashed into the approval's binding (see
 * {@link bindingOf}). Adding a field that reaches the mutation without adding it
 * here would let a retry change the effect the user approved.
 */
export interface ConfirmationRequest {
  packageName: string;
  marketplace: string;
  operation: ConfirmationOperation;
  /**
   * Uninstall only: also delete the package's saved data and secrets. This is
   * the difference between a reversible uninstall and an irreversible one, so it
   * is both shown to the user and bound into the approval.
   */
  purge?: boolean;
  /**
   * Install/uninstall only: the project whose scope is being changed. Absent
   * means the global scope. Bound so an approval for one project cannot be
   * redirected at another.
   */
  projectPath?: string;
  /**
   * Create-package only: the kind of package being scaffolded, which decides the
   * shape of what lands on disk. Free-text metadata (description, author,
   * categories) is deliberately NOT bound — it changes what the package says
   * about itself, not what happens to the user's machine.
   */
  packageType?: string;
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
   * The caller must restate what it is about to do: an approval is bound to one
   * package and one operation, so a token granted for installing A is refused
   * when presented for installing B.
   *
   * @param token - The token previously returned via `pending`.
   * @param req - The operation the caller is about to run. Must describe the
   *   same package and operation the token was issued for.
   */
  resolveToken(token: string, req: ConfirmationRequest): Promise<ConfirmationResult>;
}

/**
 * Confirmation provider that always returns `approved`. Used when
 * `process.env.MARKETPLACE_AUTO_APPROVE === '1'` or in unit tests that want
 * to skip the confirmation gate entirely.
 *
 * Auto-approval short-circuits the primitive rather than auto-granting through
 * it: writing a row per call would flood the cockpit and the Activity feed with
 * approvals nobody ever saw, in exactly the CI and eval runs the flag exists to
 * keep quiet.
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

/** Capability id each marketplace operation is gated as. */
const CAPABILITY_IDS: Record<ConfirmationOperation, string> = {
  install: 'marketplace.install',
  uninstall: 'marketplace.uninstall',
  'create-package': 'marketplace.create_package',
};

/**
 * The action a marketplace confirmation is bound to.
 *
 * Every value that reaches the mutation after the gate is hashed here, because
 * the binding is the whole guarantee: the user consented to one specific effect,
 * and a retry that changes any of these is a different effect. `purge` is the
 * sharpest case — approving a reversible uninstall must never license one that
 * deletes `.dork/data/` and `.dork/secrets.json`.
 *
 * Deliberately excludes the permission preview: the preview is derived (a fresh
 * resolve can legitimately produce different file lists) while these fields are
 * what the user actually agreed to.
 *
 * @param req - The confirmation request.
 * @returns The canonical subset an approval binds to.
 */
function bindingOf(req: ConfirmationRequest): { capabilityId: string; inputHash: string } {
  return {
    capabilityId: CAPABILITY_IDS[req.operation],
    inputHash: hashApprovalInput({
      packageName: req.packageName,
      marketplace: req.marketplace,
      operation: req.operation,
      purge: req.purge ?? false,
      projectPath: req.projectPath ?? null,
      packageType: req.packageType ?? null,
    }),
  };
}

/** Where an operation lands, for the card: a named project or the global scope. */
function scopeOf(req: ConfirmationRequest): string {
  return req.projectPath ? ` in ${req.projectPath}` : '';
}

/** Plain-language summary of a pending marketplace operation, for the card. */
function summaryOf(req: ConfirmationRequest): string {
  switch (req.operation) {
    case 'install':
      return `Install "${req.packageName}" from ${req.marketplace}${scopeOf(req)}`;
    case 'uninstall':
      return req.purge
        ? `Uninstall "${req.packageName}"${scopeOf(req)} and delete its saved data and secrets`
        : `Uninstall "${req.packageName}"${scopeOf(req)}, keeping its saved data`;
    case 'create-package':
      return `Create the ${req.packageType ?? 'new'} package "${req.packageName}" in ${req.marketplace}`;
  }
}

/**
 * Confirmation provider that issues single-use, action-scoped tokens for
 * external MCP clients, backed by {@link ApprovalService}.
 *
 * Flow:
 * 1. The agent calls `marketplace_install`; the provider records an approval and
 *    returns `{ status: 'pending', token }`.
 * 2. The approval appears on the operator's cockpit card, and they decide it by
 *    approval id through `POST /api/approvals/:id/grant|deny`. There is
 *    deliberately no decide-by-token path: the agent holds the token, so one
 *    would let a requester approve its own request.
 * 3. The agent re-calls the tool, which calls {@link resolveToken}; the first
 *    call after a decision spends the token, so a replay reports declined.
 *
 * Tokens that are never resolved expire on the primitive's window
 * (`APPROVAL_TTL_MS`), and expiry is checked when the token is presented — a
 * stale approval can never be honored.
 */
export class TokenConfirmationProvider implements ConfirmationProvider {
  /**
   * Build the provider over the shared approval primitive.
   *
   * @param approvals - The approval service that owns the token lifecycle.
   */
  constructor(private readonly approvals: ApprovalService) {}

  /**
   * Record a pending approval and return the token the agent retries with.
   *
   * The card's title and tier are resolved from the capability registry by
   * `ApprovalService`, not stated here — a requester cannot describe itself.
   *
   * @param req - The confirmation request payload.
   */
  async requestInstallConfirmation(req: ConfirmationRequest): Promise<ConfirmationResult> {
    const { capabilityId, inputHash } = bindingOf(req);
    const ticket = this.approvals.request({
      capabilityId,
      inputHash,
      summary: summaryOf(req),
    });
    return { status: 'pending', token: ticket.token };
  }

  /**
   * Resolve a previously issued token against the operation the caller is about
   * to run. A decided token is spent by this call, so every later attempt reports
   * `Unknown or expired token`; a token issued for a different package or
   * operation is refused without being spent.
   *
   * @param token - The token previously returned via `pending`.
   * @param req - The operation the caller is about to run.
   */
  async resolveToken(token: string, req: ConfirmationRequest): Promise<ConfirmationResult> {
    const result = this.approvals.consume(token, bindingOf(req));
    switch (result.outcome) {
      case 'granted':
        return { status: 'approved' };
      case 'pending':
        return { status: 'pending', token };
      case 'denied':
        return { status: 'declined', ...(result.reason ? { reason: result.reason } : {}) };
      case 'expired':
        return { status: 'declined', reason: 'Token expired' };
      case 'mismatched':
        return {
          status: 'declined',
          reason: 'This approval was granted for a different package or operation',
        };
      case 'consumed':
      case 'unknown':
        return { status: 'declined', reason: 'Unknown or expired token' };
    }
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
