/**
 * What a scheduled run actually executes on: which runtime, which model, how
 * hard it thinks (DOR-1615, DOR-1347).
 *
 * Every other execution surface in DorkOS already answers this question the same
 * way — an interactive session, a room turn, a relay-triggered turn all walk the
 * `resolveUnattendedSessionDefaults` ladder. A scheduled run was the one surface
 * that did not: its runtime was a single object captured at boot and its model
 * was whatever the SDK defaulted to. This module plugs it in, and adds the two
 * tiers a schedule has that a session does not — the `schedule:` block's own
 * `runtime`/`model`/`effort`, and the skill file's top-level `model`/`effort`.
 *
 * ## The ladder, first hit wins
 *
 * **Runtime**
 * 1. `schedule.runtime` — what the file (or the app) says this task runs on.
 * 2. The task's agent, when its manifest names a runtime that is REGISTERED
 *    here. An agent pinned to a runtime this build has no adapter for falls
 *    through rather than failing, because the agent did not ask for this run.
 * 3. The registry's default runtime.
 *
 * Then, whatever tier answered: **if that runtime is not registered, the run
 * fails, loudly, naming it.** Never a silent fall back to another runtime — a
 * task set to run on Codex that quietly ran on Claude Code would be a different
 * task, billed to a different account, with a different tool vocabulary, and
 * nothing on screen to say so (decision 9).
 *
 * **Model and effort**
 * 1. `schedule.model` / `schedule.effort` — written for the runtime resolved
 *    above, so they need no cross-runtime check.
 * 2. The skill file's TOP-LEVEL `model:` / `effort:`, **and only when the
 *    resolved runtime is claude-code**. Those fields are the Claude Code
 *    dialect: a person invoking the skill by hand gets them, and honoring them
 *    on a scheduled fire keeps "this skill runs on haiku" true whichever way it
 *    was started. Handing a `claude-sonnet-4-5` to Codex would not be honoring
 *    the author's intent, it would be a different provider's id.
 * 3. The agent's manifest, then the server's per-runtime default, then nothing —
 *    which is {@link resolveUnattendedSessionDefaults}, reused rather than
 *    re-derived. It owns the two rules that are easy to get wrong: a model only
 *    applies on the runtime it was written for, and an effort is dropped on a
 *    runtime whose API has none.
 *
 * The effort drop applies to the higher tiers too. A schedule that names an
 * effort and resolves onto OpenCode gets none — "OpenCode has no such setting"
 * is only true if nothing here quietly supplies one anyway.
 *
 * @module services/tasks/resolve-run-execution
 */
import fs from 'node:fs/promises';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import type { SessionSettings, Task } from '@dorkos/shared/types';
import { parseSkillFile } from '@dorkos/skills/parser';
import { SkillFrontmatterSchema } from '@dorkos/skills/schema';
import {
  readAgentExecutionDefaults,
  resolveUnattendedSessionDefaults,
} from '../session/resolve-session-defaults.js';
import { createTaggedLogger } from '../../lib/logger.js';

const logger = createTaggedLogger('Tasks');

/**
 * The runtime the skill file's top-level `model:`/`effort:` are written in.
 *
 * They are Claude Code frontmatter keys, adopted verbatim from that dialect
 * (`SkillFrontmatterSchema`), so they mean something only on that runtime. This
 * is a statement about a FILE FORMAT, not an assumption about which runtime a
 * task runs on — which is what the retired `TASK_RUNTIME` constant was, and why
 * it is not this.
 */
const SKILL_DIALECT_RUNTIME = 'claude-code';

/**
 * What this resolver needs from the runtime registry — no more, so a test can
 * hand it three functions instead of a registry with a database behind it.
 *
 * `runtimeRegistry` satisfies it structurally.
 */
export interface RunExecutionRuntimes {
  /** Whether a runtime type is registered and can take a run. */
  has(type: string): boolean;
  /** The runtime a caller that named none gets. */
  getDefaultType(): string;
  /** Every registered runtime's capability profile, keyed by type. */
  getAllCapabilities(): Record<string, RuntimeCapabilities>;
}

