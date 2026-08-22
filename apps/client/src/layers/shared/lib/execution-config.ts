/**
 * Where an agent's execution settings came from, and whether they still hold —
 * the one place that answers both, for every surface that asks (spec
 * `execution-defaults` §3, §5).
 *
 * Three surfaces ask the same two questions and must never answer differently:
 * the Runs on picker's provenance chips ("server default · Opus" vs "set here"), the
 * Settings exceptions strip (who deviates, who is broken), and the sidebar's
 * Needs-attention group (which is only honest if "broken" means exactly what the
 * strip means by it). So the rules live here, pure, and each surface supplies
 * whatever evidence it happens to have.
 *
 * **Evidence it does not have is never evidence against.** A model catalog is
 * remote and a runtime can be disconnected while somebody edits, so `undefined`
 * for the known-runtimes, known-models or runtime-supports-effort input means
 * "not asked", and no breakage is reported from it. That is the same
 * accepted-at-write rule the server applies
 * (`resolve-session-defaults.ts`): a value nobody can currently verify is
 * reported when it is known to be wrong, never guessed at.
 *
 * An **empty** catalog is the same thing as an absent one — see
 * {@link knownModelsFrom}, which every consumer routes through so the rule
 * cannot be forgotten on one surface.
 *
 * A second absence is read the other way round, deliberately: a model entry that
 * carries no `supportsEffort` is taken to mean "no". That is not this module's
 * invention — the status-bar picker has always gated its effort control on
 * `selectedModel?.supportsEffort` being truthy (`ModelConfigPopover`), so a
 * missing flag already hides the control everywhere else in the app. Reading it
 * as "unknown" here would make this the one surface that offers an effort the
 * rest of the app refuses to.
 *
 * @module shared/lib/execution-config
 */
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import type { EffortLevel } from '@dorkos/shared/types';

/** How each effort rung is written for a person. */
const EFFORT_LABELS: Record<EffortLevel, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
  xhigh: 'Extra high',
};

/**
 * Write one effort rung the way a person reads it.
 *
 * @param effort - A rung, or `null`/`undefined` for "no preference".
 * @returns The rung's label, or `'Default'` when there is no preference.
 */
export function effortLabel(effort: EffortLevel | null | undefined): string {
  return effort ? EFFORT_LABELS[effort] : 'Default';
}

/**
 * Turn a fetched model catalog into the `knownModels` evidence, treating an
 * EMPTY catalog as no evidence at all.
 *
 * `GET /api/models` answers `200 {models: []}` while a runtime's catalog is
 * still warming up — the server's own cache calls that its "client shows loading
 * state" tier (`runtime-cache.ts` §getSupportedModels, tier 4), not a claim that
 * the runtime offers nothing. Handed through as `[]`, it would say every pinned
 * model in the fleet is gone, turning a cold cockpit amber for a few seconds
 * after every start.
 *
 * So `[]` collapses to `undefined` — evidence nobody has is never evidence
 * against. It lives here rather than at each call site because two surfaces read
 * catalogs and a rule kept in two places is a rule that will hold in one.
 *
 * (The alternative, teaching the route to distinguish "warming" from "genuinely
 * empty", means a new state on `AgentRuntime.getSupportedModels()` and all three
 * adapters. Worth doing the day a runtime legitimately offers zero models; today
 * none does, and every empty answer is a cold one.)
 *
 * @param models - The catalog as fetched, or `undefined` while it is loading.
 * @returns The model ids, or `undefined` when nothing is known yet.
 */
export function knownModelsFrom(
  models: readonly { value: string }[] | undefined
): string[] | undefined {
  return models && models.length > 0 ? models.map((m) => m.value) : undefined;
}

/**
 * The one runtime that bills to a Claude account. Accounts are Claude config
 * directories, so no other runtime has them (spec `billing-account-ladder`,
 * Non-Goals) — and a setting that cannot apply is not reasoned about at all.
 */
const ACCOUNT_RUNTIME = 'claude-code';

/** Why an agent's execution settings cannot be honored as written. */
export type ExecutionBreakageKind =
  /** The agent names a runtime this machine has not connected. */
  | 'runtime-not-connected'
  /** The agent pins a model its runtime no longer offers. */
  | 'model-unavailable'
  /** The agent bills to an account nobody has registered. */
  | 'account-unregistered'
  /** The agent sets an effort on a runtime whose API has none. */
  | 'effort-unsupported-runtime'
  /** The agent sets an effort on a model that does not take one. */
  | 'effort-unsupported-model';

/** One thing wrong with an agent's execution settings, already worded. */
export interface ExecutionBreakage {
  kind: ExecutionBreakageKind;
  /** One sentence naming what is wrong, in the plainest words that are true. */
  message: string;
}

