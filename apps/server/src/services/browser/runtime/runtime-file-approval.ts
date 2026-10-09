import { approvals, eq, type Db } from '@dorkos/db';
import type { BrowserBinding, BrowserGrant } from '@dorkos/shared/browser-schemas';
import { hashApprovalInput } from '../../core/approvals/index.js';
import type { CapabilityHandlerContext } from '../../core/capabilities/registry.js';
import { isServerPrincipal } from '../../connectors/principal/server-principal.js';
import type { RuntimeBrowserBirth } from './runtime-birth.js';

/** The whole human decision names the existing browser, current agent task and one file direction. */
export type RuntimeFileApprovalInput = Readonly<{
  binding: BrowserBinding;
  sessionId: string;
  operation: 'upload' | 'download';
}>;
/** Construction-private producer; selectors cannot create this receiver or substitute its runtime birth. */
export interface RuntimeFileApprovalSubject {
  birth: RuntimeBrowserBirth;
  current(): boolean;
  issue(
    binding: BrowserBinding,
    permissions: BrowserGrant['permissions'],
    expiresAt: string,
    originalApprovalCurrent: () => boolean
  ): BrowserGrant;
}

/** Spend an actual owner approval and retain its original SQL revocation predicate for later file IO. */
export function createRuntimeFileApprovals(options: {
  db: Db;
  enabled(): boolean;
  refuse(): Error;
  subject(binding: BrowserBinding): RuntimeFileApprovalSubject;
}) {
  const db = options.db,
    enabled = options.enabled.bind(options),
    refuse = options.refuse.bind(options),
    subject = options.subject.bind(options);
  let closed = false;
  const spent = new Map<string, number>();
  const live = () => {
    if (closed) return false;
    const actual = enabled();
    return actual && !closed;
  };
  const describe = (input: RuntimeFileApprovalInput): string =>
    `Browser: ${input.binding.browserId}\nTab: ${input.binding.tabId}\nAgent session: ${input.sessionId}\nPermission: ${input.operation === 'upload' ? 'send a file to this browser' : 'save a file from this browser'} for this agent’s current task`;
  return Object.freeze({
    describe,
    /** Only the consumed decision for this invocation can mint these separate file permissions. */
    issue(input: RuntimeFileApprovalInput, context: CapabilityHandlerContext): BrowserGrant {
      const principal = context.serverPrincipal,
        identity = context.identity,
        approval = context.approval;
      if (
        !live() ||
        !isServerPrincipal(principal) ||
        principal.claims.kind !== 'runtime' ||
        !identity ||
        identity.inactive ||
        context.trusted ||
        context.signal?.aborted ||
        approval?.via !== 'approval' ||
        context.sessionId !== input.sessionId ||
        principal.claims.canonicalSessionId !== input.sessionId ||
        principal.claims.agentPath !== identity.agentPath ||
        !approval.decidedByUserId
      )
        throw refuse();
      const now = Date.now();
      for (const [id, expiry] of spent) if (expiry <= now) spent.delete(id);
      if (spent.size >= 64 || spent.has(approval.approvalId)) throw refuse();
      // Reserve before any original session, principal or SQL receiver can reenter issuance.
      spent.set(approval.approvalId, Number.POSITIVE_INFINITY);
      const original = subject(input.binding),
        current = original.current.bind(original),
        issue = original.issue.bind(original),
        birth = original.birth,
        claims = principal.claims,
        change = describe(input),
        inputHash = hashApprovalInput({ input, change });
      if (
        !live() ||
        context.signal?.aborted ||
        !current() ||
        !live() ||
        birth.principal.claims.kind !== 'runtime' ||
        birth.principal.claims.bindingId !== claims.bindingId ||
        birth.principal.claims.canonicalSessionId !== claims.canonicalSessionId ||
        birth.principal.claims.agentId !== claims.agentId ||
        birth.principal.claims.agentPath !== claims.agentPath ||
        birth.sessionId !== input.sessionId ||
        context.approvedChange !== change ||
        approval.decidedByUserId !== birth.accountId ||
        !birth.accountCurrent()
      )
        throw refuse();
      let retired = false;
      const evaluate = () => {
        if (retired || !live() || context.signal?.aborted) return false;
        const alive = current();
        if (!alive || !live() || context.signal?.aborted) return false;
        const decision = db
          .select()
          .from(approvals)
          .where(eq(approvals.id, approval.approvalId))
          .get();
        const valid =
          !!decision &&
          decision.capabilityId === 'browser.file_access' &&
          decision.inputHash === inputHash &&
          decision.state === 'granted' &&
          !!decision.consumedAt &&
          decision.decidedByUserId === birth.accountId &&
          birth.accountCurrent() &&
          decision.requestedByPath === claims.agentPath &&
          Number.isFinite(Date.parse(decision.expiresAt)) &&
          Date.parse(decision.expiresAt) > Date.now();
        const originalCurrent = current();
        return valid && originalCurrent && live() && !context.signal?.aborted;
      };
      const approvalCurrent = () => {
        if (retired) return false;
        const valid = evaluate();
        if (!valid) retired = true;
        return valid && !closed && !context.signal?.aborted;
      };
      if (!approvalCurrent()) throw refuse();
      const decision = db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approval.approvalId))
        .get();
      if (!decision || !approvalCurrent()) throw refuse();
      const expiry = Math.min(Date.parse(decision.expiresAt), Date.parse(birth.expiresAt()));
      if (!Number.isFinite(expiry) || expiry <= Date.now() || !approvalCurrent()) throw refuse();
      spent.set(approval.approvalId, expiry);
      return issue(
        input.binding,
        ['browser.artifact', input.operation === 'upload' ? 'browser.upload' : 'browser.download'],
        new Date(expiry).toISOString(),
        approvalCurrent
      );
    },
    /** Fence retained approval readers synchronously; original grant cleanup stays in the session bank. */
    close(): void {
      closed = true;
      spent.clear();
    },
  });
}
