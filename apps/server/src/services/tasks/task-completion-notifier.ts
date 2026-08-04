/**
 * System-level task-completion notifications (DOR-240).
 *
 * Fired by the single {@link TaskStore} run-terminal hook, this service turns a
 * finished Task run into a proactive integration message — with zero agent
 * cooperation. It resolves the linked agent's bound integration through the shared
 * {@link resolveNotifyTarget} resolver (so it honors the same binding,
 * active-session, and `canInitiate` consent gates as `relay_notify_user`) and
 * delivers via `RelayCore.publish` with a bounded budget, inheriting the relay
 * pipeline's budget gate, dead-lettering, and access control for free.
 *
 * Policy: failures always notify; successes notify only when the resolved
 * binding opted in (`notifyOnTaskComplete`); cancellations never notify. Every
 * "cannot deliver" outcome (relay off, no binding, no chat session,
 * `canInitiate` off, over-budget) is a silent no-op that never errors a run.
 *
 * A resolved target whose chat is bridged (chats-as-channels spec §7.5)
 * publishes under `relay.bridge.initiate.*` instead of the fixed
 * {@link TASK_NOTIFIER_PRINCIPAL} — see {@link resolveNotifyTarget}'s
 * `bridged` flag — so the send still reads as a "scheduled task" INITIATE
 * through the bridge consent branch rather than the exempt system principal
 * quietly bypassing it.
 *
 * @module services/tasks/task-completion-notifier
 */
import type { Task, TaskRun } from '@dorkos/shared/types';
import { formatDuration } from '../../lib/format-duration.js';
import { createTaggedLogger } from '../../lib/logger.js';
import { isRelayEnabled } from '../relay/relay-state.js';
import {
  resolveNotifyTarget,
  type NotifyTargetBindingStore,
  type NotifyTargetBindingRouter,
  type NotifyTargetAdapterManager,
  type NotifyTargetBridgeStore,
} from '../relay/notify-target.js';
import { buildBridgePrincipal } from '../relay/bridge-principal.js';

/** Relay `from` principal for automatic task-completion notifications. */
const TASK_NOTIFIER_PRINCIPAL = 'relay.system.tasks.notifier';

/** Max characters for a completion message body (glanceable, no wall of text). */
const MESSAGE_MAX_CHARS = 200;

/** Minimal relay publisher surface — one bounded publish. */
export interface NotifierRelayPublisher {
  publish(
    subject: string,
    payload: unknown,
    options: {
      from: string;
      budget?: { maxHops?: number; ttl?: number; callBudgetRemaining?: number };
    }
  ): Promise<{ deliveredTo: number }>;
}

/** Minimal task-store surface — read a task by id when the hook passes null. */
export interface NotifierTaskStore {
  getTask(id: string): Task | null;
}

/** Structured logger surface (a consola instance satisfies this). */
export interface NotifierLogger {
  debug: (...args: unknown[]) => void;
}

/** Dependencies for {@link TaskCompletionNotifier} (all optional-tolerant). */
export interface TaskCompletionNotifierDeps {
  bindingStore?: NotifyTargetBindingStore;
  bindingRouter?: NotifyTargetBindingRouter;
  adapterManager?: NotifyTargetAdapterManager;
  /** Live bridge rows, so a bridged chat still resolves once its session vacates `sessionMap` (§7.5). */
  bridgeStore?: NotifyTargetBridgeStore;
  relayCore?: NotifierRelayPublisher;
  /** Reads the task when the terminal hook could not supply it. */
  taskStore?: NotifierTaskStore;
  logger?: NotifierLogger;
  /** Overridable for tests; defaults to the global relay feature flag. */
  isRelayEnabled?: () => boolean;
}

/**
 * Turn a finished Task run into a proactive completion message on the linked
 * agent's bound integration.
 */
export class TaskCompletionNotifier {
  private readonly deps: TaskCompletionNotifierDeps;
  private readonly logger: NotifierLogger;
  private readonly relayEnabled: () => boolean;

  constructor(deps: TaskCompletionNotifierDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? createTaggedLogger('TaskNotifier');
    this.relayEnabled = deps.isRelayEnabled ?? isRelayEnabled;
  }

