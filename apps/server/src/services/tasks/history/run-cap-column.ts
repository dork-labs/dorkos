/**
 * The `refused_tools` column of a run, with the cap a changed SKILL file put on
 * it (DOR-3703, M4), kept without a schema change.
 *
 * An uncapped run stores what it always stored: a JSON array of the tool names
 * it was refused, or NULL. A capped run stores an object instead,
 * `{"cappedAt":"dontAsk","tools":[…]}`, so its history can say it ran capped
 * and which steps the cap refused. A reader older than this sees the object as
 * no list at all, which reads as a run from before the column, never as a
 * wrong list.
 *
 * @module services/tasks/history/run-cap-column
 */

/** What a run ran capped at. */
export type RunCap = 'dontAsk';

/** The column, read back. */
export interface RefusedToolsColumn {
  /** The refused tools, or `null` when none were recorded. */
  tools: string[] | null;
  /** Set when the run ran capped. */
  cappedAt: RunCap | null;
}

/** A value that is a list of tool names, or `null`. */
function toolsOf(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((name) => typeof name === 'string')
    ? (value as string[])
    : null;
}

/**
 * Read the column defensively: corrupted text costs only this field.
 *
 * @param raw - The column as stored: JSON text, or null.
 */
export function readRefusedToolsColumn(raw: string | null): RefusedToolsColumn {
  if (raw === null) return { tools: null, cappedAt: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const stored = parsed as { cappedAt?: unknown; tools?: unknown };
      return {
        tools: toolsOf(stored.tools),
        cappedAt: stored.cappedAt === 'dontAsk' ? 'dontAsk' : null,
      };
    }
    return { tools: toolsOf(parsed), cappedAt: null };
  } catch {
    return { tools: null, cappedAt: null };
  }
}

/**
 * The column to store for these tools and this cap.
 *
 * @param tools - The refused tools, or `null` when none were recorded.
 * @param cappedAt - The cap, or `null`.
 */
export function refusedToolsColumnOf(
  tools: string[] | null | undefined,
  cappedAt: RunCap | null | undefined
): string | null {
  if (cappedAt) return JSON.stringify({ cappedAt, tools: tools ?? null });
  return tools ? JSON.stringify(tools) : null;
}
