/**
 * M4 (DOR-3703, Security's ruling of Nov 3, round 6): a scheduled task's
 * SKILL file is held to the hash somebody vouched for, its attested hash.
 *
 * - The attested hash is its own stored value (`fileAttest` in the
 *   agent-mode column). Only the task's own agent writing through the task
 *   tools from an ordinary turn, or a person, writes it. The first read of a
 *   row that has none records the file as it is (M5), so nothing changes at
 *   upgrade. The file sync never writes it (M8).
 * - A body matches it when it is the same once only a formatter's spacing is
 *   taken out (DOR-5060, Security's ruling of Nov 22): a Prettier pass over
 *   the file is no change. The exact hash is kept beside it for the audit.
 * - A file that no longer hashes to it (a raw edit, another writer) does not
 *   park the task: its runs go on, capped at Don't ask (`run-cap.ts`).
 * - Which tasks: every task WITH an agent (Security's ruling of Nov 3, round
 *   6), whoever approved its content. A task with no agent keeps the park on
 *   a changed file, behind {@link NO_AGENT_TASKS_PARK_ON_RAW_EDIT}. A task
 *   another agent approved keeps its park too: that approval is bound to the
 *   file (Security ruling 7).
 * - With `tasks.agentModeControl` off nothing here applies, and a changed
 *   file parks every task as it always has.
 *
 * @module services/tasks/agent-mode/file-cap/file-cap-rule
 */
import type { Task, TaskFileReview } from '@dorkos/shared/types';
import type { TaskStore } from '../../task-store.js';
import { agentModeControlOn } from '../agent-mode-actions.js';
import { readAgentModeColumn, type FileAttestation } from '../agent-mode-record-field.js';
import {
  bodyHash,
  KEPT_BODY_CHARS,
  normalizedBodyHash,
  readFileState,
  type FileState,
} from './file-hash.js';

/**
 * Whether a changed SKILL file still parks a task with no agent (the ruling's
 * one open choice). `true` keeps today's park for those tasks; `false` caps
 * them at Don't ask like every other task.
 */
export const NO_AGENT_TASKS_PARK_ON_RAW_EDIT = true;

/** What the rule reads off a task or a row. */
export interface FileCapSubject {
  /** The agent it runs as, `null` for a task with no agent. */
  agentId: string | null | undefined;
  /** Its SKILL file, `null` or `''` for a task with none. */
  filePath: string | null | undefined;
  /** The hash another agent approved it as, when one did. */
  agentApprovalKey?: string | null;
}

/**
 * Whether a changed SKILL file caps this task's runs instead of parking it.
 *
 * @param task - See {@link FileCapSubject}.
 */
export function fileEditsRunCapped(task: FileCapSubject): boolean {
  if (!agentModeControlOn() || !task.filePath || task.agentApprovalKey) return false;
  return !!task.agentId || !NO_AGENT_TASKS_PARK_ON_RAW_EDIT;
}

/**
 * Whether a body is the one an attestation vouched for: the same bytes, or the
 * same once only a formatter's spacing is taken out (DOR-5060). An attestation
 * from before the normalized hash is read off the body it kept, and only while
 * that body still hashes to what it attested; without one, only the same bytes
 * match.
 *
 * @param body - The file's body, or the prompt the run sends.
 * @param attest - The attestation.
 */
export function bodyMatchesAttest(body: string, attest: FileAttestation): boolean {
  if (bodyHash(body) === attest.hash) return true;
  const kept = attest.body !== undefined && bodyHash(attest.body) === attest.hash;
  const norm = attest.normHash ?? (kept ? normalizedBodyHash(attest.body!) : undefined);
  return norm !== undefined && normalizedBodyHash(body) === norm;
}

/** Where the rule reads and writes its records. */
export type FileCapStore = Pick<TaskStore, 'approvals'>;

/**
 * The attestation a file state makes, its body kept when it is short enough
 * to show in a later diff.
 *
 * @param state - The file as read.
 * @param by - Who vouches for it.
 * @param agentPath - The agent's home, for `agent`.
 */
export function attestationOf(
  state: FileState,
  by: FileAttestation['by'],
  agentPath?: string
): FileAttestation {
  return {
    hash: state.hash,
    normHash: normalizedBodyHash(state.body),
    by,
    at: new Date().toISOString(),
    ...(agentPath ? { agentPath } : {}),
    ...(state.body.length <= KEPT_BODY_CHARS ? { body: state.body } : {}),
  };
}

/**
 * Attest the task's SKILL file as it is now and lift any cap it held: a
 * person approving the current file, or the task's own agent writing it
 * through the task tools. Answers the attestation, or `null` when the file
 * could not be read (nothing is recorded then).
 *
 * @param store - The store.
 * @param task - The task.
 * @param by - Who vouches for it.
 * @param agentPath - The agent's home, for `agent`.
 */
