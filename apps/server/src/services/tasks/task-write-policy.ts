/**
 * Which fields of a scheduled task an AGENT may write (DOR-504).
 *
 * A scheduled task is a standing grant of a different kind: a prompt that fires
 * later, on its own trigger, with nobody watching. Two of its fields decide how
 * much that unattended run may do, and both were writable by the agent surface:
 *
 * - `permissionMode` — the runtime's safety prompts. `bypassPermissions` turns
 *   them off. An agent that is itself subject to prompts could hand a future run
 *   a mode it does not have, and `tasks_update` could rewrite the prompt in the
 *   same call, so an already-approved schedule became a different, unprompted one.
 * - `status` — `pending_approval → active` IS the approval. It is what the
 *   Approve button in the cockpit sends (`TaskRow.tsx`), and an agent-created
 *   schedule is parked at `pending_approval` precisely so a person has to send
 *   it. A caller that can set the field can approve its own request.
 *
 * The parking half of that sentence used to be true of the MCP tool only. Both
 * store insert paths hardcode `status: 'active'`, and `tasks_create` patched it
 * afterwards in the TOOL HANDLER — so `POST /api/tasks`, which is what
 * `dorkos task create` calls, armed a live cron task for the same agent. Both
 * doors now park on the same trust answer, in the one create sequence they share
 * (`services/tasks/lifecycle/create-task.ts`).
 *
 * This module is the classification, and it is deliberately the same shape as
 * `core/operator/config-write-policy.ts`: a table with a verdict per field, the
 * operator-only set derived from the table so the two cannot drift, and one
 * function that tells a caller which fields a write body reached for. Read that
 * module first — the reasoning there is the reasoning here, one level down.
 *
 * It also answers the adjacent question, added by DOR-1568: what happens to a
 * field neither schema has ever heard of. Both doors used to drop those in
 * silence and report success, so a caller could not tell a change that landed
 * from one that evaporated. {@link refuseUnknownTaskUpdateFields} refuses them
 * instead, and gives re-homing (`target`, `agentId`) its own answer because it is
 * the one people actually try.
 *
 * ## How the two surfaces use it, and why they use it differently
 *
 * - The MCP tools (`tasks_create`, `tasks_update`, on BOTH servers) refuse
 *   unconditionally. That is not a shortcut around identifying the caller, it is
 *   the honest reading of the surface: an MCP tool call IS the agent surface, so
 *   the fact is structural and there is no header to omit. `config_patch` refuses
 *   operator-only paths the same way, for the same reason.
 * - `POST /api/tasks` and `PATCH /api/tasks/:id` refuse unless the caller clears
 *   `trustedCaller`, exactly as `PATCH /api/config` does. The cockpit's own
 *   Approve button legitimately writes `status` through that route, and under the
 *   default `local-trust` posture nothing tells the cockpit apart from any other
 *   loopback caller. The divergence that creates is stated in `routes/config.ts`
 *   and is the same one here.
 *
 * ## What this does not cover, said plainly
 *
 * A task's permission mode also arrives from two places that are not a caller
 * supplying a field. Neither is closed HERE, because a per-caller field policy
 * is the wrong mechanism for content — both are closed on the content path
 * instead, by one rule in `tasks/schedule-permission-clamp.ts`:
 *
 * - The SKILL.md `permissions:` frontmatter on disk. The watcher and the
 *   reconciler sync whatever is in the file (`task-file-watcher.ts`,
 *   `task-reconciler.ts`), live. Anything that can write a project file can set
 *   it — and that bar is LOWER than it sounds: an agent already running in
 *   `acceptEdits` writes that file with no prompt and no shell. Do not read this
 *   as only the shell-access adversary of `approvals/decision-authority.ts`.
 *   CLOSED, and the invariant is worth stating exactly, because the exception is
 *   where the risk lives: `TaskStore.upsertFromFile` refuses a file-declared
 *   `bypassPermissions` and logs the downgrade, so **a file can never INTRODUCE
 *   one**. A file may only KEEP a bypass already in the row, and only while that
 *   row is `active` AND still holds the same prompt and cron the file carries —
 *   so **a kept bypass is bound to an un-retired task doing the work a person
 *   approved**, never to a path. Rewriting the body under a kept grant clamps;
 *   dropping a file back where a paused task's row still sits clamps. Only a
 *   caller that cleared the bar above can have put the bypass in the row to
 *   begin with, and the cockpit writes that decision straight back into the
 *   file, which is the whole reason the exception exists.
 * - A Shape package manifest declaring a schedule with a `permissionMode`
 *   (`shapes/apply-shape.ts` → `shapes/shape-schedule-service.ts`). There the
 *   field comes from installed package CONTENT, not from the caller, so refusing
 *   it per-caller would be the wrong control — the right one is on what a Shape
 *   may declare. CLOSED by DOR-607, in that shape: `apply-shape.ts` clamps a
 *   manifest-declared `bypassPermissions` back to `acceptEdits` and warns the
 *   operator, and a manifest can no longer declare that its schedule starts
 *   enabled by default either.
 *
 * ## The cookie bar, under login-on (DOR-1569)
 *
 * A cron task carrying `bypassPermissions` is a standing grant of the same
 * character as `approvals.standingGrants`: it keeps saying yes, on its own, for
 * as long as it is armed. So `clearsTheAgentBar` (in `routes/tasks.ts`) composes
 * `requireOperatorCookieUnderLogin` — the SAME second bar the approval, config,
 * and extension-approval routes run — before the agent bar. Under login-on that
 * refuses every credential but a session cookie, so a per-user API key no longer
 * clears the bar: an agent that reads the operator's key off disk and drops its
 * `X-DorkOS-Agent` header can no longer un-clamp `bypassPermissions` or arm a
 * live cron without approval.
 *
 * It is the `...UnderLogin` half, NOT the full `requireOperatorCookie` (which
 * refuses OUTRIGHT when login is off). With login off — the shipped default —
 * this bar allows, the cockpit's own task form keeps working, and nothing
 * changes: the residual there is the documented DOR-505 one, closed only by
 * turning login on. The honest summary: for tasks the guarantee is now "a named
 * agent cannot, and under login-on only a proven person can". This answers, for
 * tasks, the DOR-553 question the earlier note deferred.
 *
 * @module services/tasks/task-write-policy
 */