/** One way an agent departs from the server's defaults, already worded. */
export interface ExecutionDeviation {
  /** Which setting departs. */
  field: 'runtime' | 'model' | 'effort' | 'account';
  /** The value the agent carries, written for a person. */
  label: string;
}

/** A billing account this machine has registered, as the rules need to see it. */
export interface KnownAccount {
  /** The registry id an agent references the account by. */
  id: string;
  /** What to call it in a sentence a person reads. */
  label: string;
}

/** What {@link describeAgentExecution} was given to reason about. */
export interface DescribeAgentExecutionInput {
  /**
   * The agent's own settings — `undefined` OR `null` on a key means "inherit".
   *
   * Both spellings are accepted because both really occur: a manifest read off
   * disk omits the key, while an in-flight optimistic update carries the wire's
   * `null` (which is how "go back to inheriting" is written on `PATCH`). Reading
   * that `null` as a value is how "no longer offers null." reaches a screen, so
   * every check below is `!= null` rather than `!== undefined`.
   */
  agent: {
    runtime?: string | null;
    model?: string | null;
    effort?: EffortLevel | null;
    /** The billing account's registry id — never a path (ADR 260821-205324). */
    account?: string | null;
  };
  /** The runtime a new session starts on when nothing else picks one. */
  defaultRuntime: string;
  /**
   * The model the server default would supply for this agent's runtime, or
   * `null`/`undefined` when it has none.
   *
   * Given so the EFFORT rules can reason about the model that will actually run
   * — see {@link describeAgentExecution} on why effort asks about the effective
   * model while availability asks only about the pinned one.
   */
  serverDefaultModel?: string | null;
  /**
   * Runtime types this machine has registered, or `undefined` while unknown.
   * Unknown never reports a disconnected runtime — see the module note.
   */
  knownRuntimes?: readonly string[];
  /**
   * The model ids the agent's runtime currently offers, or `undefined` while the
   * catalog is unknown or still loading.
   */
  knownModels?: readonly string[];
  /**
   * The billing accounts this machine has registered, or `undefined` while the
   * server config has not answered yet.
   *
   * Unlike a model catalog, an EMPTY list here is real evidence rather than a
   * warming cache: the registry is local config the server reads off disk, so
   * "no accounts are registered" is an answer, and an agent naming one is
   * genuinely pointing at nothing. Only the unanswered case is silent.
   *
   * Rows the server synthesized for unregistered roots carry no id and are
   * simply absent from this list — nothing can reference them (ADR
   * 260821-205324).
   */
  knownAccounts?: readonly KnownAccount[];
  /**
   * True when the server could not READ the account registry, so its empty
   * `accounts` list is an absence of knowledge rather than an absence of
   * accounts (`ServerConfigSchema.claudeCode.accountsUnavailable`).
   *
   * It suppresses every account judgment — the breakage AND the deviation.
   * That is stronger than the loading case above, and deliberately so: while
   * the registry is merely unread, "this agent bills somewhere other than the
   * default" is still true and worth saying. When the read has FAILED, an
   * override nobody can resolve is not a fact about the agent, it is a fact
   * about the outage, and putting the whole account-carrying fleet in the
   * exceptions strip would say the wrong one.
   */
  accountsUnavailable?: boolean;
  /**
   * Whether the agent's EFFECTIVE model — its own pin, else the server default
   * for its runtime — takes an effort setting, or `undefined` while unknown.
   * Only consulted when the runtime supports effort at all.
   */
  modelSupportsEffort?: boolean;
  /**
   * Whether the runtime this agent runs on takes an effort setting at all,
   * from that runtime's declared `settings.supportsEffort`. `undefined` means
   * the capability map has not answered yet, and the permissive reading is the
   * right one: an unanswered runtime is never called broken on a guess.
   */
  runtimeSupportsEffort?: boolean;
  /**
   * How to name a runtime in a sentence a person reads.
   *
   * Passed in rather than resolved here so the wording matches whatever screen
   * it appears on: the Settings strip sits directly beneath cards that say
   * "Claude Code", and a message that said "Claude" two inches below them would
   * read as a different thing. Defaults to the runtime-neutral
   * {@link runtimeDisplayName}, which is right when nobody has an opinion.
   */
  runtimeLabel?: (runtimeType: string) => string;
}

/** Everything a surface needs to say about one agent's execution settings. */
export interface AgentExecutionReport {
  /** What is wrong, in the order a person should read it. Empty means nothing is. */
  breakages: ExecutionBreakage[];
  /** How this agent departs from the server's defaults. Empty means it inherits. */
  deviations: ExecutionDeviation[];
  /** Whether this agent belongs in the exceptions strip at all. */
  isException: boolean;
  /** Whether this agent belongs in the sidebar's Needs-attention group. */
  isBroken: boolean;
}

