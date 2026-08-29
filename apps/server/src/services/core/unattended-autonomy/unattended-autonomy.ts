/**
 * Which agents are set to run without asking, on surfaces nobody is watching.
 *
 * ## The gap this closes
 *
 * The Trust Dial retired the standing app-wide bypass banner for sessions a
 * person is sitting in front of — the status strip already says it, and two
 * alarms for one fact teach people to read neither (spec `trust-dial`, decision
 * 3A). It kept the case the banner was right about: an agent left running
 * without asking behind a relay binding or a scheduled task, where there is no
 * strip to read and no one reading it. Until this module existed, that agent was
 * signalled only on the surface that configures it.
 *
 * ## What "unattended autonomy" means here
 *
 * Two conditions, both required, and both read off state that already exists:
 *
 * 1. **The driver is live** — it would actually start a turn.
 *
 *    For a **binding**, four things all have to hold, and an earlier version of
 *    this module checked only the middle two. `binding-router.ts` refuses a
 *    paused binding (`enabled === false`), refuses one set not to reach its
 *    agent (`canReceive === false`), and refuses one whose agent is not in the
 *    mesh registry — but every one of those checks runs only AFTER a message
 *    has already arrived through a REGISTERED adapter. Switch the integration
 *    off and nothing arrives at all, so none of them ever runs and the binding
 *    is as inert as a paused one. Reading the binding row alone therefore left
 *    a permanent amber row about a risk that could not occur, on a banner with
 *    no dismiss button. Adapter liveness and agent presence are now conditions
 *    of their own ({@link UnattendedAutonomyInput.adapterLive},
 *    {@link UnattendedAutonomyInput.agentLive}).
 *
 *    For a **task** it is `enabled` AND `status === 'active'`, the scheduler's
 *    own registration predicate.
 *
 *    Borrowing each subsystem's rules rather than writing a second set is the
 *    point: a banner whose idea of "running" differs from the thing that runs
 *    reports on a fiction. The copied halves are pinned against the real
 *    `BindingRouter` in `__tests__/liveness-agrees-with-router.integration.test.ts`,
 *    so a router that grows a refusal this module has not heard of goes red.
 * 2. **Its posture asks nobody** — {@link isUnattendedAutonomy} over the
 *    descriptor the runtime declared for the stored mode. Never a mode-id
 *    string: a list of ids is right until a runtime ships a mode nobody added to
 *    it, and then it is silently wrong in the direction of saying nothing.
 *
 * A stored mode the runtime does not declare yields NO claim. The alternative is
 * asserting a posture from a string this process cannot read, and on this
 * particular subject a confident wrong answer is worse than none.
 *
 * ## Why one runtime, and which
 *
 * A relay binding runs on Claude Code by construction: the relay's only runtime
 * adapter speaks the Claude Agent SDK's vocabulary (`apps/server/src/index.ts`,
 * where `relayAgentRuntime` is assigned `claudeRuntime`). The client's
 * `BINDING_RUNTIME` constant records the same fact for that picker. So the
 * caller resolves ONE profile and hands its declared modes in.
 *
 * **A task no longer does** (DOR-1615). Its runtime is resolved per run —
 * `services/tasks/execution/resolve-run-execution.ts` — so a task filed under a
 * Codex agent has its stored mode read here in Claude Code's vocabulary.
 *
 * What keeps that from losing a driver today is NOT that the three runtimes
 * declare the same three mode ids. They do, and the ids mean different things:
 * Codex files `acceptEdits` at "never asks, reaches the workspace" where Claude
 * Code files it at "asks when risky, reaches edits". The invariant that actually
 * holds is narrower — **no runtime files an autonomy-stop or a
 * never-asking-reaches-everything mode under an id Claude Code files anywhere
 * else.** Codex's `acceptEdits` stays off this report because
 * {@link isUnattendedAutonomy}'s bypass half requires `reach: 'everything'` and
 * Codex files that mode at `workspace` (`packages/shared/src/permission-semantics.ts`),
 * not because the two declarations agree.
 *
 * A runtime that broke the invariant would be an unattended driver this banner
 * never mentions, and it would break silently: this reads one profile, and a
 * mode it does not declare yields no claim rather than a guess. It is still one
 * profile too few, and the fix is the same shape as the relay's: take a mode
 * list per subject instead of one, never a runtime-name check.
 *
 * ## Cost
 *
 * A filter over two small collections plus two map lookups per binding. The
 * binding store is already resident in memory; the task store answers from
 * SQLite, so there is one cheap synchronous `SELECT` per request — not "no
 * I/O", which an earlier version of this paragraph claimed. Small enough to
 * answer on demand and small enough that the client holds it for the life of
 * the page. Nothing here does anything ASYNC, and nothing here should.
 *
 * ## What can go stale, honestly
 *
 * Every writer that can change this answer through an API broadcasts
 * `tasks_changed` or `relay_bindings_changed` / `relay_adapters_changed`, and
 * the client re-reads on all three. Three do not:
 *
 * - `TaskStore.upsertFromFile` and the five-minute reconciler, which flip a
 *   task's `enabled` or `status` when a SKILL.md changes underneath.
 * - `services/shapes/shape-schedule-service.ts`, which creates and tears down
 *   schedules as a Shape is applied or removed.
 *
 * None of them can INTRODUCE an autonomy posture — `schedule-permission-clamp.ts`
 * refuses that from every content path — so the drift is confined to liveness,
 * in both directions, and the client's 60-second staleness plus refetch-on-focus
 * is what closes it. That bound holds for all three; the list is written out so
 * the next person does not have to rediscover which writers are in it.
 *
 * A broadcast from the store itself was considered and rejected: it would cover
 * all three at once, and it would also fire a burst of events during every
 * reconciliation pass for a reader that only needs to be right within a
 * minute.
 *
 * ## Why it is NOT under `services/core/approvals`
 *
 * That was the first instinct — `autonomy-consent.ts` lives there and holds the
 * record of a person agreeing to Full autonomy, which is the same subject read
 * from the other end. The structural guard in
 * `services/core/capabilities/__tests__/permission-mode-firewall.test.ts`
 * refused it, correctly: nothing under `approvals/` or `capabilities/` may read
 * `permissionMode` in code, because an agent can already set a mode on a task
 * through `tasks_update` at act tier, so a permission mode reaching the approval
 * gate is an ungated way for an agent to switch off its own gate.
 *
 * This module reads permission modes on purpose and decides nothing — it
 * REPORTS, and a report is exactly the kind of thing that must never end up
 * beside a decision. Its own directory is the boundary that keeps the two
 * apart, and the guard is what will notice if anyone moves it back.
 *
 * @module services/core/unattended-autonomy/unattended-autonomy
 */
