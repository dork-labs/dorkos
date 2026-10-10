/**
 * The audit domain of the Capability Registry (spec `audit-trail`).
 *
 * The record anyone in the space can read and check, person or agent:
 *
 * | Capability                | Tool               | What it answers                                         |
 * | ------------------------- | ------------------ | ------------------------------------------------------- |
 * | `audit.verify`            | `audit_verify`     | Has the log been edited? (hash chain walk)              |
 * | `audit.query`             | `audit_query`      | What happened, filtered, newest first                    |
 * | `audit.get`               | `audit_get`        | One event                                                |
 * | `audit.account_timeline`  | `account_timeline` | Everything one account did or had done to it             |
 * | `audit.transcript_read`   | `transcript_read`  | A session's transcript, when the caller may read it      |
 *
 * All five are `observe` with no permission area: reading the record is the
 * point of it (trusted by default: the safety net is a record anyone can read).
 * What a caller may SEE is decided by one rule, `visibility.ts` for events and
 * `session-visibility.ts` for transcripts, never per tool: an agent reads every
 * action and every agent's work, never a person's own private chat and never
 * an admins-only row; the owner of a one-person space reads everything.
 *
 * @module services/audit/audit-capabilities
 */
import { z } from 'zod';
import {
  AuditGetResultSchema,
  AuditQueryResultSchema,
  AuditQuerySchema,
  AuditTimelineQuerySchema,
  AuditVerifyQuerySchema,
  AuditVerifyResultSchema,
  TranscriptPageSchema,
  TranscriptReadQuerySchema,
  type TranscriptPage,
} from '@dorkos/shared/audit-schemas';
import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityInvocationContext,
} from '../core/capabilities/index.js';
import type { AuditLog } from './audit-log.js';
import type { AccountIds } from './account-ids.js';
import { OWNER_READER, type AuditReader } from './visibility.js';
import { canReadSession, type SessionVisibility } from './session-visibility.js';
import {
  readAuditEvent,
  readAuditQuery,
  readAuditTimeline,
  type ReadableSessions,
} from './audit-session-scrub.js';

declare module '../core/capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** Present when the server keeps an audit log; gates the `audit` domain. */
    auditDeps?: {
      /** The audit log. */
      log: Pick<AuditLog, 'verify' | 'query' | 'getWithLinks' | 'timeline'>;
      /** Names the calling agent as a stable account id. */
      accounts?: Pick<AccountIds, 'forAgentIdentity' | 'unidentified'>;
      /**
       * Who may read each of these sessions, in one lookup; an unknown session
       * is absent.
       */
      sessionVisibilities?: (
        sessionIds: readonly string[]
      ) => ReadonlyMap<string, SessionVisibility>;
      /** A page of a session's transcript, or `undefined` when it cannot be read. */
      readTranscript?: (
        sessionId: string,
        page: { offset: number; limit: number }
      ) => Promise<TranscriptPage | undefined>;
    };
  }
}

type AuditDeps = NonNullable<CapabilityDeps['auditDeps']>;

/**
 * Narrow the bag to the audit deps, throwing if the registry was composed
 * without them (a wiring bug, caught at boot by `assertDeps`).
 *
 * @param deps - The capability bag.
 */
function requireAuditDeps(deps: CapabilityDeps): AuditDeps {
  if (!deps.auditDeps) {
    throw new Error('Audit capability invoked without auditDeps in the registry bag.');
  }
  return deps.auditDeps;
}

/**
 * Who is reading, from the invocation context.
 *
 * An identified agent reads as itself. A call that presented an agent token
 * nobody could resolve, or an in-session call with no identity, is an agent
 * we cannot name: it reads as `unidentified`, which sees what any agent sees
 * and nothing private. Everything else (the app, a person's own API key or the
 * owner's local token over `/mcp`) is the owner of this one-person install.
 *
 * @param audit - The audit deps, for naming the agent.
 * @param context - The invocation context.
 */
export function readerFor(
  audit: AuditDeps,
  context: CapabilityInvocationContext | undefined
): AuditReader {
  if (context?.identity) {
    const accountId =
      audit.accounts?.forAgentIdentity(context.identity).accountId ?? 'unidentified';
    return { kind: 'agent', accountId };
  }
  if (context?.agentIdentityPresented || context?.mcpServer === 'in-session') {
    return { kind: 'agent', accountId: 'unidentified' };
  }
  return OWNER_READER;
}

/**
 * Whether `reader` may read a session's transcript. An unknown session is
 * private.
 *
 * @param audit - The audit deps, for the session lookup.
 * @param reader - Who is reading.
 * @param sessionId - The session.
 */
function mayReadSession(audit: AuditDeps, reader: AuditReader, sessionId: string): boolean {
  return readableTo(audit, reader)([sessionId]).has(sessionId);
}

/** The sessions `reader` may read, as a batch, for the row scrub: one lookup per page. */
function readableTo(audit: AuditDeps, reader: AuditReader): ReadableSessions {
  return (sessionIds) => {
    if (reader.kind === 'owner') return new Set(sessionIds);
    const visibilities = audit.sessionVisibilities?.(sessionIds);
    return new Set(
      sessionIds.filter((id) => canReadSession(reader, visibilities?.get(id) ?? 'participants'))
    );
  };
}

/** Both MCP servers, read-only, safe to repeat. */
const READ_TOOL = {
  servers: ['in-session', 'external'] as const,
  annotations: { idempotentHint: true },
};