export async function attestTaskFile(
  store: FileCapStore,
  task: Pick<Task, 'id' | 'filePath'>,
  by: Exclude<FileAttestation['by'], 'baseline'>,
  agentPath?: string
): Promise<FileAttestation | null> {
  const state = await readFileState(task.filePath);
  if (!state) return null;
  const attestation = attestationOf(state, by, agentPath);
  store.approvals.patchAgentModeColumn(task.id, { fileAttest: attestation, fileCap: null });
  return attestation;
}

/**
 * Attest exactly the body a writer wrote, never what the file happens to hold
 * a moment later: only while the file reads back to those bytes. A file some
 * other writer changed in between is not attested (it stays capped). Answers
 * the attestation, or `null` when nothing was recorded.
 *
 * @param store - The store.
 * @param task - The task.
 * @param body - The body the writer wrote: the task's prompt as written.
 * @param by - Who vouches for it.
 * @param agentPath - The agent's home, for `agent`.
 */
export async function attestWrittenBody(
  store: FileCapStore,
  task: Pick<Task, 'id' | 'filePath'>,
  body: string,
  by: Exclude<FileAttestation['by'], 'baseline'>,
  agentPath?: string
): Promise<FileAttestation | null> {
  const state = await readFileState(task.filePath);
  if (!state || state.hash !== bodyHash(body)) return null;
  const attestation = attestationOf(state, by, agentPath);
  store.approvals.patchAgentModeColumn(task.id, { fileAttest: attestation, fileCap: null });
  return attestation;
}

/**
 * Whether this task's next run is capped by its file, read without writing
 * anything: under the rule, and its file or the prompt it runs no longer
 * hashes to the attested hash (M-D). With no attested hash yet, it is capped
 * unless the prompt it runs is the file and no sync folded that in (M-B).
 *
 * @param task - The task.
 * @param store - The store.
 */
export async function runsCappedForFile(
  task: Pick<Task, 'id' | 'agentId' | 'filePath' | 'prompt'>,
  store: FileCapStore
): Promise<boolean> {
  if (!fileEditsRunCapped(task)) return false;
  const column = store.approvals.agentModeColumnOf(task.id);
  const state = await readFileState(task.filePath);
  const attest = column.fileAttest;
  if (attest) {
    return (
      !state || !bodyMatchesAttest(state.body, attest) || !bodyMatchesAttest(task.prompt, attest)
    );
  }
  return !state || state.hash !== bodyHash(task.prompt) || column.syncedPrompt === state.hash;
}

/**
 * Whether the task's next run would be capped until a person approves its file
 * (`Task.fileCapNext`), read off the row alone, with no file read: capped now,
 * or no attestation covers the prompt it runs (one the sync folded in never
 * becomes a baseline, M-B). Nothing where the cap does not apply. With no cap
 * standing yet, also the review a person approves the file from (DOR-5060).
 *
 * @param row - The schedule row: its agent, file, prompt and agent-mode column.
 */
export function fileCapNextOf(
  row: FileCapSubject & { prompt: string; agentModeRecord: string | null }
): { fileCapNext?: boolean; fileReview?: TaskFileReview } {
  if (!fileEditsRunCapped(row)) return {};
  const column = readAgentModeColumn(row.agentModeRecord);
  const next =
    column.fileCap !== undefined ||
    (column.fileAttest
      ? !bodyMatchesAttest(row.prompt, column.fileAttest)
      : column.syncedPrompt === bodyHash(row.prompt));
  if (!next || column.fileCap) return { fileCapNext: next };
  const fileReview: TaskFileReview = {
    hash: bodyHash(row.prompt),
    previous: column.fileAttest?.body ?? null,
    current: row.prompt.length <= KEPT_BODY_CHARS ? row.prompt : null,
  };
  return { fileCapNext: next, fileReview };
}

/**
 * With `tasks.agentModeControl` switched off, whether a task's file changed
 * from what was attested while the switch was on (SB1): a cap stands on its
 * record, or its file or the prompt it runs no longer hashes to the attested
 * hash. Such a task parks at dispatch, as a changed file always did, instead of
 * running uncapped until the next sync parks it. False while the switch is on,
 * where the cap applies instead.
 *
 * @param task - The task, read fresh.
 * @param store - The store.
 */
export async function fileChangedWhileSwitchedOff(
  task: Pick<Task, 'id' | 'filePath' | 'prompt'>,
  store: FileCapStore
): Promise<boolean> {
  if (agentModeControlOn() || !task.filePath) return false;
  const column = store.approvals.agentModeColumnOf(task.id);
  if (column.fileCap) return true;
  const attest = column.fileAttest;
  if (!attest) return false;
  const state = await readFileState(task.filePath);
  return (
    !state || !bodyMatchesAttest(state.body, attest) || !bodyMatchesAttest(task.prompt, attest)
  );
}
