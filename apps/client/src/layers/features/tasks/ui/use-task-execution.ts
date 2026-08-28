/**
 * What a scheduled task will actually run on, and what about that no longer
 * holds — the one answer the task form's Runs-on controls and its Trust dial
 * both read.
 *
 * The ladder here is the CLIENT half of the server's fire-time resolution
 * (`services/tasks/execution/resolve-run-execution.ts`, spec
 * `task-runtime-model` §2.4): the task's own `runtime`, else the target agent's
 * manifest `runtime`, else the registry default. It stops one rung short on
 * purpose — the skill file's top-level `model:` and the per-runtime server
 * defaults are tiers the form cannot see without reading the file, so this
 * never claims to know the model a task with no override will run on. It says
 * "agent default" and means it.
 *
 * The breakage rules are NOT re-implemented here. They are
 * {@link describeAgentExecution}, the same pure module the Runs-on picker and
 * the Settings exceptions strip read, so a model this form calls missing is a
 * model those two call missing (`shared/lib/execution-config.ts`). Only the
 * evidence-gathering is local, which is exactly the split
 * `use-execution-exceptions` makes for the same reason.
 *
 * @module features/tasks/ui/use-task-execution
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { EffortLevel, ModelOption } from '@dorkos/shared/types';
import { EFFORT_LEVELS } from '@dorkos/shared/constants';
import { describeAgentExecution, effortLabel, knownModelsFrom } from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { useResolvedAgents } from '@/layers/entities/agent';
import {
  getRuntimeDescriptor,
  listRuntimeTypes,
  settingsForRuntime,
  useRuntimeCapabilities,
} from '@/layers/entities/runtime';
import { modelsQueryOptions } from '@/layers/entities/session';

/** The shape of an agent row in the task form's picker list. */
interface AgentPathLike {
  /** The agent id the form field stores. */
  id: string;
  /** The project directory its manifest lives in. */
  projectPath: string;
}

/**
 * One agent's own manifest `runtime`, looked up by the id a form field holds.
 *
 * The whole picker list is resolved in one request rather than the selected
 * agent on its own, because that is the query the sidebar and the Settings
 * exceptions strip already hold — a per-selection key would mint a second cache
 * and a fresh round trip on every change of agent.
 *
 * `null` covers three different unknowns on purpose, and every caller treats
 * them the same way: no agent is selected, the manifest names no runtime, or the
 * resolve has not answered yet. None of them is a runtime, so none of them may
 * be presented as one.
 *
 * @param agents - The picker's agents, each with the project path its manifest lives in.
 * @param agentId - The selected agent's id, or `''`/undefined for none.
 */
export function useAgentRuntime(
  agents: readonly AgentPathLike[],
  agentId: string | undefined
): string | null {
  // Keyed on the joined paths rather than the array identity: callers build
  // this list with `?? []` off a query result, so the array is a fresh object
  // on most renders while its contents are unchanged.
  const pathsKey = agents.map((a) => a.projectPath).join('\n');
  const paths = useMemo(() => (pathsKey ? pathsKey.split('\n') : []), [pathsKey]);
  const { data: resolvedAgents } = useResolvedAgents(paths);
  const selectedPath = agentId ? agents.find((a) => a.id === agentId)?.projectPath : undefined;
  return selectedPath ? (resolvedAgents?.[selectedPath]?.runtime ?? null) : null;
}

/**
 * One entry in a Runs-on select.
 *
 * Label only, no second line: the select's own item text is what Radix clones
 * into the closed trigger, so a description added here would be read back as
 * part of the chosen value.
 */
export interface ExecutionOption {
  /** The value written to the form field — never the empty string; see {@link INHERIT}. */
  value: string;
  /** What the option reads as on screen. */
  label: string;
}

/**
 * The value a Runs-on select carries for "don't override this".
 *
 * A sentinel rather than `''` because Radix refuses an empty `SelectItem`
 * value, and rather than a bare word because a runtime type is a free string
 * and could in principle be called `inherit`. The form stores `''` for unset —
 * this is only ever the select's own wire value.
 */