/** The audit domain. */
export const auditDomain: CapabilityDomain = {
  name: 'audit',
  assertDeps: requireAuditDeps,
  capabilities: [
    defineCapability({
      id: 'audit.verify',
      title: 'Check the audit log',
      description:
        'Check that the DorkOS audit log has not been edited: walk its hash chain and recompute ' +
        'every link. Returns ok, how many rows were checked, the last row and its hash, and — if ' +
        'the chain is broken — the first row that does not check out and why. One call checks at ' +
        'most 100,000 rows; when more remain, call again with fromSeq set to nextFromSeq and ' +
        'prevHash set to lastHash.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: AuditVerifyQuerySchema,
      output: AuditVerifyResultSchema,
      surfaces: {
        mcp: { toolName: 'audit_verify', ...READ_TOOL, servers: [...READ_TOOL.servers] },
        http: { method: 'get', path: '/api/audit/verify' },
      },
      invoke: async (deps, input) => requireAuditDeps(deps).log.verify(input),
    }),
    defineCapability({
      id: 'audit.query',
      title: 'Read the audit log',
      description:
        'Read the DorkOS audit log: every action anyone took, person or agent, newest first. ' +
        'Filter by actorId (who did it), targetId (what it was done to), action (a prefix such as ' +
        '"config." or "runtime.tool_used"), operation, sessionId, and a since/until time window. ' +
        'Page backwards by passing nextBeforeSeq as beforeSeq. You see every action and every ' +
        "agent's work; a person's private chat and sign-in details are not shown to agents.",
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: AuditQuerySchema,
      output: AuditQueryResultSchema,
      surfaces: {
        mcp: { toolName: 'audit_query', ...READ_TOOL, servers: [...READ_TOOL.servers] },
        http: { method: 'get', path: '/api/audit' },
      },
      invoke: async (deps, input, context) => {
        const audit = requireAuditDeps(deps);
        const reader = readerFor(audit, context);
        return readAuditQuery(audit.log, input, reader, readableTo(audit, reader));
      },
    }),
    defineCapability({
      id: 'audit.get',
      title: 'Read one audit event',
      description:
        'Read one event from the DorkOS audit log by its id, with its links (the Activity row, ' +
        'the approval, the chat) so you can follow it to the transcript.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: z.object({ id: z.string().min(1).describe('The event id (a ULID).') }),
      output: AuditGetResultSchema,
      surfaces: {
        mcp: { toolName: 'audit_get', ...READ_TOOL, servers: [...READ_TOOL.servers] },
        http: { method: 'get', path: '/api/audit/{id}' },
      },
      invoke: async (deps, input, context) => {
        const audit = requireAuditDeps(deps);
        const reader = readerFor(audit, context);
        const found = readAuditEvent(audit.log, input.id, reader, readableTo(audit, reader));
        if (!found) {
          throw new CapabilityToolError({
            error: 'No audit event with that id.',
            code: 'NOT_FOUND',
          });
        }
        return found;
      },
    }),
    defineCapability({
      id: 'audit.account_timeline',
      title: 'Read one account’s history',
      description:
        'Everything one account did, had done to it, or had done on its behalf, newest first: ' +
        'the per-account timeline of the audit log. accountId is an agent id, a person’s ' +
        'account id, or the install id the owner had before making an account (the two are ' +
        'read as one). The same filters and paging as reading the whole log.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: AuditTimelineQuerySchema,
      output: AuditQueryResultSchema,
      surfaces: {
        mcp: { toolName: 'account_timeline', ...READ_TOOL, servers: [...READ_TOOL.servers] },
        http: { method: 'get', path: '/api/audit/accounts/{accountId}/timeline' },
      },
      invoke: async (deps, input, context) => {
        const audit = requireAuditDeps(deps);
        const reader = readerFor(audit, context);
        return readAuditTimeline(audit.log, input, reader, readableTo(audit, reader));
      },
    }),
    defineCapability({
      id: 'audit.transcript_read',
      title: 'Read a chat’s transcript',
      description:
        'Read the transcript of a chat: what was said and the tools used, with their inputs ' +
        'and results. You can read any agent’s work (team channel replies, scheduled runs, ' +
        'messages between agents, anything an app or extension started). A person’s own chat ' +
        'with an agent, a DM or a chat from Telegram or Slack, is private and answers ' +
        'TRANSCRIPT_PRIVATE; the actions taken in it are still in ' +
        'the audit log. Page with offset and limit; total says how long the transcript is.',
      tier: 'observe',
      area: null,
      areaNote: 'reading',
      input: TranscriptReadQuerySchema,
      output: TranscriptPageSchema,
      surfaces: {
        mcp: { toolName: 'transcript_read', ...READ_TOOL, servers: [...READ_TOOL.servers] },
      },
      invoke: async (deps, input, context) => {
        const audit = requireAuditDeps(deps);
        if (!mayReadSession(audit, readerFor(audit, context), input.sessionId)) {
          throw new CapabilityToolError({
            error:
              'That session is a person’s own chat, and it is private. Its actions are in the audit log.',
            code: 'TRANSCRIPT_PRIVATE',
          });
        }
        const page = await audit.readTranscript?.(input.sessionId, input);
        if (!page) {
          throw new CapabilityToolError({
            error: 'No session with that id could be read.',
            code: 'NOT_FOUND',
          });
        }
        return page;
      },
    }),
  ],
};