import { UpdateTaskRequestSchema } from '@dorkos/shared/schemas';

/**
 * Whether an agent may write one field of a scheduled task.
 *
 * - `agent-writable` — what the task does. An agent may change it on the user's
 *   word, and the schedule still lands at `pending_approval` for a person to see.
 * - `operator-only` — how much the task is allowed to do without asking, or
 *   whether it is allowed to run at all. The agent surface refuses it and the
 *   person sets it in DorkOS.
 */
export type TaskFieldWriteAccess = 'agent-writable' | 'operator-only';

/**
 * Every caller-supplied field of a task write, classified for the AGENT surface.
 *
 * Keys are the union of `CreateTaskRequestSchema` and `UpdateTaskRequestSchema`
 * and must match those schemas exactly in both directions: the drift guard in
 * `__tests__/task-write-policy.test.ts` asserts it, so adding, renaming, or
 * removing a task write field fails the build until this table carries a
 * deliberate verdict for it.
 */
export const TASK_WRITE_POLICY = {
  name: 'agent-writable',
  displayName: 'agent-writable',
  description: 'agent-writable',
  prompt: 'agent-writable',
  cron: 'agent-writable',
  timezone: 'agent-writable',
  // Which agent (or `global`) the task is filed under. Create-only, and it picks
  // a project the caller can already reach.
  target: 'agent-writable',
  // Turning a schedule on and off. It cannot promote one past its approval:
  // `enabled: true` on a `pending_approval` task still does not run it, because
  // the scheduler registers on `enabled && status === 'active'`. NOTE: that
  // reasoning is about the `pending_approval` gate. An operator-DISABLED but
  // already-approved task (`enabled: false, status: 'active'`) is re-armed by an
  // agent flipping `enabled` back on — but it then runs the operator's OWN
  // unchanged prompt, so it is a nuisance, not an escalation, and `enabled` stays
  // agent-writable. Changing WHAT it runs is the escalation, and that is clamped
  // at `PATCH /api/tasks/:id` (prompt/cron/name), not here.
  enabled: 'agent-writable',
  // A CAP on how long a run may take. Raising it makes a run longer, not more
  // permitted, so it is not an escalation. See the module TSDoc in
  // `mcp-tools/task-tools.ts` for the separate fact that `tasks_create` accepts
  // this argument and ignores it.
  maxRuntime: 'agent-writable',
  // Whether runs resume one session or start fresh each time (DOR-1571). A
  // behavior choice, not a power one: sticky grants no capability an isolated run
  // lacks, and a sticky schedule an agent proposes still parks for approval like
  // any other. So an agent may set it on the user's word, same as `enabled`.
  sticky: 'agent-writable',
  // The case FOR the schedule, in the proposer's own words (DOR-1394). Writable
  // by definition: it is the agent's own sentence, and the whole point is that
  // an agent must supply it. An operator-only verdict here would refuse every
  // proposal that did what it was asked to do.
  reason: 'agent-writable',
  // WHICH backend does the work, and how hard it thinks (DOR-1615/DOR-1347).
  // Not a power choice: every runtime here runs under the SAME
  // `permissionMode`, which stays operator-only below, so moving a task from
  // Claude Code to Codex changes who executes the prompt, never what the run is
  // allowed to do. An agent that can already write the `prompt` — the thing
  // that decides what actually happens — can do far more than pick a runtime,
  // and an agent-proposed schedule still parks for approval like any other.
  //
  // The one thing an agent CAN do with these is name a runtime that is not
  // turned on. That fails the run loudly with a message naming it
  // (`resolve-run-execution.ts`), which is a visible broken task rather than a
  // quiet escalation — deliberately, and the reason the resolver never falls
  // back to another runtime.
  runtime: 'agent-writable',
  model: 'agent-writable',
  effort: 'agent-writable',

  // The runtime's safety prompts, for a run nobody is watching.
  permissionMode: 'operator-only',
  // `pending_approval → active` is the approval itself.
  status: 'operator-only',
} as const satisfies Record<string, TaskFieldWriteAccess>;

