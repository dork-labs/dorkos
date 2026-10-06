/**
 * An agent asking for its own conversation to be summarized (DOR-2732).
 *
 * A coordinator agent reached 89% of its context window, could see it, and had
 * no way to act: only the person could type `/compact`. This is the agent's
 * half of that verb. It decides whether a request may be scheduled, and hands
 * an accepted one to the dispatcher, which runs it once the asking turn has
 * ended ({@link scheduleAgentCompaction}).
 *
 * ## Only ever the caller's own conversation
 *
 * The session is the one the call ARRIVED from (`CapabilityHandlerContext.sessionId`,
 * set by the in-session server from the verified turn). There is no session
 * argument, so there is nothing to point at another conversation. A call with
 * no session, or a session that is not loaded, is refused with a plain reason.
 *
 * ## The checks, in order
 *
 * 1. A session, and a loaded one.
 * 2. A runtime that can summarize on request — the same capability flag the
 *    person's `/compact` reads. Codex compacts on its own and has no way to be
 *    asked: its sessions are not offered the tool at all, and a call that
 *    reaches here anyway is refused honestly rather than accepted and dropped.
 * 3. Not already scheduled — "already scheduled" spends nothing.
 * 4. The once-an-hour allowance ({@link CompactionRequestBudget}).
 *
 * Whether this agent may ask at all is not decided here. It is a permission
 * (`session.compact`, Own chat area, default Allowed): the gate inside
 * `registry.invoke` refuses a Blocked agent before this code runs, and only a
 * person can change the setting. It is asked once more just before the
 * summary starts, because the owner may have blocked it in between.
 *
 * The compaction itself is the person's `/compact`, run through the same
 * `dispatchCommandIntent` path with the runtime's own mechanism; the only
 * difference is the tag it stamps on the boundary so the chat can say the agent
 * asked.
 *
 * @module services/session/agent-compaction/agent-compaction-service
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import { logger } from '../../../lib/logger.js';
import { percentOfContext } from './context-warning.js';
import {
  dispatchCommandIntent,
  hasPendingAgentCompaction,
  scheduleAgentCompaction,
} from '../message-dispatcher.js';
import { persistenceModeFor } from '../projector-persistence.js';
import { getOrCreateProjector, peekProjector } from '../session-state-projector.js';
import { primaryOf } from '../session-key-registry.js';
import { CompactionRequestBudget } from './compaction-budget.js';
import { isCompactionBlocked } from './compaction-permission.js';

/**
 * The lock identity an agent-requested compaction runs under. Its own, so it
 * never shares a per-client wait chain with the person's window or the agent's
 * turn, and a lock-holder report names what is running.
 */
export const AGENT_COMPACTION_CLIENT_ID = 'dorkos:agent-compaction';

/** Why a request was refused. */
export type CompactionRefusalCode =
  'no-session' | 'unknown-session' | 'unsupported' | 'rate-limited';

/** What a request came to, as the agent reads it. */
export type CompactionRequestOutcome =
  | { status: 'scheduled' | 'already-scheduled'; message: string }
  | { status: 'refused'; code: CompactionRefusalCode; message: string; retryAfter?: string };

/** What the service reads from the rest of the server. */
export interface AgentCompactionServiceDeps {
  /** The runtime a session resolves to (`runtimeRegistry.resolveForSession`). */
  resolveRuntime(sessionId: string): Promise<AgentRuntime>;
  /** The once-an-hour allowance; one per process. */
  budget?: CompactionRequestBudget;
  /**
   * Whether the agent is blocked from asking, re-checked just before the
   * summary starts. Defaults to the real permission resolution; a seam for tests.
   */
  isBlocked?: (agentPath: string | undefined) => Promise<boolean>;
}

/** How each runtime is named in a refusal; an unknown type is named as itself. */
const RUNTIME_NAMES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

/** Decides and schedules agent-requested summaries. Build one per process. */
export class AgentCompactionService {
  private readonly budget: CompactionRequestBudget;

  /**
   * Build the service with its own budget unless one is supplied.
   *
   * @param deps - See {@link AgentCompactionServiceDeps}.
   */
  constructor(private readonly deps: AgentCompactionServiceDeps) {
    this.budget = deps.budget ?? new CompactionRequestBudget();
  }