export const INHERIT = '__inherit__';

/** What {@link useTaskExecution} is asked about. */
export interface TaskExecutionInput {
  /** The task's own runtime override; `''` means "follow the agent". */
  runtime: string;
  /** The task's own model override; `''` means "agent default". */
  model: string;
  /** The task's own effort override; `''` means "agent default". */
  effort: string;
  /**
   * The target agent's manifest `runtime`, or `null` when the agent names none,
   * no agent is selected, or the manifest has not been read yet.
   */
  agentRuntime: string | null;
}

/** Everything the task form needs to draw its Runs-on controls honestly. */
export interface TaskExecution {
  /**
   * The runtime this task's next run resolves to, or `null` while the
   * capability map has not answered and nothing is overridden — which is "not
   * known yet", never a guess.
   */
  effectiveRuntime: string | null;
  /** The runtime select's options, primaries first, registered only. */
  runtimeOptions: ExecutionOption[];
  /** What the runtime select's "don't override" option reads as. */
  inheritRuntimeLabel: string;
  /** The effective runtime's catalog, `undefined` until it lands. */
  models: ModelOption[] | undefined;
  /** The model select's options — the catalog, worded. */
  modelOptions: ExecutionOption[];
  /** Whether the effective runtime declares an effort setting at all. */
  supportsEffort: boolean;
  /** The effort rungs this runtime and model actually honor. */
  effortOptions: ExecutionOption[];
  /** Why the chosen runtime cannot run, or `null`. */
  runtimeWarning: string | null;
  /** Why the chosen model cannot be used on the effective runtime, or `null`. */
  modelWarning: string | null;
  /** Why the chosen effort does nothing, or `null`. */
  effortWarning: string | null;
}

/**
 * Resolve what a scheduled task runs on, from the form's own values.
 *
 * @param input - The three overrides plus the target agent's runtime; see
 *   {@link TaskExecutionInput}.
 */
