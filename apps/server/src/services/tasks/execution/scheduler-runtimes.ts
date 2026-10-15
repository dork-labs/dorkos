/**
 * The runtimes a scheduled run is handed to: the narrow agent-manager shape
 * the scheduler drives a turn through, the registry view it picks one from
 * (DOR-1615), and the one-manager source the tests build a scheduler with.
 *
 * @module services/tasks/execution/scheduler-runtimes
 */
import type {
  EffortLevel,
  InterruptReceipt,
  PermissionMode,
  StreamEvent,
} from '@dorkos/shared/types';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import type { RunExecutionRuntimes } from './resolve-run-execution.js';

/** Narrow interface for the AgentManager methods used by the scheduler. */
export interface SchedulerAgentManager {
  ensureSession(
    sessionId: string,
    opts: {
      permissionMode: PermissionMode;
      cwd?: string;
      hasStarted?: boolean;
      /**
       * True for every scheduled run: nobody is watching, so a prompt this run
       * raises is refused at the countdown rather than waiting for an answer
       * that is not coming (spec `ask-parks-on-timeout` §7).
       */
      unattended?: boolean;
      /**
       * The model this run resolved to, in the runtime's own id space, or absent
       * for "the runtime decides" (DOR-1347).
       *
       * Asked HERE and not only at `sendMessage`, because for claude-code this
       * is the only call that can answer it: the runtime reads `session.model`
       * when it launches a query, and that field is written once, when the
       * session record is created (`messaging/launch-resolver.ts`). A model
       * handed over afterwards reaches nothing. `agent-handler.ts` in the relay
       * spreads its resolved settings into both calls for exactly this reason.
       */
      model?: string;
      /** The reasoning-effort rung this run resolved to; absent leaves it unset. */
      effort?: EffortLevel;
      /**
       * The schedule's Claude account (DOR-2384). Arrives here only because the
       * run's settings are spread whole into both calls; the claude-code launch
       * reads it off the send ({@link SchedulerAgentManager.sendMessage}).
       */
      accountHint?: string;
    }
  ): void;
  sendMessage(
    sessionId: string,
    content: string,
    opts?: {
      permissionMode?: PermissionMode;
      cwd?: string;
      systemPromptAppend?: string;
      /**
       * Nobody can answer an approval card inside this turn, so it must not hold
       * for one (`MessageOpts.unattendedApprovals`, spec `agent-permissions` D6).
       */
      unattendedApprovals?: boolean;
      /**
       * Sent again, for the same reason the permission mode and the cwd are: the
       * runtime contract resolves a turn as per-send override → persisted → its
       * own default, and a runtime whose sessions are not held in memory sees
       * this call and not `ensureSession`.
       */
      model?: string;
      /** See {@link SchedulerAgentManager.sendMessage}'s `model`. */
      effort?: EffortLevel;
      /**
       * The schedule's Claude account as the launch hint
       * (`MessageOpts.accountHint`, DOR-2384): read by the claude-code launch
       * ladder only when this run starts a conversation, ignored by every other
       * runtime. An id nobody registered falls through the ladder.
       */
      accountHint?: string;
    }
  ): AsyncGenerator<StreamEvent>;
  /**
   * End the in-flight turn for a session (`AgentRuntime.interruptQuery`).
   *
   * This is the ONLY way to stop a scheduled run: `sendMessage` takes no
   * `AbortSignal` (see `MessageOpts`), so abandoning its stream leaves the agent
   * running. Answers the {@link InterruptReceipt} vocabulary — `not-running`
   * when there was no in-flight turn to abort.
   */
  interruptQuery(sessionId: string): Promise<InterruptReceipt>;
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
  /**
   * Take the session write-lock (`AgentRuntime.acquireLock`), answering whether
   * it was taken.
   *
   * An ATTENDED run holds it for the whole of its turn, for the reason a
   * person's turn does: it is the only seam that serializes against a DIFFERENT
   * writer, and a sticky task can resume the very session somebody is typing in
   * (`session/run-projection.ts`). A scheduled fire on a fresh session never
   * contends for it, and takes it uncontested.
   */
  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean;
  /** Give back a lock this run took (`AgentRuntime.releaseLock`). */
  releaseLock(sessionId: string, clientId: string, token?: symbol): void;
  /**
   * End a turn the runtime left open (`AgentRuntime.settleOpenTurn`). Absent for
   * a runtime that cannot strand one, which reads as "nothing to settle".
   */
  settleOpenTurn?(sessionId: string): Promise<boolean>;
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
