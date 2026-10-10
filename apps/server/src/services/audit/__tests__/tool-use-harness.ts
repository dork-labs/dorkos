/**
 * A test harness for the tool-use recorder (spec `audit-trail` PR3): feed a
 * turn's StreamEvents through a real `recordToolUse` wrapper over a fake
 * runtime, and read back the audit rows it wrote. Each runtime's fixture test
 * produces its events with that runtime's own mapper, then hands them here.
 *
 * @module services/audit/__tests__/tool-use-harness
 */
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, auditEvents, type Db } from '@dorkos/db';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { AuditLog } from '../audit-log.js';
import { AccountIds } from '../account-ids.js';
import { initAuditTrail } from '../audit-trail.js';
import { recordToolUse, resetRecordedToolCalls } from '../record-tool-use.js';
import { setAgentHomeRegistry } from '../../core/agent-identity/agent-home.js';

/** The registered agent the harness's turns run as, by default. */
export const SCOUT = { id: '01SCOUTAGENTULID0000000000', home: '/projects/scout' } as const;

/** Set up a real audit trail over a fresh database and return it. */
export function setUpAuditTrail(): Db {
  const db = createTestDb();
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: SCOUT.id,
      name: 'scout',
      displayName: 'Scout',
      runtime: 'claude-code',
      projectPath: SCOUT.home,
      registeredAt: now,
      updatedAt: now,
    })
    .run();
  setAgentHomeRegistry({
    isRegisteredHome: (dir) => dir === SCOUT.home,
    listRegisteredHomes: () => [SCOUT.home],
    managedWorkspaceOwner: () => null,
    roomsDir: null,
  });
  resetRecordedToolCalls();
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({ db, installId: 'inst-1', readOwnerAccount: () => null }),
  });
  return db;
}

/**
 * Run one turn of `events` through a wrapped fake runtime and drain it.
 *
 * @param events - What the runtime yields, in order.
 * @param options - The runtime's type, the turn's options, and an optional
 *   error to throw after the events.
 * @returns What the caller received, unchanged by the wrapper.
 */
export async function runTurn(
  events: readonly StreamEvent[],
  options: { runtime?: string; sessionId?: string; opts?: MessageOpts; throwAfter?: Error } = {}
): Promise<StreamEvent[]> {
  const fake = {
    type: options.runtime ?? 'claude-code',
    async *sendMessage(): AsyncGenerator<StreamEvent> {
      for (const event of events) yield event;
      if (options.throwAfter) throw options.throwAfter;
    },
  } as unknown as AgentRuntime;
  const received: StreamEvent[] = [];
  for await (const event of recordToolUse(fake).sendMessage(
    options.sessionId ?? 'session-1',
    'go',
    options.opts ?? { cwd: SCOUT.home }
  )) {
    received.push(event);
  }
  return received;
}

/**
 * The tool rows written, as the fields a test usually checks.
 *
 * @param db - The harness database.
 * @param action - Which rows: finished calls by default.
 */
export function toolRows(db: Db, action = 'runtime.tool_used') {
  return db
    .select()
    .from(auditEvents)
    .all()
    .filter((row) => row.action === action)
    .map((row) => ({
      tool: row.summary,
      targetType: row.targetType,
      targetId: row.targetId,
      outcome: row.outcome,
      operation: row.operation,
      source: JSON.parse(row.source) as Record<string, unknown>,
      actorKind: row.actorKind,
      actorId: row.actorId,
      actorName: row.actorName,
      links: row.links === null ? null : (JSON.parse(row.links) as Record<string, unknown>),
    }));
}