  /**
   * Handle a run that just reached a terminal status. Never throws — every
   * failure to deliver is swallowed and logged at debug so a notification issue
   * can never corrupt run persistence.
   *
   * @param run - The run that reached a terminal status.
   * @param task - The run's task when the hook knew it, else null (looked up).
   */
  async handle(run: TaskRun, task: Task | null): Promise<void> {
    try {
      // Cancellations are user-initiated — the user already knows. Never notify.
      if (run.status === 'cancelled') return;
      // Only completed/failed runs notify; a non-terminal write never reaches here.
      if (run.status !== 'completed' && run.status !== 'failed') return;

      if (!this.relayEnabled()) return;
      const { relayCore, bindingStore, bindingRouter } = this.deps;
      if (!relayCore || !bindingStore || !bindingRouter) return;

      const resolvedTask = task ?? this.deps.taskStore?.getTask(run.scheduleId) ?? null;
      const agentId = resolvedTask?.agentId ?? null;
      // Global (agent-less) tasks have no binding to resolve — no notification in v1.
      if (!agentId) return;

      const target = resolveNotifyTarget(agentId, {
        bindingStore,
        bindingRouter,
        adapterManager: this.deps.adapterManager,
        bridgeStore: this.deps.bridgeStore,
      });
      if (!target.ok) {
        this.logger.debug(`skip run ${run.id}: cannot resolve integration (${target.reason})`);
        return;
      }

      // Failures always notify; successes require the per-integration opt-in.
      if (run.status === 'completed' && !target.notifyOnTaskComplete) {
        this.logger.debug(`skip completed run ${run.id}: notifyOnTaskComplete is off`);
        return;
      }

      const message = formatCompletionMessage(resolvedTask, run);
      // A completion ping is a terminal leaf (no downstream agent turn), so a
      // minimal budget is correct; the PR #210 gate rejects + dead-letters if
      // ever over budget rather than dispatching.
      //
      // A bridged target (§7.5) publishes under the bridge delivery principal
      // instead of the fixed system one — this is a "scheduled task" send with
      // no inbound cascade root, so it classifies as an INITIATE (spec §6.6)
      // and must be gated as one, not slip through under an exemption that
      // predates bridges.
      const from = target.bridged
        ? buildBridgePrincipal('initiate', target.adapterId, target.chatId)
        : TASK_NOTIFIER_PRINCIPAL;
      const result = await relayCore.publish(target.subject, message, {
        from,
        budget: { maxHops: 2, ttl: Date.now() + 30_000, callBudgetRemaining: 1 },
        // A bridged target publishes under `relay.bridge.initiate.*`; assert the
        // DOR-889 trust marker so the pipeline guard admits this trusted server
        // publisher. Inert (and omitted) on the non-bridged system principal.
        ...(target.bridged ? { serverBridgePrincipal: true } : {}),
      });
      if (result.deliveredTo === 0) {
        this.logger.debug(`run ${run.id} notification not delivered (rejected or queued)`);
      }
    } catch (err) {
      this.logger.debug(`run ${run.id} notification failed`, err);
    }
  }
}

/**
 * First non-empty line of a block of text, trimmed. Keeps a completion message
 * to a single glanceable sentence rather than shipping full run output.
 */
function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Build the completion message body (writing-for-humans; control-panel tone).
 *
 * Shape: one status emoji + task name + duration + the first line of output (on
 * success) or error (on failure), truncated to keep it glanceable.
 *
 * @param task - The run's task, for its display name (may be null).
 * @param run - The finished run, for status, duration, and output/error.
 */
export function formatCompletionMessage(task: Task | null, run: TaskRun): string {
  const name = task?.displayName?.trim() || task?.name || 'Task';
  const duration = run.durationMs != null ? formatDuration(run.durationMs) : null;

  let body: string;
  if (run.status === 'failed') {
    const detail = firstLine(run.error) ?? firstLine(run.outputSummary);
    body =
      `⚠️ ${name} — failed${duration ? ` after ${duration}` : ''}.` + (detail ? ` ${detail}` : '');
  } else {
    const detail = firstLine(run.outputSummary);
    body = `✅ ${name} — done${duration ? ` in ${duration}` : ''}.` + (detail ? ` ${detail}` : '');
  }

  return truncate(body, MESSAGE_MAX_CHARS);
}

/** Truncate to `max` characters, appending an ellipsis when it had to cut. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
