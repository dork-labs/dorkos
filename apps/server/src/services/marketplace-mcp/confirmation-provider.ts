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
import {
  hashApprovalInput,
  quoteSummaryValue,
  ApprovalInputNotBindableError,
  type ApprovalService,
} from '../core/approvals/index.js';
import { logger } from '../../lib/logger.js';

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
  /**
   * Which marketplace to act in. Absent means "search every enabled
   * marketplace, first match wins" — a materially different resolution from any
   * named source, so absence is bound as absence and never defaulted to a source
   * name the caller did not pin.
   */
  marketplace?: string;
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
  /**
   * Opaque label for the agent that asked, shown on the approval card so an
   * operator can see WHO wants this. Not part of the effect, so deliberately not
   * bound into the approval hash — a different agent asking for the same install
   * is the same install.
   */
  requestedBy?: string;
}

/**
 * What a marketplace tool learns about the caller behind one invocation.
 *
 * Threaded from the capability invocation context (spec `agent-trust` §3.2), so
 * the tools that already had a trust boundary of their own can cooperate with the
 * tier gate in front of them instead of duplicating it.
 */
export interface MarketplaceConfirmationContext {
  /** Label for the agent that asked, for the approval card. */
  requestedBy?: string;
  /**
   * A person ALREADY approved this exact invocation at the capability tier gate,
   * which spends an approval bound to the same arguments this handler is about to
   * act on. The handler must not ask again: one action, one card.
   *
   * Only ever set for capabilities the tier gate actually gates (`destructive`),
   * and only after {@link ApprovalService.consume} returned `granted`.
   */
  preApproved?: boolean;
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
   * exact action, so a token granted for installing A is refused when presented
   * for installing B — or for the same package with a different marketplace,
   * project, or purge flag.
   *
   * @param token - The token previously returned via `pending`.
   * @param req - The operation the caller is about to run. Must describe the same
   *   action the token was issued for, field for field.
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
      // Absence is bound as absence: an unnamed marketplace searches every
      // enabled source, which is not the same effect as a pinned one.
      marketplace: req.marketplace ?? null,
      operation: req.operation,
      purge: req.purge ?? false,
      projectPath: req.projectPath ?? null,
      packageType: req.packageType ?? null,
    }),
  };
}

/**
 * Refuse a request whose values cannot be bound to an approval.
 *
 * `hashApprovalInput` rejects anything canonicalization would flatten (a `Date`, a
 * `Set`, a class instance), because an approval bound to a hash that ignores part
 * of the action is worse than no approval. The tier gate turns that into a
 * structured `denied`; this path has to do the same rather than let the error out
 * as an opaque 500 — a person looking at a failed install has no way to guess that
 * a schema field is unbindable.
 *
 * Fails CLOSED: `declined` means the mutation does not run.
 *
 * @param req - The confirmation request that could not be bound.
 * @param err - Why it could not be, carrying the offending field path.
 * @returns A declined result carrying a reason the caller can act on.
 */
function unbindableRefusal(
  req: ConfirmationRequest,
  err: ApprovalInputNotBindableError
): ConfirmationResult {
  logger.error('[marketplace] confirmation request could not be bound to an approval', {
    operation: req.operation,
    path: err.path,
    err: err.message,
  });
  return {
    status: 'declined',
    reason:
      `DorkOS cannot pin down exactly what this ${req.operation} would do (${err.path} is not a ` +
      `value it can compare on a retry), so it refused instead of asking for an approval it could ` +
      `not enforce. Nothing was changed. This is a bug in the tool that asked, not something to ` +
      `approve around.`,
  };
}

/** Where an operation lands, for the card: a named project or the global scope. */
function scopeOf(req: ConfirmationRequest): string {
  return req.projectPath ? ` in ${quoteSummaryValue(req.projectPath)}` : '';
}

/**
 * Plain-language summary of a pending marketplace operation, for the card.
 *
 * Says only what the request actually pins. An install with no marketplace named
 * really does search every enabled source, so the card says that rather than
 * naming a default the code does not apply.
 *
 * Every caller-supplied value goes through {@link quoteSummaryValue}, which adds
 * the quotes, escapes the contents, and caps the length. Interpolating them raw
 * let a package name carrying its own quotes and connectives forge the rest of the
 * sentence — the same defect `describeGatedAttempt` had (`tier-enforcement.ts`).
 */
function summaryOf(req: ConfirmationRequest): string {
  const name = quoteSummaryValue(req.packageName);
  const marketplace = req.marketplace ? quoteSummaryValue(req.marketplace) : undefined;
  switch (req.operation) {
    case 'install':
      return `Install ${name} from ${marketplace ?? 'any enabled marketplace'}${scopeOf(req)}`;
    case 'uninstall':
      return req.purge
        ? `Uninstall ${name}${scopeOf(req)} and delete its saved data and secrets`
        : `Uninstall ${name}${scopeOf(req)}, keeping its saved data`;
    case 'create-package':
      return `Create the ${req.packageType ? quoteSummaryValue(req.packageType) : 'new'} package ${name} in ${marketplace ?? 'your personal marketplace'}`;
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
   * A request DorkOS cannot bind is `declined` rather than thrown (see
   * {@link unbindableRefusal}), so the mutation does not run and the caller learns
   * why.
   *
   * @param req - The confirmation request payload.
   */
  async requestInstallConfirmation(req: ConfirmationRequest): Promise<ConfirmationResult> {
    let binding: { capabilityId: string; inputHash: string };
    try {
      binding = bindingOf(req);
    } catch (err) {
      if (err instanceof ApprovalInputNotBindableError) return unbindableRefusal(req, err);
      throw err;
    }
    const { capabilityId, inputHash } = binding;
    const ticket = this.approvals.request({
      capabilityId,
      inputHash,
      summary: summaryOf(req),
      ...(req.requestedBy ? { requestedBy: req.requestedBy } : {}),
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
    let binding: { capabilityId: string; inputHash: string };
    try {
      binding = bindingOf(req);
    } catch (err) {
      if (err instanceof ApprovalInputNotBindableError) return unbindableRefusal(req, err);
      throw err;
    }
    const result = this.approvals.consume(token, binding);
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
          reason: 'This approval was granted for a different action',
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
