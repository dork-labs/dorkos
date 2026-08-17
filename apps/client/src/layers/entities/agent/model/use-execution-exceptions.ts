/**
 * Which agents do not run on the server's defaults, and which of those no longer
 * work — one answer, read by both surfaces that ask.
 *
 * The Settings exceptions strip and the sidebar's Needs-attention group are the
 * same claim made in two places (spec `execution-defaults` §5, and the operator's
 * hard requirement that breakage surface where attention already lives). Two
 * implementations of "broken" would drift the day either surface learned a new
 * case, so both read this, and the rules themselves live one layer down in
 * `describeAgentExecution` where they are pure and testable.
 *
 * Cross-entity by necessity, and with precedent (`use-agent-tool-status.ts`):
 * the question spans agents, config, and runtimes, and belongs to none of them
 * alone. It is put with the agents because the answer is per agent.
 *
 * **The sibling-entity imports below are a KNOWING deviation from the repo
 * standard.** `.claude/rules/fsd-layers.md` § Cross-Module Rule forbids exactly
 * this — "FORBIDDEN: Entity importing sibling entity" — and this hook imports
 * from `entities/config`, `entities/mesh`, `entities/runtime` and
 * `entities/session` anyway. Taken deliberately, not by oversight, because both
 * compliant routes are worse:
 *
 * - Lifting the question to `features` puts it ABOVE the sidebar that consumes
 *   it, and `widgets → features` is the only legal direction — the sidebar
 *   could not read it.
 * - Splitting it per entity mints the second implementation of "broken" that
 *   this module exists to prevent, which is the drift the whole design is
 *   guarding against.
 *
 * The blast radius is kept small on purpose: only the DATA-GATHERING crosses
 * slices. The rules themselves stay pure, one layer down, in
 * `shared/lib/execution-config.ts`, which every surface may legally import. The
 * same deviation, for the same reason, already exists at
 * `use-agent-tool-status.ts` (agent → relay, tasks). If a third case appears,
 * that is the signal to lift these shared reads into `shared/` properly and
 * retire the exception rather than keep granting it.
 *
 * @module entities/agent/model/use-execution-exceptions
 */
import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { ModelOption } from '@dorkos/shared/types';
import {
  describeAgentExecution,
  knownModelsFrom,
  type AgentExecutionReport,
} from '@/layers/shared/lib';
import { useTransport } from '@/layers/shared/model';
import { useConfig } from '@/layers/entities/config';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import {
  getRuntimeDescriptor,
  settingsForRuntime,
  useRuntimeCapabilities,
} from '@/layers/entities/runtime';
import { modelsQueryOptions } from '@/layers/entities/session';
import { useResolvedAgents } from './use-resolved-agents';

/** One agent that departs from the server's defaults, with the reasons. */
export interface ExecutionException {
  /** The agent's project directory — what a row navigates by. */
  path: string;
  /** The agent itself, for its name, color, and icon. */
  agent: AgentManifest;
  /** What it overrides and what about that no longer holds. */
  report: AgentExecutionReport;
}

/** What {@link useExecutionExceptions} answers. */
export interface ExecutionExceptions {
  /**
   * Every deviating agent, broken ones first — the strip's own order, computed
   * once here so no consumer re-sorts and gets it subtly different.
   */
  exceptions: ExecutionException[];
  /** Project paths of the broken agents alone, for the attention bridge. */
  brokenPaths: string[];
  /** The runtime a new session starts on, for wording a deviation against. */
  defaultRuntime: string;
}

/** Nothing known yet — the shape a loading read returns, so consumers never branch on undefined. */
const EMPTY: readonly ExecutionException[] = [];

/**
 * Find every agent whose execution settings depart from the server's defaults.
 *
 * @param opts.checkModels - Also verify each agent's model against its runtime's
 *   live catalog. Off by default, and that default is the point: catalogs are
 *   remote per-runtime fetches, and the sidebar asks this question on every
 *   render of the fleet. The Settings strip — one screen, opened deliberately —
 *   turns it on. A catalog that was not fetched reports no breakage rather than
 *   a guessed one (see `describeAgentExecution`).
 *
 *   **The divergence this creates is a decision, not an oversight.** The rules
 *   are one implementation, but the EVIDENCE differs by surface, so the two
 *   surfaces can honestly disagree: the sidebar's Needs-attention group sees the
 *   two catalog-free breakages — a runtime this machine has not connected, and
 *   an effort on a runtime whose API has none — while a model that is gone, and
 *   an effort on a model that does not take one, need a catalog and so appear
 *   only in the Settings strip and the agent's own Runs on picker. The trade was
 *   made in favor of the sidebar staying free: making Needs-attention complete
 *   means fetching every runtime's catalog on every fleet render, to change an
 *   amber dot. The user-facing copy is written to match — the changelog promises
 *   Needs-attention only for the breakages this list can actually catch.
 */