/** What one scheduled run resolved to execute on. */
export interface RunExecution {
  /** The runtime type this run executes on. Registered, by construction. */
  runtimeType: string;
  /**
   * That runtime's capability profile — the authority on its permission-mode
   * vocabulary, where its defaults live, and whether it takes an effort at all.
   * Carried rather than re-looked-up so the run's power and its settings are
   * decided from one profile.
   *
   * `undefined` for a runtime that is registered but publishes no profile.
   * Registration is what decides whether a run may START ({@link
   * RunExecutionRuntimes.has}); a profile is a separate, richer fact, and a
   * missing one means "nothing declared", which every consumer already spells
   * out: the power ladder falls back to {@link SCHEDULED_RUN_FALLBACK_MODE} and
   * the settings ladder leaves the runtime to decide. Refusing the run over it
   * would fail a task the machine can perfectly well run.
   */
  capabilities: RuntimeCapabilities | undefined;
  /**
   * The model and effort the turn starts with. Only keys with an answer are
   * present; an omitted key means "the runtime decides", which is what an unset
   * session setting already means everywhere else.
   */
  settings: Pick<SessionSettings, 'model' | 'effort'>;
}

/**
 * A run that cannot start because the runtime it resolved to is not registered.
 *
 * Carried as its own class so a caller can tell it from a runtime error inside a
 * turn: nothing ran, nothing was billed, and the fix is a setting rather than a
 * retry. Its `message` is written for the person who finds it on the run row.
 */
export class TaskRuntimeUnavailableError extends Error {
  constructor(
    /** The runtime type that is not registered. */
    public readonly runtime: string,
    /** Where that type came from, which decides what the person should go and change. */
    public readonly source: 'task' | 'default'
  ) {
    super(
      source === 'task'
        ? `This task is set to run on ${runtime}, which is not turned on for this DorkOS — ` +
            `so the run did not start. Turn ${runtime} on in Settings, or change the task to ` +
            'use a runtime you have.'
        : `DorkOS has no agent runtime turned on to run this task (it looked for ${runtime}), ` +
            'so the run did not start.'
    );
    this.name = 'TaskRuntimeUnavailableError';
  }
}

/**
 * Which runtime this task's next run executes on, before asking whether it is
 * registered.
 *
 * Split out so the answer and the availability check are separate facts: the
 * check needs to know WHICH tier answered, because a task that named its own
 * runtime and a machine with nothing registered are different problems with
 * different fixes.
 *
 * @param task - The task about to fire.
 * @param runtimes - The registry.
 * @param agentRuntime - The runtime the task's agent manifest names, if any.
 */
function resolveRuntimeType(
  task: Task,
  runtimes: RunExecutionRuntimes,
  agentRuntime: string | undefined
): { type: string; source: 'task' | 'default' } {
  if (task.runtime) return { type: task.runtime, source: 'task' };
  // The agent's runtime only when this build can actually run it. An agent
  // pinned to a runtime with no adapter here — the packaged desktop app bundles
  // only the claude-code SDK — falls through to the default rather than failing
  // a run nobody asked it to own. The same tolerance `resolveForAgent` applies.
  if (agentRuntime && runtimes.has(agentRuntime)) return { type: agentRuntime, source: 'default' };
  return { type: runtimes.getDefaultType(), source: 'default' };
}

/**
 * Read a skill file's TOP-LEVEL `model:` and `effort:`.
 *
 * Total and tolerant: a file that is gone, unreadable, or does not parse answers
 * "no opinion". This is a fallback tier, and a run must always be startable — a
 * file problem is a reason to fall through to the next tier, never a reason to
 * refuse the turn. (The schedule that opened this run was read from that same
 * file minutes ago; if it has since gone, the reconciler is the thing that
 * notices, not this.)
 *
 * @param filePath - The task's SKILL.md.
 */
