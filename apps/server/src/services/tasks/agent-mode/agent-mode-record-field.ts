/**
 * The `agent_mode_record` column (DOR-3703): what agents did to a schedule's
 * mode, kept as three separate records in one JSON object.
 *
 * - `record`: the last time an agent set the mode or approved the task, so
 *   the task itself shows who, when, and old → new mode (Security ruling 8).
 *   The only part the task's API carries.
 * - `attestation`: the task's own agent vouching for it in place of a person
 *   (Security ruling of Nov 3, M1): who wrote, the level and marks of the turn,
 *   who started that turn, and the content it vouches for. Never a person's
 *   yes: nothing that reads a person's approval reads this.
 * - `personFloor`: the mode a person last held the task to, by Undo, a
 *   decline or lowering it (M2). An agent's raise above it asks a person.
 * - `promptUndo`: the prompt an own-agent prompt edit replaced, and the one it
 *   wrote, so a person's Undo can put it back while nothing changed it since.
 * - `syncedPrompt`: the hash of a prompt the file sync folded into the row, so
 *   the first read never takes it as a baseline (M-B).
 * - `fileAttest`, `fileCap` and `fileLift`: the SKILL file's attested hash, the
 *   cap a changed file put on the task's runs, and the cap lift an Undo can
 *   take back (M4, `file-cap/`). Only an attesting tool write or a person
 *   writes `fileAttest`; the file sync never does (M8).
 *
 * A row written before the column held an object reads as a record alone.
 *
 * @module services/tasks/agent-mode/agent-mode-record-field
 */
import {
  TaskAgentModeRecordSchema,
  type TaskAgentModeRecord,
  type TaskFileCap,
} from '@dorkos/shared/schemas';
import type { PermissionMode } from '@dorkos/shared/types';
import type { TurnPermissionLevel } from '@dorkos/shared/agent-runtime';

/** The task's own agent vouching for its task in place of a person (M1). */
export interface AgentAttestation {
  /** The writing agent's home. */
  agentPath: string;
  /** The chat it wrote from. */
  sessionId: string | null;
  /** Who started that chat's turn, as a person reads it (M6). */
  startedBy: string;
  /** The level the turn really ran at, when DorkOS recorded one. */
  turnLevel: TurnPermissionLevel | null;
  /** Whether the turn read words DorkOS cannot vouch for (always false when it vouches). */
  marked: boolean;
  /**
   * The content key the agent wrote and vouches for, or `null` when it only
   * ever set the mode: a mode change never vouches for content (M3).
   */
  contentHash: string | null;
  /** The mode it vouched for. */
  mode: PermissionMode;
  /** When. */
  at: string;
}

/** What an own-agent prompt edit replaced, for a person's Undo (Nov 3 ruling, M6). */
export interface PromptUndo {
  /** The prompt before the agent's edit. */
  previous: string;
  /** The prompt the agent wrote: Undo applies only while the task still holds it. */
  written: string;
  /** When. */
  at: string;
}

/** The SKILL file as somebody vouched for it (M4): its body's hash, and who. */
export interface FileAttestation {
  /** `sha256:<base64url>` of the body the task reads (`file-cap/file-hash.ts`). */
  hash: string;
  /** The task's own agent through the task tools, a person, or the first read (M5). */
  by: 'agent' | 'person' | 'baseline';
  /** When. */
  at: string;
  /** The agent's home, for `agent`. */
  agentPath?: string;
  /** The body itself, kept for the diff a cap lift shows; absent when too long. */
  body?: string;
}

/** The cap a changed SKILL file put on the task's runs (M4). */
export interface FileCapState {
  /** The attested hash. */
  from: string;
  /** The file's hash, or `null` when it could not be read. */
  to: string | null;
  /** When the cap first held for this pair: one notice per pair. */
  at: string;
  /** Whether only a person can lift it now (`file-cap/ordinary-turns.ts`). */
  needsPerson: boolean;
  /** The file's body as it was read when the cap held, kept for the person's diff; absent when too long. */
  current?: string;
}

/** A cap the task's own agent lifted, so a person's Undo can put it back (M4). */
export interface FileCapLift {
  /** When; the notice names it. */
  at: string;
  /** The attestation the lift replaced. */
  previous: FileAttestation;
  /** The hash it attested. */
  hash: string;
}

