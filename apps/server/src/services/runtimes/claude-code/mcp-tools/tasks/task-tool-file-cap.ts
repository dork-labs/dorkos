/**
 * The task tools' side of M4 (DOR-3703): the task's own agent writing through
 * `tasks_update` re-attests its SKILL file, and lifts a cap a change made
 * outside the tools put on it.
 *
 * Only under every same-agent condition (`contentEditVouched`): its own task
 * and its own proposal, a chat whose folder vouches for it, a turn that read
 * no outside words, the task within its level. Never from a scheduled run, a
 * message a scheduled run sent to a chat, or a chat a scheduled run started
 * (M7, `startedByScheduledRun`). Any other writer's change to the file is a
 * change outside the vouch: the task's next run is capped.
 *
 * A lift answers the agent with what changed, fenced as untrusted data, and
 * tells the person with Undo (`agent-mode-undo.ts`). A lift the person could
 * not be told of is put back, and the cap stays.
 *
 * @module services/runtimes/claude-code/mcp-tools/tasks/task-tool-file-cap
 */
import type { Task } from '@dorkos/shared/types';
import type { McpToolDeps } from '../types.js';
import type { AgentModeCaller } from '../../../../tasks/agent-mode/agent-mode-decision.js';
import {
  attestationOf,
  attestWrittenBody,
  fileEditsRunCapped,
} from '../../../../tasks/agent-mode/file-cap/file-cap-rule.js';
import {
  bodyHash,
  readFileState,
  shortFileHash,
  type FileState,
} from '../../../../tasks/agent-mode/file-cap/file-hash.js';
import type { FileAttestation } from '../../../../tasks/agent-mode/agent-mode-record-field.js';
import { lineDiff } from '../../../../tasks/agent-mode/file-cap/line-diff.js';
import {
  CAP_KEPT_NOTE,
  CAP_LIFTED_NOTE,
  CAP_REVIEW_NOTE,
  DIFF_FENCE,
} from '../../../../tasks/agent-mode/file-cap/file-cap-copy.js';
import { FILE_CAP_ACTION } from '../../../../tasks/agent-mode/file-cap/run-cap.js';
import {
  liveRunOriginSources,
  turnStarterOf,
} from '../../../../tasks/agent-mode/agent-mode-run-origin.js';
import {
  postScheduleArmed,
  resolveScheduleArmedPayload,
} from '../../../../notifications/emitters/schedule-armed.js';
import {
  resolveAgentIdForPath,
  resolveAgentNameForId,
} from '../../../../mesh/agent-path-lookup.js';
import { UNNAMED_PROPOSER } from '../../../../notifications/emitters/schedule-park.js';
import { recordAudit } from '../../../../audit/audit-trail.js';
import { fenceUntrustedBlock } from '../../../shared/untrusted-fence.js';
import { contentEditVouched, recordToolAttestation } from './task-tool-mode.js';

/** What a write's reply carries about the file, when there is something to say. */
export interface ToolFileCapReply {
  /**
   * The cap a change outside the tools put on the task, lifted or kept: what
   * changed, and the hash of the file as that diff shows it, to accept it with.
   */
  fileChangedOutsideTools?: { note: string; diff?: string; hash?: string };
}

/**
 * The SKILL file as it was before the write, when the task is under M4.
 *
 * @param task - The task before the write.
 */
export async function fileStateBefore(task: Task): Promise<FileState | null> {
  return fileEditsRunCapped(task) ? readFileState(task.filePath) : null;
}

/**
 * Whether this caller may re-attest the task's file or lift its cap (M4, M7).
 *
 * @param deps - The tool dependencies.
 * @param existing - The task before the write.
 * @param caller - Who is writing, with whether a scheduled run started it.
 */
export async function mayAttestFile(
  deps: McpToolDeps,
  existing: Task,
  caller: AgentModeCaller
): Promise<boolean> {
  if (caller.scheduledRun === true || !caller.agentPath) return false;
  return contentEditVouched(deps, existing, caller);
}

/** Tell the person an agent lifted a cap, or answer `false`. */
async function announceLift(
  after: Task,
  change: { from: string; to: string; at: string; startedBy: string; setterPath: string }
): Promise<boolean> {
  try {
    const setterId = resolveAgentIdForPath(change.setterPath);
    const payload = await resolveScheduleArmedPayload(after);
    return await postScheduleArmed({
      ...payload,
      armedBy: (setterId ? resolveAgentNameForId(setterId) : undefined) ?? UNNAMED_PROPOSER,
      fileChange: {
        kind: 'lifted',
        fromHash: shortFileHash(change.from),
        toHash: shortFileHash(change.to),
        at: change.at,
        startedBy: change.startedBy,
      },
    });
  } catch {
    return false;
  }
}

/**
 * A task its own agent just created through the tools: its file attested from
 * the start as the bytes the agent wrote (M4), when the caller may vouch.
 *
 * @param deps - The tool dependencies.
 * @param task - The task as created.
 * @param caller - Who created it.
 */
export async function attestNewTask(
  deps: McpToolDeps,
  task: Task,
  caller: AgentModeCaller
): Promise<void> {
  if (!fileEditsRunCapped(task) || !(await mayAttestFile(deps, task, caller))) return;
  await attestWrittenBody(deps.taskStore!, task, task.prompt, 'agent', caller.agentPath);
}