async function readSkillDialectDefaults(
  filePath: string
): Promise<Pick<SessionSettings, 'model' | 'effort'>> {
  if (!filePath) return {};
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseSkillFile(filePath, content, SkillFrontmatterSchema);
    if (!parsed.ok) return {};
    const { model, effort } = parsed.definition.meta;
    return {
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Resolve what a scheduled run executes on — see the module doc for the ladder.
 *
 * @param task - The task whose run is being dispatched.
 * @param opts.runtimes - The runtime registry (or a narrow stand-in).
 * @param opts.agentPath - The task's agent directory, the one holding
 *   `.dork/agent.json`. Omitted for a task with no agent, and the agent tiers
 *   drop out.
 * @throws {TaskRuntimeUnavailableError} When the resolved runtime is not
 *   registered. Deliberately loud: a run that quietly moved to another runtime
 *   would be a different task with nothing on screen to say so.
 */
export async function resolveRunExecution(
  task: Task,
  opts: { runtimes: RunExecutionRuntimes; agentPath?: string | undefined }
): Promise<RunExecution> {
  const { runtimes, agentPath } = opts;

  // The agent tier's runtime, off the manifest that is the source of truth for
  // it (ADR-0043). Read through the same tolerant helper the shared ladder uses,
  // so "no directory, no manifest, an unreadable file" answers the same "no
  // opinion" here as it does there.
  const agent = await readAgentExecutionDefaults(agentPath);

  const { type, source } = resolveRuntimeType(task, runtimes, agent.runtime);
  // REGISTRATION is the whole availability question — see {@link
  // RunExecution.capabilities} for why a missing profile is not a second one.
  if (!runtimes.has(type)) throw new TaskRuntimeUnavailableError(type, source);

  const capabilities = runtimes.getAllCapabilities()[type];
  const declared = capabilities?.settings;
  // Tiers 3 and 4: the agent's manifest, then the server's per-runtime default.
  // Reused rather than re-derived — it owns the cross-runtime model drop and the
  // no-effort-here drop, and a second copy of either is how two unattended
  // surfaces came to disagree about an agent's settings before (DOR-1344). It
  // re-reads the manifest this function just read; one extra read of a small
  // JSON per run is cheaper than a second copy of that ladder.
  const resolved = await resolveUnattendedSessionDefaults({
    runtimeType: type,
    ...(agentPath !== undefined ? { agentPath } : {}),
    ...(declared !== undefined ? { declared } : {}),
  });
  // Only these two keys. That call never resolves a permission mode — no caller
  // here hands it the runtime's declared modes, which is what keeps an ATTENDED
  // session's trust default out of an unwatched run (spec `trust-dial`,
  // decision 6) — and a scheduled run's power is `scheduled-run-power.ts`'s
  // answer. Picking the keys out says so structurally rather than in a comment
  // that a future widening of that function would silently outgrow.
  const settings: Pick<SessionSettings, 'model' | 'effort'> = {
    ...(resolved.model !== undefined ? { model: resolved.model } : {}),
    ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
  };

  // Tier 2, claude-code only: what the skill's author wrote at the top level.
  const dialect =
    type === SKILL_DIALECT_RUNTIME ? await readSkillDialectDefaults(task.filePath) : {};

  // Tier 1: the schedule block's own answer, which beats everything.
  const model = task.model ?? dialect.model;
  if (model != null) settings.model = model;

  const effort = task.effort ?? dialect.effort;
  if (effort != null) settings.effort = effort;
  // The drop, applied AFTER the higher tiers rather than only inside the shared
  // ladder: a schedule that names an effort and lands on a runtime with none
  // must get none, or "Not supported by OpenCode" is a sentence this module
  // makes false. Unanswered reads as supported, so the drop only ever happens
  // where a runtime said out loud that it has no effort setting.
  if (declared?.supportsEffort === false) delete settings.effort;

  logger.debug(
    `run of "${task.name}" resolved to runtime=${type} ` +
      `model=${settings.model ?? '(runtime default)'} effort=${settings.effort ?? '(unset)'}`
  );

  return { runtimeType: type, capabilities, settings };
}
