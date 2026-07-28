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
 * supplying a field, and neither is closed here:
 *
 * - The SKILL.md `permissions:` frontmatter on disk. The watcher and the
 *   reconciler sync whatever is in the file (`task-file-watcher.ts`,
 *   `task-reconciler.ts`), live. Anything that can write a project file can set
 *   it — and that bar is LOWER than it sounds: an agent already running in
 *   `acceptEdits` writes that file with no prompt and no shell. Do not read this
 *   as only the shell-access adversary of `approvals/decision-authority.ts`.
 *   Closing it means a control on the file path (deciding what a task file may
 *   declare, and what happens when the watcher sees a mode it did not have
 *   before), which is a different mechanism from a per-caller field policy and is
 *   not in scope for DOR-504.
 * - A Shape package manifest declaring a schedule with a `permissionMode`
 *   (`shapes/apply-shape.ts` → `shapes/shape-schedule-service.ts`). There the
 *   field comes from installed package CONTENT, not from the caller, so refusing
 *   it per-caller would be the wrong control — the right one is on what a Shape
 *   may declare. CLOSED by DOR-607, in that shape: `apply-shape.ts` clamps a
 *   manifest-declared `bypassPermissions` back to `acceptEdits` and warns the
 *   operator, and a manifest can no longer declare that its schedule starts
 *   enabled by default either. The first bullet above — the SKILL.md file on
 *   disk — is still open.
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
  // the scheduler registers on `enabled && status === 'active'`.
  enabled: 'agent-writable',
  // A CAP on how long a run may take. Raising it makes a run longer, not more
  // permitted, so it is not an escalation. See the module TSDoc in
  // `mcp-tools/task-tools.ts` for the separate fact that `tasks_create` accepts
  // this argument and ignores it.
  maxRuntime: 'agent-writable',

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
 * Find the operator-only fields a task write body reaches for.
 *
 * Presence is what counts, not the value. A caller that sends
 * `permissionMode: null` reached for the field just as much as one that sent
 * `bypassPermissions`, and answering "that one was harmless" would mean this
 * guard has an opinion about values, which it deliberately does not.
 *
 * Call this on the RAW body, before Zod parses it. `CreateTaskRequestSchema`
 * defaults `permissionMode` to `acceptEdits`, so a parsed body always carries the
 * key and this function would refuse every create.
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