import type { PermissionModeDescriptor } from '@dorkos/shared/agent-runtime';
import {
  isUnattendedAutonomy,
  type UnattendedAutonomyDriver,
  type UnattendedAutonomyState,
} from '@dorkos/shared/permission-semantics';

/**
 * The binding columns this rule reads. Structural rather than the full
 * `AdapterBinding`, so the collector can be exercised without a relay and so
 * adding a field to a binding never silently changes what the banner reports.
 */
export interface UnattendedBindingRow {
  /** The binding's uuid. */
  id: string;
  /** The operator's own label for it. Often empty — bindings do not require one. */
  label: string;
  /** The adapter instance behind it: names an unlabelled binding, and gates it. */
  adapterId: string;
  /** The agent this binding points at, checked against the mesh registry. */
  agentId: string;
  /** False while the binding is paused; the router skips it entirely. */
  enabled: boolean;
  /** False when inbound delivery is switched off; nothing ever starts a turn. */
  canReceive: boolean;
  /** The runtime mode id turns from this binding run in. */
  permissionMode: string;
}

/**
 * The task columns this rule reads. Structural for the same reason as
 * {@link UnattendedBindingRow}.
 */
export interface UnattendedTaskRow {
  /** The task's ULID. */
  id: string;
  /** The task's slug-ish file name, the fallback when it has no display name. */
  name: string;
  /** The operator-facing name, when the task has one. */
  displayName?: string | null;
  /** False while the task is switched off. */
  enabled: boolean;
  /** Only `'active'` is a task the scheduler will register. */
  status: string;
  /** The runtime mode id the task's runs execute in. */
  permissionMode: string;
}

/**
 * The runtime type this banner reads its permission-mode vocabulary in.
 *
 * A structural fact for the relay half — see the module doc — and, since
 * DOR-1615, an approximation for the task half, which resolves its runtime per
 * run. The client spells the relay's copy as `BINDING_RUNTIME`; this is the
 * server's.
 */
export const UNATTENDED_RUNTIME = 'claude-code';

/**
 * The live reads the `/api/system/unattended-autonomy` handler needs that no
 * module singleton can give it, handed over once at bootstrap.
 *
 * Every part is optional and every absence reads as "nothing to report": relay
 * and Tasks are both switchable subsystems, and an install running neither must
 * answer the banner honestly rather than fail.
 */
