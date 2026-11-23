/**
 * The `refused_tools` column of a run, with the cap a changed SKILL file put on
 * it (DOR-3703, M4), kept without a schema change.
 *
 * An uncapped run stores what it always stored: a JSON array of the tool names
 * it was refused, or NULL. A capped run stores an object instead,
 * `{"cappedAt":"dontAsk","tools":[…],"file":{…}}`, so its history can say it
 * ran capped, which steps the cap refused, and which file at which two hashes
 * capped it (DOR-5060). A reader older than this sees the object as
 * no list at all, which reads as a run from before the column, never as a
 * wrong list.
 *
 * @module services/tasks/history/run-cap-column
 */

/** What a run ran capped at. */
export type RunCap = 'dontAsk';

/** The file that capped a run: its path, the attested hash and the hash it read as. */
export interface RunCapFile {
  /** The task's SKILL file. */
  path: string;
  /** The attested hash, or `none` when nothing was attested yet. */
  from: string;
  /** The file's hash, or `null` when it could not be read. */
  to: string | null;
}

/** The column, read back. */
export interface RefusedToolsColumn {
  /** The refused tools, or `null` when none were recorded. */
  tools: string[] | null;
  /** Set when the run ran capped. */
  cappedAt: RunCap | null;
  /** The file that capped it, on a capped run recorded since DOR-5060. */
  file: RunCapFile | null;
}

/** A stored file record, or `null` when it is not one. */
function fileOf(value: unknown): RunCapFile | null {
  if (!value || typeof value !== 'object') return null;
  const { path, from, to } = value as Record<string, unknown>;
  if (typeof path !== 'string' || typeof from !== 'string') return null;
  if (to !== null && typeof to !== 'string') return null;
  return { path, from, to };
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
  if (raw === null) return { tools: null, cappedAt: null, file: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const stored = parsed as { cappedAt?: unknown; tools?: unknown; file?: unknown };
      return {
        tools: toolsOf(stored.tools),
        cappedAt: stored.cappedAt === 'dontAsk' ? 'dontAsk' : null,
        file: fileOf(stored.file),
      };
    }
    return { tools: toolsOf(parsed), cappedAt: null, file: null };
  } catch {
    return { tools: null, cappedAt: null, file: null };
  }
}

/**
 * The column to store for these tools and this cap.
 *
 * @param tools - The refused tools, or `null` when none were recorded.
 * @param cappedAt - The cap, or `null`.
 * @param file - The file that capped it, kept only on a capped run.
 */
export function refusedToolsColumnOf(
  tools: string[] | null | undefined,
  cappedAt: RunCap | null | undefined,
  file?: RunCapFile | null
): string | null {
  if (cappedAt)
    return JSON.stringify({ cappedAt, tools: tools ?? null, ...(file ? { file } : {}) });
  return tools ? JSON.stringify(tools) : null;
}