/** The `operator-only` fields, derived from the table so the two cannot drift. */
export const OPERATOR_ONLY_TASK_FIELDS: readonly string[] = Object.entries(TASK_WRITE_POLICY)
  .filter(([, access]) => access === 'operator-only')
  .map(([field]) => field);

/** The `error` field every operator-only task refusal carries. */
export const OPERATOR_ONLY_TASK_ERROR = 'Only a person can decide how a scheduled task runs';

/** The machine-readable code every operator-only task refusal carries. */
export const OPERATOR_ONLY_TASK_CODE = 'operator_only_task_field';

/**
 * The refusal an agent reads when it tries to run a scheduled task on demand
 * (DOR-1481).
 *
 * Running a task now is not a FIELD, so it has no row in the table above — but
 * it is the same decision the table is about, reached through a different door.
 * `POST /api/tasks/:id/trigger` had no caller check at all, which made the
 * parking on create decorative: an agent could propose a schedule, watch it
 * park at `pending_approval`, and then trigger it anyway.
 *
 * Written for the model, like {@link describeOperatorOnlyTaskRefusal}: it says
 * what did not happen, why, and what to do instead, because a model that is
 * only told "no" tries again.
 */
export const OPERATOR_ONLY_TRIGGER_REFUSAL =
  "DorkOS did not run this task. Whether a scheduled task runs is the person's to decide, " +
  'not yours — and that goes double for one still waiting to be approved, since running it ' +
  'now would do most of what approving it would allow. Ask the person to open the task in ' +
  'DorkOS and run it there.';

/**
 * Find the operator-only fields a task write body reaches for.
 *
 * Presence is what counts, not the value. A caller that sends
 * `permissionMode: null` reached for the field just as much as one that sent
 * `bypassPermissions`, and answering "that one was harmless" would mean this
 * guard has an opinion about values, which it deliberately does not.
 *
 * Call this on the RAW body, before Zod parses it and before the route resolves
 * an omitted `permissionMode` from the operator's own trust stop
 * (`services/tasks/scheduled-run-power.ts`). Read after either step, the key is
 * present on every create and this function would refuse them all. The schema
 * used to supply that key with a hardcoded `'acceptEdits'` default; the default
 * is gone and the ladder replaced it, so the ordering rule is the same one for a
 * new reason.
 *
 * @param body - The write body a caller supplied (any shape; a non-object
 *   reaches for nothing).
 * @returns The offending field names, sorted, each named once. Empty when the
 *   body is clean.
 */
export function findOperatorOnlyTaskFields(body: unknown): string[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return [];
  const keys = new Set(Object.keys(body));
  return OPERATOR_ONLY_TASK_FIELDS.filter((field) => keys.has(field)).sort();
}

/**
 * Every field `PATCH /api/tasks/:id` and `tasks_update` accept.
 *
 * Read from the request schema rather than restated, so a field added there is
 * accepted here on the same commit and cannot become an accidental refusal.
 */
const UPDATABLE_TASK_FIELDS: readonly string[] = Object.keys(UpdateTaskRequestSchema.shape).sort();

/**
 * The fields that decide WHERE a task lives. Set once, at create, and never by
 * an update (DOR-1568).
 *
 * `target` is what `POST /api/tasks` and `tasks_create` take; `agentId` is what
 * the resulting row carries. Neither is in the update schema, so before this
 * both were STRIPPED in silence: `parseBody` uses a non-strict `z.object`, and
 * the MCP SDK drops an argument the tool never declared. An agent that tried to
 * file its own task under itself was told the update succeeded and nothing had
 * changed — which is how a file-less orphan came to be adopted by nobody.
 */
