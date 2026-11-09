/** Durable history and ownership reads for scheduled conversations. */
import { and, desc, eq, isNotNull, pulseRuns, sessionMetadata, sql, type Db } from '@dorkos/db';

/** The run and session tables behind sticky-session decisions. */
export class RunSessionStore {
  constructor(private readonly db: Db) {}

  /** Read the id and runtime from the same most recent run. */
  latestStickyRun(taskId: string): { sessionId: string; runtime: string | null } | null {
    const row = this.db
      .select({ sessionId: pulseRuns.sessionId, runtime: pulseRuns.resolvedRuntime })
      .from(pulseRuns)
      .where(and(eq(pulseRuns.scheduleId, taskId), isNotNull(pulseRuns.sessionId)))
      // Millisecond timestamps can tie. Insertion order breaks that tie toward
      // the last run, so the next fire never resumes an older conversation.
      .orderBy(desc(pulseRuns.createdAt), sql`rowid DESC`)
      .limit(1)
      .get();
    return row?.sessionId ? { sessionId: row.sessionId, runtime: row.runtime ?? null } : null;
  }

  /** Read only recorded ownership: a working directory confers no authority. */
  getRunSessionAgentPath(sessionId: string): string | null {
    return (
      this.db
        .select({ agentPath: sessionMetadata.agentPath })
        .from(sessionMetadata)
        .where(eq(sessionMetadata.sessionId, sessionId))
        .get()?.agentPath ?? null
    );
  }
}
