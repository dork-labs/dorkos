/**
 * The audit trail as the rest of the server reaches it: one process-wide handle,
 * set once at startup (spec `audit-trail`).
 *
 * Choke points deep in the server (the MCP tool gate, config writes, the
 * marketplace transaction, auth hooks) cannot be handed an `AuditLog` through
 * every caller in between, so they reach it here, the same way the tier gate is
 * reached through `initCapabilityTierGate`. Before {@link initAuditTrail} runs —
 * a unit test that never sets one up, a script — {@link recordAudit} records
 * nothing and returns `undefined`, so no caller needs a guard.
 *
 * {@link recordAudit} fills in who acted and where from the current
 * `services/audit/audit-context.ts` scope, falling back to DorkOS itself when there is
 * none; a caller that knows better passes `actor` and `source` explicitly.
 *
 * @module services/audit/audit-trail
 */
import type { AuditEvent, AuditSource } from '@dorkos/shared/audit-schemas';
import { currentAuditActor, runWithAuditActor } from './audit-context.js';
import type { AccountIds } from './account-ids.js';
import type { AuditInput, AuditLog } from './audit-log.js';

/** The log and the id resolver, as wired at startup. */
export interface AuditTrail {
  /** The audit log. */
  log: AuditLog;
  /** The account-id resolver. */
  accounts: AccountIds;
}

let active: AuditTrail | undefined;

/**
 * Make the audit trail reachable server-wide. Called once at startup.
 *
 * @param trail - The log and the id resolver.
 */
export function initAuditTrail(trail: AuditTrail): void {
  active = trail;
}

/** Forget the audit trail. For tests. */
export function resetAuditTrail(): void {
  active = undefined;
}

/** The audit trail, or `undefined` before {@link initAuditTrail}. */
export function auditTrail(): AuditTrail | undefined {
  return active;
}

/** What a caller of {@link recordAudit} supplies; who and where default from scope. */
export type RecordAuditInput = Omit<AuditInput, 'actor' | 'source'> & {
  /** Who acted; defaults to the current scope's actor, else DorkOS. */
  actor?: AuditInput['actor'];
  /** Where; defaults to the current scope's surface and session, else `system`. */
  source?: AuditSource;
};

/**
 * Record one audit event, taking who and where from the current scope.
 *
 * @param input - What happened.
 * @returns The stored event, or `undefined` when there is no trail or the write failed.
 */
export function recordAudit(input: RecordAuditInput): AuditEvent | undefined {
  if (!active) return undefined;
  const scope = currentAuditActor();
  const { actor, source, ...rest } = input;
  return active.log.record({
    ...rest,
    actor: actor ?? scope?.actor ?? active.accounts.system(),
    source: source ?? {
      surface: scope?.surface ?? 'system',
      ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}),
    },
    ...((input.credential ?? scope?.credential)
      ? { credential: input.credential ?? scope?.credential }
      : {}),
  });
}

/**
 * Run `fn` as the named agent, so whatever it records names the agent rather
 * than whoever's scope it was called from.
 *
 * An IN-SESSION call with no identity (the session is not tied to an agent, or
 * its token could not be minted) still runs as an agent: it is named
 * `unidentified`, never the person, because the scope it would otherwise
 * inherit is the person whose message started the turn. Anywhere else, with
 * no identity, `fn` runs in the scope it already had (a request's own caller).
 *
 * @param identity - The calling agent, if one was resolved.
 * @param sessionId - The session the call came from, if any.
 * @param fn - The work.
 * @param opts - `inSession` when the call came through the in-session server.
 * @returns Whatever `fn` returns.
 */
export function runAsAgent<T>(
  identity: { agentPath: string; displayName: string } | undefined,
  sessionId: string | undefined,
  fn: () => T,
  opts: { inSession?: boolean } = {}
): T {
  if (!active || (!identity && !opts.inSession)) return fn();
  return runWithAuditActor(
    {
      actor: active.accounts.forAgentIdentity(identity),
      surface: 'mcp',
      ...(sessionId ? { sessionId } : {}),
    },
    fn
  );
}