const IMMUTABLE_TASK_FIELDS: readonly string[] = ['agentId', 'target'];

/** The `error` every unknown-or-immutable update-field refusal carries. */
const UNKNOWN_TASK_FIELD_ERROR = 'DorkOS does not know how to change that on a task';

/** The machine-readable code every unknown-or-immutable update-field refusal carries. */
const UNKNOWN_TASK_FIELD_CODE = 'unknown_task_field';

/** A whole-call refusal, in the shape both the route and the MCP tools answer with. */
export interface TaskFieldRefusal {
  /** The one-line summary. */
  error: string;
  /** The machine-readable code. */
  code: string;
  /** Which fields stopped the call, sorted. */
  fields: string[];
  /** The paragraph a person or a model reads. */
  message: string;
}

/**
 * Refuse an update that names a field this surface cannot change — or return
 * `null` to let it through (DOR-1568).
 *
 * ## Why refusing beats stripping
 *
 * Both doors used to strip quietly and answer 200. A caller cannot tell a change
 * that landed from one that evaporated, so it believes the wrong thing about its
 * own task and acts on it — the exact failure `findOperatorOnlyTaskFields` exists
 * to prevent, one class down: not "you may not", but "there is no such thing".
 *
 * The check reads the RAW body, before Zod, for the reason the operator-only
 * guard does: after parsing there is nothing left to see. Callers that pass
 * arguments alongside the body (`tasks_update` carries `id`) strip those first.
 *
 * @param body - The update body a caller supplied; a non-object names nothing.
 * @returns The refusal envelope, or `null` when every named field is updatable.
 */
export function refuseUnknownTaskUpdateFields(body: unknown): TaskFieldRefusal | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = Object.keys(body)
    .filter((key) => !UPDATABLE_TASK_FIELDS.includes(key))
    .sort();
  if (fields.length === 0) return null;
  return {
    error: UNKNOWN_TASK_FIELD_ERROR,
    code: UNKNOWN_TASK_FIELD_CODE,
    fields,
    message: describeUnknownTaskUpdateRefusal(fields),
  };
}

/**
 * The refusal a caller reads when it named a field an update cannot change.
 *
 * Re-homing gets its own paragraph because it is the one people actually try, and
 * "unknown field" would be a true sentence that teaches nothing: a task IS filed
 * under an agent, the caller is asking a reasonable question, and the honest
 * answer is that the filing is decided at create and moving it means making it
 * again. Everything else gets the list of fields that do work, because a model
 * told only "no" tries again.
 *
 * @param fields - The offending fields, from {@link refuseUnknownTaskUpdateFields}.
 * @returns One paragraph, written for whoever reads it.
 */
function describeUnknownTaskUpdateRefusal(fields: readonly string[]): string {
  const rehoming = fields.filter((field) => IMMUTABLE_TASK_FIELDS.includes(field));
  const unknown = fields.filter((field) => !IMMUTABLE_TASK_FIELDS.includes(field));
  const parts = [`DorkOS changed nothing — not one field of this task.`];
  if (rehoming.length > 0) {
    parts.push(
      `A task is filed under one agent (or under none at all) when it is created, and it stays ` +
        `there: ${rehoming.join(', ')} cannot be changed afterwards, because the task's file ` +
        `lives in that agent's folder. To move it, delete this task and create it again with the ` +
        `target you want.`
    );
  }
  if (unknown.length > 0) {
    parts.push(
      `There is no such field on a task as ${unknown.join(', ')}. You can change: ` +
        `${UPDATABLE_TASK_FIELDS.join(', ')}.`
    );
  }
  return parts.join(' ');
}

/**
 * The refusal an agent reads. Names exactly which field stopped the call, says
 * why in one plain sentence, and tells it what to do instead, because this text
 * lands in a model's context and a model that is only told "no" will try again.
 *
 * @param fields - The offending fields, from {@link findOperatorOnlyTaskFields}.
 * @returns One paragraph written for the model.
 */
export function describeOperatorOnlyTaskRefusal(fields: readonly string[]): string {
  return (
    `DorkOS changed nothing — not one field of this task. A scheduled task runs later, on its ` +
    `own, with nobody watching, so how much it may do without asking is the person's to choose, ` +
    `not yours: ${fields.join(', ')}. Send the rest of your changes again without ` +
    `${fields.length === 1 ? 'that field' : 'those fields'} and they will go through. To change ` +
    `${fields.length === 1 ? 'it' : 'them'}, ask the person to open the task in DorkOS.`
  );
}
