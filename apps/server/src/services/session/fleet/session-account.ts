/**
 * Which account a session bills, before it has run a turn, and that account's
 * cached usage (spec `claude-account-fleet` §6 U, "Which account a session
 * bills, before any turn").
 *
 * - **Claude Code** answers by folder, because a folder IS an account: the
 *   folder this process last launched the session on, else the one its
 *   transcript lives under, else the one the launch ladder would pick from the
 *   agent and default rungs. The store maps the folder to a registered
 *   account, the ambient `default`, or a memory-only record.
 * - **Codex and OpenCode** have one account each: `default`.
 * - Any other runtime (test-mode) keeps no usage ledger, so it bills nothing
 *   this can show.
 *
 * Only the folder is resolved here; which account it names is asked of the
 * store on every read, so a registry change is picked up without invalidating
 * anything.
 *
 * @module services/session/fleet/session-account
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import {
  IMPLICIT_ACCOUNT_ID,
  LEDGER_RUNTIMES,
  type AccountUsage,
  type LedgerRuntime,
} from '@dorkos/shared/account-usage';
import type { AccountUsageStore } from '../../core/usage/account-usage-store.js';

/** The account a session bills, as resolved before a read. */
export interface SessionBilling {
  /** The session's runtime. */
  runtime: LedgerRuntime;
  /** Claude Code only: the folder the session runs in. */
  root?: string;
  /**
   * Claude Code only: true when the session bills per token (a stored API key
   * or DorkOS credits), so its `usage` is its own cost and never its folder's
   * subscription windows. Absent reads as per token: a subscription is only
   * assumed when the runtime says so.
   */
  perToken?: boolean;
}

/** A runtime that can name the folder a session runs and bills on (Claude Code). */
interface AccountAwareRuntime {
  accountRootForSession(sessionId: string, projectDir: string): Promise<string | null>;
  sessionBillsPerToken?(sessionId: string): Promise<boolean>;
}

function isAccountAware(runtime: unknown): runtime is AccountAwareRuntime {
  return (
    typeof runtime === 'object' &&
    runtime !== null &&
    typeof (runtime as AccountAwareRuntime).accountRootForSession === 'function'
  );
}

function isLedgerRuntime(type: string): type is LedgerRuntime {
  return (LEDGER_RUNTIMES as readonly string[]).includes(type);
}

/**
 * The account a session bills, or `null` for a runtime with no usage ledger.
 * Never throws: an account that cannot be resolved reads as the ambient one.
 *
 * @param runtime - The session's runtime.
 * @param sessionId - The session.
 * @param projectDir - The session's working directory, which keys Claude
 *   Code's transcript probe and agent manifest.
 */
export async function billingAccountFor(
  runtime: AgentRuntime,
  sessionId: string,
  projectDir: string
): Promise<SessionBilling | null> {
  if (!isLedgerRuntime(runtime.type)) return null;
  if (!isAccountAware(runtime)) return { runtime: runtime.type };
  const perToken = await runtime.sessionBillsPerToken?.(sessionId).catch(() => true);
  const billing: SessionBilling = {
    runtime: runtime.type,
    ...(perToken !== undefined ? { perToken } : {}),
  };
  const launched = runtime.getSessionAccount?.(sessionId);
  if (launched) return { ...billing, root: launched };
  try {
    const root = await runtime.accountRootForSession(sessionId, projectDir);
    // `null`: no account may work in the session's project, so nothing bills yet.
    return root === null ? billing : { ...billing, root };
  } catch {
    return billing;
  }
}

/**
 * The cached usage of the account `billing` names, from the store's memory, or
 * `null` when the store has no such account.
 *
 * @param store - The usage store.
 * @param billing - The session's account.
 */
export function peekBillingUsage(
  store: AccountUsageStore,
  billing: SessionBilling
): AccountUsage | null {
  if (billing.root !== undefined) return store.peekByRoot(billing.runtime, billing.root);
  return store.peek(billing.runtime, [IMPLICIT_ACCOUNT_ID])[0] ?? null;
}

/**
 * Whether two usage records are the same account: the same runtime and
 * registry id, or, for a memory-only folder (`accountId: null`), the same
 * folder. The rule a client applies an `account_usage` event by.
 *
 * @param a - One account's usage.
 * @param b - Another's.
 */
export function isSameAccount(a: AccountUsage, b: AccountUsage): boolean {
  if (a.runtime !== b.runtime) return false;
  if (a.accountId !== null || b.accountId !== null) return a.accountId === b.accountId;
  return a.path === b.path;
}

/**
 * The cached usage of the account a session bills, for a single-session read
 * (`GET /api/sessions/:id`), or `null` with no store or no ledger runtime.
 *
 * @param store - The usage store, when one is installed.
 * @param runtime - The session's runtime.
 * @param sessionId - The session.
 * @param projectDir - The session's working directory.
 */
export async function accountUsageForSession(
  store: AccountUsageStore | undefined,
  runtime: AgentRuntime,
  sessionId: string,
  projectDir: string
): Promise<AccountUsage | null> {
  if (!store) return null;
  const billing = await billingAccountFor(runtime, sessionId, projectDir);
  return billing ? peekBillingUsage(store, billing) : null;
}