/**
 * What a write attests when no outside change is in the way: the bytes it
 * wrote, while the file reads back to exactly them; or, when it wrote no body,
 * the file as the single read before the write found it, while that is the
 * prompt the task runs (M-D). Nothing otherwise, so the task stays capped.
 */
async function attestOwnWrite(
  store: NonNullable<McpToolDeps['taskStore']>,
  existing: Task,
  updated: Task,
  before: FileState | null,
  agentPath: string | undefined
): Promise<FileAttestation | null> {
  if (updated.prompt !== existing.prompt) {
    return attestWrittenBody(store, updated, updated.prompt, 'agent', agentPath);
  }
  if (!before || before.hash !== bodyHash(updated.prompt)) return null;
  const attestation = attestationOf(before, 'agent', agentPath);
  store.approvals.patchAgentModeColumn(updated.id, { fileAttest: attestation, fileCap: null });
  return attestation;
}

/**
 * After a `tasks_update` landed: re-attest the task's file when the caller
 * may (M4), and lift a cap a change outside the tools left, saying so.
 *
 * Two steps, as a person's Approve is (SB3): a call on a capped task keeps
 * the cap and answers what changed and its hash; only a call that names that
 * hash (`acceptFileHash`) lifts it. The hash and the diff come from the one
 * read before the write, so a write after that read is never attested unseen:
 * the task's row is set to that body too, and a file that moved on since runs
 * capped again. A call that rewrites the body replaces the change outright and
 * attests only the bytes it wrote. Answers what the reply adds, empty when
 * nothing about the file changed.
 *
 * @param deps - The tool dependencies.
 * @param existing - The task before the write.
 * @param updated - The task after it.
 * @param caller - Who wrote it.
 * @param before - The file before the write ({@link fileStateBefore}): the one read.
 * @param acceptFileHash - The hash the agent accepts the changed file by, when it does.
 */
export async function attestToolWrite(
  deps: McpToolDeps,
  existing: Task,
  updated: Task,
  caller: AgentModeCaller,
  before: FileState | null,
  acceptFileHash?: string
): Promise<ToolFileCapReply> {
  if (!fileEditsRunCapped(updated) || !(await mayAttestFile(deps, existing, caller))) return {};
  const store = deps.taskStore!;
  const column = store.approvals.agentModeColumnOf(updated.id);
  const attested = column.fileAttest;
  if (!attested || !before || before.hash === attested.hash) {
    await attestOwnWrite(store, existing, updated, before, caller.agentPath);
    return {};
  }
  const wroteBody = updated.prompt !== existing.prompt;
  const diff = fenceUntrustedBlock(lineDiff(attested.body ?? null, before.body), DIFF_FENCE).text;
  // Shown first, accepted only by its hash (SB3): an incidental call keeps the cap.
  if (!wroteBody && acceptFileHash !== before.hash) {
    return { fileChangedOutsideTools: { note: CAP_REVIEW_NOTE, diff, hash: before.hash } };
  }
  const accepted = wroteBody
    ? await attestWrittenBody(store, updated, updated.prompt, 'agent', caller.agentPath)
    : attestationOf(before, 'agent', caller.agentPath);
  if (!accepted) return { fileChangedOutsideTools: { note: CAP_KEPT_NOTE } };
  const at = new Date().toISOString();
  store.approvals.patchAgentModeColumn(updated.id, {
    fileAttest: accepted,
    fileCap: null,
    fileLift: { at, previous: attested, hash: accepted.hash },
  });
  // The run sends the body that was accepted, not one a later sync might fold in (M-D).
  if (!wroteBody && updated.prompt !== before.body) {
    store.updateTask(updated.id, { prompt: before.body });
  }
  const startedBy = turnStarterOf(caller, liveRunOriginSources(store));
  const label = updated.displayName ?? updated.name;
  const told = await announceLift(updated, {
    from: attested.hash,
    to: accepted.hash,
    at,
    startedBy,
    setterPath: caller.agentPath!,
  });
  if (!told) {
    store.approvals.patchAgentModeColumn(updated.id, { fileAttest: attested, fileLift: null });
    return { fileChangedOutsideTools: { note: CAP_KEPT_NOTE } };
  }
  recordAudit({
    action: FILE_CAP_ACTION,
    operation: 'modify',
    target: { type: 'task', id: updated.id, name: label },
    outcome: 'ok',
    change: [
      { field: 'attestedFileHash', before: attested.hash, after: accepted.hash },
      { field: 'liftedBy', after: 'own_agent' },
      { field: 'turnStartedBy', after: startedBy },
    ],
    summary: `Lifted the file cap on ${label}: its own agent accepted the changed file`,
  });
  // The task's content is vouched for too, where its mode was an agent's to hold (M1).
  if (column.attestation || updated.agentModeRecord?.mode === updated.permissionMode) {
    recordToolAttestation(deps, updated, caller, false, startedBy);
  }
  return { fileChangedOutsideTools: { note: CAP_LIFTED_NOTE, diff } };
}