/** The column, read back. */
export interface AgentModeColumn {
  /** See the module TSDoc. */
  record?: TaskAgentModeRecord;
  /** See the module TSDoc. */
  attestation?: AgentAttestation;
  /** See the module TSDoc. */
  personFloor?: PermissionMode;
  /** See the module TSDoc. */
  promptUndo?: PromptUndo;
  /** See the module TSDoc. */
  fileAttest?: FileAttestation;
  /** See the module TSDoc. */
  fileCap?: FileCapState;
  /** See the module TSDoc. */
  fileLift?: FileCapLift;
  /**
   * The hash of a prompt the file sync folded into the row (M-B): such a prompt
   * is never taken as the first-read baseline. Not an attestation.
   */
  syncedPrompt?: string;
}

/** The parts of the column that are objects, read back as they were written. */
const OBJECT_PARTS = ['attestation', 'promptUndo', 'fileAttest', 'fileCap', 'fileLift'] as const;

/** One part of the column to write: a value replaces it, `null` removes it. */
export type AgentModeColumnPatch = {
  [K in keyof AgentModeColumn]?: AgentModeColumn[K] | null;
};

/**
 * The column read back. A row no agent touched, or text that no longer
 * parses, is empty.
 *
 * @param text - The stored JSON, or `null`.
 */
export function readAgentModeColumn(text: string | null | undefined): AgentModeColumn {
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const stored = parsed as Record<string, unknown>;
  const envelope = ['record', 'personFloor', 'syncedPrompt', ...OBJECT_PARTS].some(
    (k) => k in stored
  );
  const record = TaskAgentModeRecordSchema.safeParse(envelope ? stored.record : stored);
  const column: AgentModeColumn = record.success ? { record: record.data } : {};
  if (!envelope) return column;
  if (typeof stored.personFloor === 'string') {
    column.personFloor = stored.personFloor as PermissionMode;
  }
  if (typeof stored.syncedPrompt === 'string') column.syncedPrompt = stored.syncedPrompt;
  for (const key of OBJECT_PARTS) {
    const part = stored[key];
    if (part && typeof part === 'object') Object.assign(column, { [key]: part });
  }
  return column;
}

/**
 * The column with one patch applied, as written; `null` when nothing is left.
 *
 * @param text - The stored JSON, or `null`.
 * @param patch - What to set or remove.
 */
export function patchAgentModeColumn(
  text: string | null | undefined,
  patch: AgentModeColumnPatch
): string | null {
  const next: Record<string, unknown> = { ...readAgentModeColumn(text) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length > 0 ? JSON.stringify(next) : null;
}

/**
 * What the task's row shows of a cap (M4): when, whether a person must act,
 * and the diff they approve from, bound to the hash it shows.
 *
 * @param cap - The stored cap.
 * @param previous - The attested body, when it was kept.
 */
function fileCapView(cap: FileCapState, previous: string | null): TaskFileCap {
  return {
    at: cap.at,
    needsPerson: cap.needsPerson,
    hash: cap.to,
    previous,
    current: cap.current ?? null,
  };
}

/**
 * The record the task's API carries, and the cap a changed file put on it, or
 * nothing: the attestations, the hashes and the floor stay on the server.
 *
 * @param text - The stored JSON, or `null`.
 */
export function withAgentModeRecord(text: string | null | undefined): {
  agentModeRecord?: TaskAgentModeRecord;
  fileCap?: TaskFileCap;
} {
  const { record, fileCap, fileAttest } = readAgentModeColumn(text);
  const attestedBody = fileAttest?.body ?? null;
  return {
    ...(record ? { agentModeRecord: record } : {}),
    // What the task's row shows of a cap (M4): when, and whether a person must act.
    ...(fileCap ? { fileCap: fileCapView(fileCap, attestedBody) } : {}),
  };
}

/**
 * A record as handed to the store: who, when, and the mode before and after.
 *
 * @param record - The record, without a name (names are resolved when read).
 */
export function agentModeRecordText(record: Omit<TaskAgentModeRecord, 'agentName'>): string {
  return JSON.stringify(record);
}
