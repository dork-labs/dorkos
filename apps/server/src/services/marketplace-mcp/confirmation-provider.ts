/**
 * Confirmation provider — gates marketplace mutation tools (install,
 * uninstall, create-package) behind explicit user approval.
 *
 * Two implementations cover the contexts in which an MCP marketplace tool may be
 * invoked:
 *
 * 1. {@link TokenConfirmationProvider} — for external MCP clients
 *    (Claude Code, Cursor, Codex). Issues short-lived single-use tokens; the
 *    user approves out-of-band in the DorkOS UI; the agent re-calls the tool
 *    with the token.
 * 2. {@link InAppConfirmationProvider} — wires a callback to the existing
 *    `InstallConfirmationDialog` from spec 03, for an in-process caller that
 *    wants one. No boot path constructs it today; it is exercised only by
 *    this module's own tests and `tool-install.test.ts`.
 *
 * ## There is no third one, and that is deliberate
 *
 * An always-approve implementation used to exist behind an environment
 * variable, for CI and evals. It was removed (DOR-501): a switch that turns a
 * consent gate off is a second code path nobody watches, and it made every test
 * that used it evidence about the switch rather than about the product.
 * Automation now answers the approval through the same routes a person uses —
 * `GET /api/approvals/pending` then `POST /api/approvals/:id/grant` — which is
 * both honest and a stronger test. Do not add one back.
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
import {
  describeDisclosedEffects,
  disclosedEffectsOf,
  type DisclosedEffects,
} from '../marketplace/disclosed-effects.js';
import { logger } from '../../lib/logger.js';

/** The kind of mutation a confirmation request is gating. */
export type ConfirmationOperation = 'install' | 'uninstall' | 'create-package';

/**
 * Result of a confirmation request, discriminated by `status`.
 *
 * - `approved` — the user consented; the caller may proceed.
 * - `declined` — the user refused; `reason` is an optional human-readable note.
 * - `pending` — the request is awaiting out-of-band approval; the caller must
 *   re-resolve the returned `token` later. `reason` is set only when this pending
 *   result REPLACED an approval that no longer covered the action — a stale token
 *   the provider re-asked for rather than honoring — so the caller can say why a
 *   second card appeared.
 */
export type ConfirmationResult =
  | { status: 'approved' }
  | { status: 'declined'; reason?: string }
  | { status: 'pending'; token: string; reason?: string };

/**
 * Payload for {@link ConfirmationProvider.requestInstallConfirmation}.
 *
 * Every field here is part of what the user actually agreed to, so every field
 * here is hashed into the approval's binding (see {@link bindingOf}) — `preview`
 * through the executable subset {@link disclosedEffectsOf} names, the rest
 * verbatim. Adding a field that reaches the mutation without adding it here would
 * let a retry change the effect the user approved.
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
  /**
   * Install only: everything the install would do, as the person was shown it.
   *
   * The EXECUTABLE part of it is bound into the approval — every hook command
   * string and every scheduled job's cron and permission mode (DOR-647). Those are
   * the facts the headline disclosure is made of since DOR-635, so a re-resolve
   * that changes them changes what the yes was about. The file lists, extensions,
   * secrets, dependencies and conflicts stay out; see {@link disclosedEffectsOf}
   * for the whole of that line and why it falls where it does.
   */
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
   * ## What it is actually set for, which is more than the line above implies
   *
   * `callerContext` (`marketplace-capabilities.ts`) sets this on `context.approval`
   * OR `context.trusted`. The first is the tier gate's spent approval and only
   * reaches `destructive` capabilities. The second is a caller that proved it may
   * DECIDE approvals — and it is not tier-scoped, so a trusted caller installing a
   * package (`marketplace.install` is tier `act`, gated by nothing upstream) skips
   * this provider entirely and no card is ever shown.
   *
   * That is the standing posture, not a regression, and it is deliberate as far as
   * it goes: a caller who can grant its own approval gains nothing from being asked.
   * It is written down here because the previous wording said "only ever set for
   * `destructive`", which is false, and a reader trusting it would conclude an
   * install always shows a card. Whether `trusted` should short-circuit an `act`
   * capability's own confirmation is a separate question from DOR-647's binding,
   * and is left to a follow-up rather than changed under it.
   */
  preApproved?: boolean;
}

/**
 * Generic confirmation provider that gates marketplace mutation tools. Each
 * concrete implementation chooses how the user actually consents — a
 * synchronous UI prompt, or an out-of-band token. Every one of them asks
 * someone; none of them is a way to not ask.
 */
export interface ConfirmationProvider {
  /**
   * Request user confirmation for an install/uninstall/create-package
   * operation. Implementations may surface a prompt synchronously (in-app UI)
   * or return a token for out-of-band approval (external MCP clients).
   *
   * @param req - The confirmation request payload.
   */
  requestInstallConfirmation(req: ConfirmationRequest): Promise<ConfirmationResult>;

  /**
   * Look up a previously issued confirmation token. Used when an external MCP
   * client re-calls `marketplace_install` after the user approved out-of-band.
   *
   * The caller must restate what it is about to do: an approval is bound to one
   * exact action, so a token granted for installing A does not license installing
   * B — nor the same package with a different marketplace, project, or purge
   * flag, nor a package that now declares different shell commands or scheduled
   * jobs than the preview the person read (DOR-647).
   *
   * @param token - The token previously returned via `pending`.
   * @param req - The operation the caller is about to run. Must describe the same
   *   action the token was issued for, field for field, INCLUDING a freshly built
   *   preview — the whole point is that a stale one cannot pass unnoticed.
   */
  resolveToken(token: string, req: ConfirmationRequest): Promise<ConfirmationResult>;
}

