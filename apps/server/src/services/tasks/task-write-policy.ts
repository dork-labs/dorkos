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
 * `dorkos task create` calls, armed a live cron task for the same agent. The
 * route now parks too, on the same trust answer it uses below (`parksOnCreate`
 * in `routes/tasks.ts`).
 *
 * This module is the classification, and it is deliberately the same shape as
 * `core/operator/config-write-policy.ts`: a table with a verdict per field, the
 * operator-only set derived from the table so the two cannot drift, and one
 * function that tells a caller which fields a write body reached for. Read that
 * module first — the reasoning there is the reasoning here, one level down.
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
 * ## Why not the cookie bar, given a cron task IS a standing grant
 *
 * `routes/config.ts` puts a STRICTER bar on `approvals.standingGrants`: a real
 * session cookie, checked before the trust question and regardless of its
 * answer, reasoning that a standing permission keeps saying yes for hours. A
 * cron task carrying `bypassPermissions` has exactly that character, so the
 * divergence is worth naming rather than leaving as an omission.
 *
 * It is deliberate. `requireOperatorCookie` refuses OUTRIGHT when login is off,
 * which is the default posture, and the cockpit's own task form writes
 * `permissionMode` through this route. Adopting that bar would break creating a
 * task in the shipped default configuration, a much larger blast radius than the
 * one config subtree it was introduced for, where the cockpit had another path.
 * The honest summary: for tasks the guarantee is "an agent that names itself
 * cannot", not "only a proven person can". If DOR-505 generalizes the cookie
 * requirement for operator-only writes, tasks should be reconsidered along with
 * it rather than separately.
 *
 * @module services/tasks/task-write-policy
 */

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
  // The case FOR the schedule, in the proposer's own words (DOR-1394). Writable
  // by definition: it is the agent's own sentence, and the whole point is that
  // an agent must supply it. An operator-only verdict here would refuse every
  // proposal that did what it was asked to do.
  reason: 'agent-writable',

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