export function useExecutionExceptions(opts?: { checkModels?: boolean }): ExecutionExceptions {
  const checkModels = opts?.checkModels ?? false;
  const transport = useTransport();
  const { data: config } = useConfig();
  const { data: capabilityMap } = useRuntimeCapabilities();
  const { data: meshData } = useMeshAgentPaths();
  const agentPaths = useMemo(() => (meshData?.agents ?? []).map((a) => a.projectPath), [meshData]);
  const { data: agents } = useResolvedAgents(agentPaths);

  const defaultRuntime = config?.executionDefaults?.runtime ?? 'claude-code';
  const knownRuntimes = capabilityMap ? Object.keys(capabilityMap.capabilities) : undefined;
  const perRuntime = config?.executionDefaults?.perRuntime;

  /** The model the server default supplies for one runtime, if it supplies one. */
  const serverModelFor = (runtime: string) =>
    perRuntime?.find((entry) => entry.runtime === runtime)?.model ?? null;

  // One catalog per runtime some agent actually needs one for — never the whole
  // runtime list, so a fleet that all inherits fetches nothing at all. An agent
  // that sets only an EFFORT still needs its runtime's catalog: the model that
  // will run the turn is the inherited default, and whether that one takes an
  // effort is exactly the question (see `describeAgentExecution`).
  //
  // Runtimes this machine has not connected are dropped: the catalog request
  // 400s on an unregistered runtime, and the agent is already reported as broken
  // for naming it. Asking anyway would trade a served answer for a failed
  // request that says the same thing.
  const knownRuntimesKey = knownRuntimes?.join(',');
  const runtimesToCheck = useMemo(() => {
    if (!checkModels || !agents) return [];
    const connected = knownRuntimesKey === undefined ? null : new Set(knownRuntimesKey.split(','));
    const wanted = new Set<string>();
    for (const agent of Object.values(agents)) {
      if (!agent?.model && !agent?.effort) continue;
      const runtime = agent.runtime ?? defaultRuntime;
      if (connected && !connected.has(runtime)) continue;
      wanted.add(runtime);
    }
    return [...wanted].sort();
  }, [checkModels, agents, defaultRuntime, knownRuntimesKey]);

  // The same query options `useModels` builds, so the strip and the status-bar
  // picker share one cached catalog per runtime instead of fetching it twice —
  // imported rather than re-spelled, because a hand-written key that drifted by
  // one argument would silently mint a second cache.
  const catalogs = useQueries({
    queries: runtimesToCheck.map((runtime) => ({
      ...modelsQueryOptions(transport, { runtime }),
      // A catalog is decoration on this screen, not its subject: a runtime that
      // cannot answer should leave the models unknown at once rather than retry
      // three times while the strip waits to say anything.
      retry: false,
    })),
  });

  // Built every render rather than memoized: it holds at most one entry per
  // runtime, and a memo over an array of query results needs a hand-rolled
  // signature to be correct — more machinery than the work it would skip.
  const byRuntime = new Map<string, ModelOption[]>();
  runtimesToCheck.forEach((runtime, i) => {
    const data = catalogs[i]?.data;
    if (data) byRuntime.set(runtime, data);
  });

  if (!agents)
    return { exceptions: EMPTY as ExecutionException[], brokenPaths: [], defaultRuntime };

  const found: ExecutionException[] = [];
  for (const [path, agent] of Object.entries(agents)) {
    if (!agent) continue;
    const runtime = agent.runtime ?? defaultRuntime;
    const catalog = byRuntime.get(runtime);
    const serverDefaultModel = serverModelFor(runtime);
    // The model that will actually run this agent's turn — its own pin, else
    // what it inherits. The Runs on picker has always reasoned about this one; the
    // strip used to look only at the pin, which meant an agent asking for high
    // effort on an inherited Haiku was called broken on one screen and healthy
    // on the other.
    const effectiveModel = agent.model ?? serverDefaultModel;
    const effective = effectiveModel ? catalog?.find((m) => m.value === effectiveModel) : undefined;
    const report = describeAgentExecution({
      agent: { runtime: agent.runtime, model: agent.model, effort: agent.effort },
      defaultRuntime,
      serverDefaultModel,
      knownRuntimes,
      knownModels: knownModelsFrom(catalog),
      // Only a model actually found in the catalog can say whether it takes an
      // effort. A model that is missing is already reported as missing, and
      // guessing at its capabilities would say the same thing twice.
      modelSupportsEffort: effective ? (effective.supportsEffort ?? false) : undefined,
      // The runtime's own declaration, not a list kept here. A runtime the map
      // has not answered for reports `undefined`, which is read as "not asked".
      runtimeSupportsEffort: settingsForRuntime(capabilityMap, runtime)?.supportsEffort,
      // Named the way the Settings cards above the strip name them.
      runtimeLabel: (type) => getRuntimeDescriptor(type).label,
    });
    if (report.isException) found.push({ path, agent, report });
  }

  // Broken first, then by name — the strip reads top-down as "fix these, and
  // here is what else is simply different".
  found.sort((a, b) => {
    if (a.report.isBroken !== b.report.isBroken) return a.report.isBroken ? -1 : 1;
    return a.agent.name.localeCompare(b.agent.name);
  });

  return {
    exceptions: found,
    brokenPaths: found.filter((e) => e.report.isBroken).map((e) => e.path),
    defaultRuntime,
  };
}