export function useTaskExecution(input: TaskExecutionInput): TaskExecution {
  const { runtime, model, effort, agentRuntime } = input;
  const transport = useTransport();
  const { data: capabilityMap } = useRuntimeCapabilities();

  const registered = capabilityMap ? Object.keys(capabilityMap.capabilities) : undefined;
  const defaultRuntime = capabilityMap?.defaultRuntime ?? null;
  // The agent tier is taken only for a runtime this machine has REGISTERED —
  // the same tolerance the server's own resolver applies (`resolveRuntimeType`
  // in `services/tasks/execution/resolve-run-execution.ts`). An agent pinned to
  // a runtime this build cannot run falls through to the default rather than
  // failing a run it never asked to own, and the caption has to say the same
  // thing the run will do.
  const agentTierApplies =
    agentRuntime !== null && registered !== undefined && registered.includes(agentRuntime);
  const inheritedRuntime = agentTierApplies ? agentRuntime : defaultRuntime;
  const effectiveRuntime = runtime || inheritedRuntime;

  // Only ask a runtime this machine has actually registered: the catalog route
  // 400s on an unregistered one, and the runtime is already reported as not
  // connected below — a failed request would say the same thing twice. Same
  // query options `useModels` builds, so the form and the status-bar picker
  // share one cached catalog per runtime instead of minting a second.
  const catalogRuntime = effectiveRuntime ?? undefined;
  const catalogIsAskable =
    catalogRuntime !== undefined && registered !== undefined && registered.includes(catalogRuntime);
  const { data: models } = useQuery({
    ...modelsQueryOptions(transport, catalogRuntime ? { runtime: catalogRuntime } : {}),
    enabled: catalogIsAskable,
    // A catalog is decoration on this form, not its subject: a runtime that
    // cannot answer should leave the models unknown at once rather than retry
    // three times while somebody waits to pick one.
    retry: false,
  });

  const selectedModel = model ? models?.find((m) => m.value === model) : undefined;
  const runtimeSupportsEffort = settingsForRuntime(capabilityMap, effectiveRuntime)?.supportsEffort;

  // Nothing is judged until a runtime is known. Reporting against `''` would
  // call every task's runtime "not connected" for the length of one round trip.
  const report = effectiveRuntime
    ? describeAgentExecution({
        agent: {
          runtime: effectiveRuntime,
          model: model || null,
          effort: (effort || null) as EffortLevel | null,
        },
        // The same runtime on both sides: this form reads BREAKAGES only, and
        // pinning the baseline here keeps a deviation from being computed at
        // all rather than computed and thrown away.
        defaultRuntime: effectiveRuntime,
        knownRuntimes: registered,
        knownModels: knownModelsFrom(models),
        // Only a model actually found in the catalog can say whether it takes
        // an effort. A task that pins no model inherits one this form cannot
        // see, so the question goes unasked rather than guessed.
        modelSupportsEffort: selectedModel ? (selectedModel.supportsEffort ?? false) : undefined,
        runtimeSupportsEffort,
        runtimeLabel: (type) => getRuntimeDescriptor(type).label,
      })
    : null;
  const breakageFor = (kinds: string[]) =>
    report?.breakages.find((b) => kinds.includes(b.kind))?.message ?? null;

  // Primaries in the product's own order, then anything else this server
  // registered — and only what it registered, because a run on a runtime that
  // is not there fails loudly by design (spec §2, decision 9). An override
  // already stored on a runtime since turned off is appended anyway: it is the
  // one value a person has to see in order to clear it.
  const registeredKey = registered?.join(',');
  const runtimeOptions = useMemo<ExecutionOption[]>(() => {
    const reg = registeredKey === undefined ? [] : registeredKey.split(',').filter(Boolean);
    const types = listRuntimeTypes(reg).filter((type) => reg.includes(type));
    if (runtime && !types.includes(runtime)) types.push(runtime);
    return types.map((type) => ({ value: type, label: getRuntimeDescriptor(type).label }));
  }, [registeredKey, runtime]);

  const modelOptions = useMemo<ExecutionOption[]>(() => {
    const options = (models ?? []).map((m) => ({ value: m.value, label: m.displayName }));
    // A model the catalog no longer carries still has to be selectable, or the
    // select would silently show a blank trigger for a value the task holds.
    if (model && !options.some((o) => o.value === model)) {
      options.push({ value: model, label: model });
    }
    return options;
  }, [models, model]);

  const effortOptions = useMemo<ExecutionOption[]>(() => {
    const options: ExecutionOption[] = EFFORT_LEVELS.filter(
      (level) =>
        !selectedModel?.supportedEffortLevels || selectedModel.supportedEffortLevels.includes(level)
    ).map((level) => ({ value: level, label: effortLabel(level) }));
    // Same rule the model list follows, for the same reason: a rung this model
    // does not take is still a rung the task HOLDS, and a select whose value
    // matches no item renders an empty trigger. The person would be looking at a
    // blank box holding a value they cannot see, on a task that will run with
    // it. `describeAgentExecution` does not catch this one — it reports a model
    // that takes no effort at all, not a model whose ladder is shorter — so
    // dropping it here would be silent.
    if (effort && !options.some((o) => o.value === effort)) {
      options.push({ value: effort, label: effortLabel(effort as EffortLevel) });
    }
    return options;
  }, [selectedModel, effort]);

  const inheritRuntimeLabel =
    inheritedRuntime === null
      ? // Nothing has answered yet. Naming a runtime here would be a guess, and
        // the guess is wrong on exactly the machines that need it right.
        "Agent's runtime"
      : agentTierApplies
        ? `Agent's runtime (${getRuntimeDescriptor(inheritedRuntime).label})`
        : `Server default (${getRuntimeDescriptor(inheritedRuntime).label})`;

  return {
    effectiveRuntime,
    runtimeOptions,
    inheritRuntimeLabel,
    models,
    modelOptions,
    supportsEffort: runtimeSupportsEffort === true,
    effortOptions,
    runtimeWarning: breakageFor(['runtime-not-connected']),
    modelWarning: breakageFor(['model-unavailable']),
    effortWarning: breakageFor(['effort-unsupported-runtime', 'effort-unsupported-model']),
  };
}
