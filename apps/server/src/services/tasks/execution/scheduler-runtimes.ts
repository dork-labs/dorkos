/**
 * The runtimes a scheduled run is resolved against: the registry view the
 * scheduler picks one from (DOR-1615), the one read it still makes of a
 * runtime, and the one-manager source the tests build a scheduler with. A
 * run's turn starts through the turn port (`task-turns.ts`, T12), never on a
 * runtime the scheduler holds.
 *
 * @module services/tasks/execution/scheduler-runtimes
 */
import { runtimeRegistry } from '../../core/runtime-registry.js';
import type { RunExecutionRuntimes } from './resolve-run-execution.js';

/** What the scheduler reads of the runtime a run resolved to. */
export interface SchedulerAgentManager {
  /**
   * The runtime's OWN session id for a session key, after the SDK has minted or
   * kept one (`AgentRuntime.getInternalSessionId`).
   *
   * Every run reads this once its turn is over to learn the real id the SDK
   * wrote its transcript under, then persists it as the run's `sessionId`: it is
   * what makes the run clickable through to the conversation it actually had,
   * and what a sticky task's next fire resumes (DOR-1571). Returns undefined
   * when the session is gone or never started, and the run then records the id
   * it asked to run under.
   */
  getInternalSessionId(sessionId: string): string | undefined;
}

/**
 * Where the scheduler gets an agent manager for the runtime a run RESOLVED to
 * (DOR-1615).
 *
 * This replaces the single boot-bound `agentManager` the scheduler used to hold.
 * That binding was the reason a scheduled run could only ever happen on Claude
 * Code: `index.ts` constructed one `ClaudeCodeRuntime` and handed it over, so
 * `runtimes.default` moved which runtime a new CHAT got and never reached a
 * scheduled run at all.
 *
 * Deliberately the narrow shape rather than `RuntimeRegistry` itself — the
 * registry satisfies it structurally, and a test can hand over three functions
 * instead of a registry with a database behind it.
 */
export interface SchedulerRuntimes extends RunExecutionRuntimes {
  /**
   * The agent manager for a registered runtime type.
   *
   * Only ever called for a type {@link RunExecutionRuntimes.has} has already
   * answered `true` for — {@link resolveRunExecution} refuses an unregistered
   * one before anything reaches here — so a throw from this is a bug, not a
   * state to handle.
   */
  get(type: string): SchedulerAgentManager;
}

/**
 * Present ONE agent manager as a whole registry.
 *
 * Says "this one manager answers for whatever runtime the task resolves to" —
 * which is precisely what the scheduler did for EVERY task before this change,
 * so a caller that wraps a single fake keeps testing what it was written to
 * test. The capability profiles and the default type still come from the real
 * registry, so a scheduler built this way resolves power and settings exactly as
 * a wired one does; only the "which manager runs it" lookup is collapsed.
 *
 * Exported because the tests are its callers and the collapse should be visible
 * at each one rather than inferred from which constructor overload was used.
 * Production never takes this path: `index.ts` hands over the registry itself.
 *
 * @param agentManager - The single manager to answer every lookup with.
 */
export function singleRuntimeSource(agentManager: SchedulerAgentManager): SchedulerRuntimes {
  return {
    // Never refuses. This source has one manager and no registry to ask, so
    // refusing here would fail runs over a question it cannot answer. The
    // capability profiles below may still come back empty, which is a
    // different (and non-fatal) fact — see {@link RunExecution.capabilities}.
    has: () => true,
    get: () => agentManager,
    getDefaultType: () => runtimeRegistry.getDefaultType(),
    getAllCapabilities: () => runtimeRegistry.getAllCapabilities(),
  };
}