export interface UnattendedAutonomyDeps {
  /** Every binding the relay holds, or absent when relay is not running. */
  bindings?: () => readonly UnattendedBindingRow[];
  /** Every task the scheduler holds, or absent when Tasks is not running. */
  tasks?: () => readonly UnattendedTaskRow[];
  /** A display name for an adapter instance; falls back to the id when absent. */
  adapterName?: (adapterId: string) => string;
  /**
   * Whether the integration behind a binding is registered and running. Absent
   * only where there is no relay to ask — and then there are no bindings
   * either, so the handler's permissive default never decides anything.
   */
  adapterLive?: (adapterId: string) => boolean;
  /**
   * Whether a binding's agent is in the mesh registry. Absent when Mesh did not
   * start; the handler then defaults it permissive, because a warning that goes
   * quiet on a subsystem outage is the wrong way to fail.
   */
  agentLive?: (agentId: string) => boolean;
}

/** Everything {@link collectUnattendedAutonomy} needs, and nothing it can fetch. */
export interface UnattendedAutonomyInput {
  /** Every binding the relay knows about, live or not. */
  bindings: readonly UnattendedBindingRow[];
  /** Every task the scheduler knows about, live or not. */
  tasks: readonly UnattendedTaskRow[];
  /**
   * Every permission mode the runtime behind both drivers declares. An empty
   * list — a boot where that runtime is not registered — reports nothing, which
   * is the honest answer rather than a guess from mode ids.
   */
  modes: readonly PermissionModeDescriptor[];
  /** A display name for an adapter instance, for naming an unlabelled binding. */
  adapterName: (adapterId: string) => string;
  /**
   * Whether the integration behind a binding is actually running — registered
   * with the relay, able to receive. A switched-off integration delivers
   * nothing, so its bindings cannot start a turn whatever their own row says.
   *
   * Registration rather than the config's `enabled` flag, deliberately.
   * `AdapterManager.disable()` writes the flag first and unregisters second,
   * and it logs "disabled in settings but would not stop, so it may still be
   * connected" when the second half fails. Reading the flag would go quiet
   * about a bot that is still answering; reading the registry stays loud until
   * it really has let go.
   */
  adapterLive: (adapterId: string) => boolean;
  /**
   * Whether a binding's agent is in the mesh registry. The router refuses
   * `agent_missing` after looking this up, so a binding pointing at an agent
   * that is gone runs nothing.
   */
  agentLive: (agentId: string) => boolean;
}

/**
 * Collect every live driver whose posture asks nobody.
 *
 * Bindings before tasks, each in its store's own order, so the banner's
 * "and 2 more" truncation is stable between reads rather than reshuffling on
 * every fetch.
 *
 * @param input - The two driver collections, the runtime's declared modes, and
 *   the adapter-name resolver.
 * @returns The whole answer; `drivers` is empty when nothing qualifies.
 */
export function collectUnattendedAutonomy(input: UnattendedAutonomyInput): UnattendedAutonomyState {
  const byId = new Map(input.modes.map((mode) => [mode.id, mode]));

  /** Whether a stored mode is one this runtime declared AND one that asks nobody. */
  const isUnattended = (modeId: string): boolean => {
    const descriptor = byId.get(modeId);
    return descriptor !== undefined && isUnattendedAutonomy(descriptor);
  };

  const drivers: UnattendedAutonomyDriver[] = [];

  for (const binding of input.bindings) {
    // `=== false` rather than `!`, matching `binding-router.ts` character for
    // character. The parsed schema always supplies booleans so the two agree
    // today; spelling them the same way is what keeps a future row shape from
    // making the router and this module disagree in silence.
    if (binding.enabled === false || binding.canReceive === false) continue;
    if (!input.adapterLive(binding.adapterId)) continue;
    if (!input.agentLive(binding.agentId)) continue;
    if (!isUnattended(binding.permissionMode)) continue;
    drivers.push({
      kind: 'binding',
      id: binding.id,
      name: binding.label || input.adapterName(binding.adapterId),
    });
  }

  for (const task of input.tasks) {
    if (task.enabled === false || task.status !== 'active') continue;
    if (!isUnattended(task.permissionMode)) continue;
    drivers.push({
      kind: 'task',
      id: task.id,
      name: task.displayName || task.name,
    });
  }

  return { drivers };
}