  /**
   * Ask for the caller's own conversation to be summarized after its turn.
   *
   * @param opts.sessionId - The verified invoking session, or undefined when
   *   the call came from a surface that has none.
   * @param opts.note - What the summary should keep, used as the focus where
   *   the runtime takes one.
   * @param opts.agentPath - The calling agent's home, when the call carried an
   *   identity: whose permission is re-checked before the summary starts.
   */
  async request(opts: {
    sessionId?: string;
    note?: string;
    agentPath?: string;
  }): Promise<CompactionRequestOutcome> {
    const { sessionId, note, agentPath } = opts;
    if (!sessionId) {
      return refused(
        'no-session',
        'This call did not come from a conversation, so there is nothing to summarize. Nothing was scheduled.'
      );
    }

    const runtime = await this.deps.resolveRuntime(sessionId);
    // Loaded means the runtime holds it, or a turn is open on it right now —
    // which is always true of the conversation an agent is calling from.
    const turnOpen = (peekProjector(sessionId)?.peekInProgressTurn() ?? null) !== null;
    if (!runtime.hasSession(sessionId) && !turnOpen) {
      return refused(
        'unknown-session',
        `Conversation ${sessionId} is not loaded, so it cannot be summarized. Nothing was scheduled.`
      );
    }

    const caps = runtime.getCapabilities();
    if (!caps.commandIntents.compact.supported) {
      const name = RUNTIME_NAMES[caps.type] ?? caps.type;
      return refused(
        'unsupported',
        `${name} cannot summarize a conversation on request; it does so on its own when the ` +
          'conversation fills up. Nothing was scheduled. Keep saving what matters to your memory.'
      );
    }

    if (hasPendingAgentCompaction(sessionId, runtime)) {
      return {
        status: 'already-scheduled',
        message:
          'A summary is already scheduled for when this turn ends. Nothing more was scheduled.',
      };
    }

    const sessionKey = primaryOf(runtime.getInternalSessionId(sessionId) ?? sessionId);
    const reservation = this.budget.tryReserve(sessionKey);
    if (!reservation.ok) {
      const retryAfter = new Date(reservation.retryAt).toISOString();
      return {
        ...refused(
          'rate-limited',
          `A summary can be asked for once an hour, and this conversation already had one. ` +
            `You can ask again after ${retryAfter}. Nothing was scheduled.`
        ),
        retryAfter,
      };
    }

    // Read now, while the reading still describes the conversation the agent
    // looked at; by the time the summary runs, the turn has added to it.
    const contextPercent = percentOfContext(
      (peekProjector(sessionId) ?? peekProjector(sessionKey))?.getStatus().contextUsage
    );
    const instructions = note?.trim() ? note.trim() : undefined;
    const requestedAt = new Date().toISOString();

    const isBlocked = this.deps.isBlocked ?? isCompactionBlocked;
    const scheduled = scheduleAgentCompaction({
      sessionId,
      runtime,
      // The gate let the call through, but the summary may start much later:
      // if the owner blocked it in between, it does not run.
      admit: async () => !(await isBlocked(agentPath)),
      // Nothing was summarized for it, so the hour is not spent.
      onDropped: () => this.budget.refund(sessionKey, reservation.at),
      launch: () => {
        // Same projector and persistence the person's `/compact` uses
        // (`session-command-intent-handler.ts`), so the boundary survives a restart.
        const cwd = peekProjector(sessionId)?.cwd ?? DEFAULT_CWD;
        const projector = getOrCreateProjector(sessionId, cwd, {
          persist: persistenceModeFor(caps),
        });
        return dispatchCommandIntent({
          sessionId,
          clientId: AGENT_COMPACTION_CLIENT_ID,
          intent: 'compact',
          cwd,
          ...(instructions !== undefined ? { instructions } : {}),
          projector,
          runtime,
          boundaryTag: {
            requestedBy: 'agent',
            requestedAt,
            ...(contextPercent !== null ? { contextPercent } : {}),
          },
          onError: (err) => {
            logger.warn('[agent-compaction] the summary run failed', {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        });
      },
    });

    if (!scheduled) {
      // The dispatcher is the authority on what is waiting. The check above
      // answers first so "already scheduled" never spends the hour; if the two
      // ever disagree, this request gets its allowance back.
      this.budget.refund(sessionKey, reservation.at);
      return {
        status: 'already-scheduled',
        message:
          'A summary is already scheduled for when this turn ends. Nothing more was scheduled.',
      };
    }

    return {
      status: 'scheduled',
      message:
        'Scheduled. This conversation will be summarized after this turn ends' +
        (instructions !== undefined
          ? ', keeping your note as the focus where the runtime supports one'
          : '') +
        '. Detail you have not saved to your memory will not survive the summary.',
    };
  }
}

/** A refusal with nothing scheduled. */
function refused(
  code: CompactionRefusalCode,
  message: string
): Extract<CompactionRequestOutcome, { status: 'refused' }> {
  return { status: 'refused', code, message };
}