/** Capability id each marketplace operation is gated as. */
const CAPABILITY_IDS: Record<ConfirmationOperation, string> = {
  install: 'marketplace.install',
  uninstall: 'marketplace.uninstall',
  'create-package': 'marketplace.create_package',
};

/**
 * What one confirmation request binds to: the approval-service binding, plus the
 * executable content that went into it, kept alongside so a caller can say what a
 * package declares now without recomputing it.
 */
interface MarketplaceBinding {
  /** Capability the approval is scoped to. */
  capabilityId: string;
  /** Canonical hash of the action AND its disclosed executable content. */
  inputHash: string;
  /** What the preview disclosed, or `null` when the operation previews nothing. */
  disclosed: DisclosedEffects | null;
}

/**
 * The action a marketplace confirmation is bound to.
 *
 * Every value that reaches the mutation after the gate is hashed here, because
 * the binding is the whole guarantee: the user consented to one specific effect,
 * and a retry that changes any of these is a different effect. `purge` is the
 * sharpest case — approving a reversible uninstall must never license one that
 * deletes `.dork/data/` and `.dork/secrets.json`.
 *
 * It also binds the EXECUTABLE part of the permission preview — the hook command
 * strings and the scheduled jobs, via {@link disclosedEffectsOf} — because an
 * approval that attests to something the person never saw is a defect in the
 * approval's own contract (DOR-647). The rest of the preview stays out, and the
 * original reasoning survives intact for the part it was actually about: a fresh
 * resolve can legitimately produce different file lists, and re-asking over one
 * would teach a person to click past the card that matters.
 *
 * @param req - The confirmation request.
 * @returns The canonical subset an approval binds to, and what the preview
 *   disclosed, so a caller can name what a stale approval no longer covers.
 */
function bindingOf(req: ConfirmationRequest): MarketplaceBinding {
  const disclosed = disclosedEffectsOf(req.preview);
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
      // Absence is bound as absence here too: an operation that previews nothing
      // must not hash the same as one whose package declares nothing.
      disclosed,
    }),
    disclosed,
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

/** What each operation is called in a sentence a person reads. */
const OPERATION_NOUNS: Record<ConfirmationOperation, string> = {
  install: 'install',
  uninstall: 'uninstall',
  'create-package': 'package creation',
};

/**
 * Say why a token no longer covers what the caller is about to do, and what the
 * fresh card in its place is for.
 *
 * Written for whoever reads it next — the agent that retried, and the person it
 * relays to — so it names the two things that could have moved, states what the
 * package declares NOW, and says out loud that nothing happened. It cannot say
 * which of the two moved: the approval stores only a hash, so the disclosure a
 * person read is not recoverable at retry time, and guessing would be worse than
 * naming both.
 *
 * @param req - The operation the caller is about to run.
 * @param binding - Its binding, carrying what the current preview disclosed.
 * @returns One plain sentence pair explaining the re-ask.
 */
function staleApprovalReason(req: ConfirmationRequest, binding: MarketplaceBinding): string {
  const declares = binding.disclosed
    ? ` This one would install ${describeDisclosedEffects(binding.disclosed)}.`
    : '';
  return (
    `That approval does not cover this ${OPERATION_NOUNS[req.operation]} — either it was granted ` +
    `for a different action, or what the package declares has changed since it was read.` +
    `${declares} DorkOS has asked again; nothing on this machine has changed.`
  );
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
    let binding: MarketplaceBinding;
    try {
      binding = bindingOf(req);
    } catch (err) {
      if (err instanceof ApprovalInputNotBindableError) return unbindableRefusal(req, err);
      throw err;
    }
    return { status: 'pending', token: this.ask(req, binding) };
  }

  /**
   * Record one pending approval and return the token the agent retries with.
   *
   * Shared by the first ask and the re-ask a stale token triggers, so both put the
   * same card in front of the operator.
   *
   * @param req - The confirmation request being asked about.
   * @param binding - Its already-computed binding.
   * @returns The one-time token for the retry.
   */
  private ask(req: ConfirmationRequest, binding: MarketplaceBinding): string {
    const ticket = this.approvals.request({
      capabilityId: binding.capabilityId,
      inputHash: binding.inputHash,
      summary: summaryOf(req),
      ...(req.requestedBy ? { requestedBy: req.requestedBy } : {}),
    });
    return ticket.token;
  }

  /**
   * Resolve a previously issued token against the operation the caller is about
   * to run. A decided token is spent by this call, so every later attempt reports
   * `Unknown or expired token`.
   *
   * A token that does NOT cover this action — a different package, a different
   * scope, or a package that now declares different commands or scheduled jobs
   * than the preview the person read — is left unspent for what it WAS granted
   * for, and this call asks again for what is in front of it now (DOR-647). That
   * is the same answer the capability tier gate gives a mismatched token
   * (`wrong_action` in `tier-enforcement.ts`), and it is the whole point of
   * binding the disclosure: proceeding would run a command nobody read, and a bare
   * refusal would leave the operator with nothing to decide.
   *
   * @param token - The token previously returned via `pending`.
   * @param req - The operation the caller is about to run.
   */
  async resolveToken(token: string, req: ConfirmationRequest): Promise<ConfirmationResult> {
    let binding: MarketplaceBinding;
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
          status: 'pending',
          token: this.ask(req, binding),
          reason: staleApprovalReason(req, binding),
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