/**
 * Describe one agent's execution settings: what it overrides, and what about
 * those overrides no longer holds.
 *
 * Deviation and breakage are separate on purpose. Deviating is a choice and is
 * shown in normal weight; breakage is a choice that stopped working and is shown
 * in warning color, first. An agent can be both, and an agent that inherits
 * everything is neither.
 *
 * A runtime the agent names but this machine has not connected is a breakage
 * whether or not the agent also pins a model — a session on an unconnected
 * runtime is what a person has to fix, and it is the one breakage that says
 * nothing about the other two settings.
 *
 * **Availability asks about the pinned model; effort asks about the effective
 * one.** They are deliberately different questions. "This model is gone" is only
 * this agent's problem when this agent chose it — a server default that stopped
 * being offered is one problem with one fix, and reporting it once per agent
 * would bury the agents that actually chose something. "This effort does
 * nothing", though, is about the model that will really run the turn, which is
 * the agent's pin OR the inherited default: an agent asking for high effort on
 * an inherited Haiku is asking for something it will not get, and it says so
 * here, in the Runs on picker and in the strip alike.
 *
 * @param input - The agent's settings plus whatever evidence the caller has.
 */
export function describeAgentExecution(input: DescribeAgentExecutionInput): AgentExecutionReport {
  const {
    agent,
    defaultRuntime,
    serverDefaultModel,
    knownRuntimes,
    knownModels,
    knownAccounts,
    accountsUnavailable,
    modelSupportsEffort,
    runtimeSupportsEffort,
    runtimeLabel = runtimeDisplayName,
  } = input;
  const breakages: ExecutionBreakage[] = [];
  const deviations: ExecutionDeviation[] = [];

  const runtime = agent.runtime ?? defaultRuntime;
  const effectiveModel = agent.model ?? serverDefaultModel ?? null;
  // A stored account is read as nothing at all in two cases. On any runtime but
  // Claude Code it is a setting that cannot apply — the same silence the Runs on
  // picker keeps by not drawing the row, because naming it would put a fix in
  // front of a person for a field they have no way to see. And when the registry
  // could not be READ, nothing about the reference can be said honestly at all.
  const accountIsKnowable = runtime === ACCOUNT_RUNTIME && accountsUnavailable !== true;
  const account = accountIsKnowable ? (agent.account ?? null) : null;
  const registeredAccount =
    account !== null ? knownAccounts?.find((a) => a.id === account) : undefined;

  if (agent.runtime != null && agent.runtime !== defaultRuntime) {
    deviations.push({ field: 'runtime', label: runtimeLabel(agent.runtime) });
  }
  if (agent.model != null) deviations.push({ field: 'model', label: agent.model });
  if (agent.effort != null) {
    deviations.push({ field: 'effort', label: effortLabel(agent.effort) });
  }
  if (account !== null) {
    // The registry's own name for it where there is one; the raw id where there
    // is not, so a row about a broken reference still says which reference.
    deviations.push({ field: 'account', label: registeredAccount?.label ?? account });
  }

  if (knownRuntimes !== undefined && !knownRuntimes.includes(runtime)) {
    breakages.push({
      kind: 'runtime-not-connected',
      message: `${runtimeLabel(runtime)} is not connected on this machine.`,
    });
  } else {
    // Both of these are only asked when the runtime IS connected: a catalog and
    // a registry for a runtime that is not there say nothing about anything, and
    // reporting them alongside would be one problem told twice.
    if (agent.model != null && knownModels !== undefined && !knownModels.includes(agent.model)) {
      breakages.push({
        kind: 'model-unavailable',
        message: `${runtimeLabel(runtime)} no longer offers ${agent.model}.`,
      });
    }
    if (account !== null && knownAccounts !== undefined && !registeredAccount) {
      breakages.push({
        kind: 'account-unregistered',
        message: `The account “${account}” isn’t registered on this machine, so this agent bills to the default.`,
      });
    }
  }

  if (agent.effort != null) {
    if (runtimeSupportsEffort === false) {
      breakages.push({
        kind: 'effort-unsupported-runtime',
        message: `${runtimeLabel(runtime)} has no effort setting, so this one does nothing.`,
      });
    } else if (modelSupportsEffort === false) {
      breakages.push({
        kind: 'effort-unsupported-model',
        message: `${effectiveModel ?? 'This model'} does not take an effort setting.`,
      });
    }
  }

  return {
    breakages,
    deviations,
    isException: breakages.length > 0 || deviations.length > 0,
    isBroken: breakages.length > 0,
  };
}
