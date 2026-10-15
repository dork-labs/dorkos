/**
 * Pause an agent everywhere at once, and lift the pause (spec `audit-trail` PR5).
 *
 * A pause is one row in `agent_pauses` per paused agent, held in memory and
 * written through, so it survives a restart. Its history (who paused it, who
 * lifted it, and every turn it held back) lives in the audit log as
 * `agent.paused`, `agent.resumed` and `agent.turn_held`.
 *
 * ## What a pause does
 *
 * - **Stops what is running.** Every live turn of the agent, on every runtime,
 *   is interrupted, and every session the agent has live is ended from the
 *   runtime's own records (`AgentRuntime.endSessionsWhere`): its warm process,
 *   the background helpers and shells it started, the timers that would wake
 *   it. Its running scheduled runs are stopped. A turn the agent opens on its
 *   own after that is stopped as it opens (`hold-paused-turns.ts`).
 * - **Holds what comes next.** Nothing starts a new turn for it until somebody
 *   lifts the pause. The backstop is `hold-paused-turns.ts` at the runtime
 *   registration seam, which every turn passes; the entry points (a person's
 *   message, the scheduler, a room) refuse earlier with a clearer answer.
 * - **Leaves everything else alone.** The agent stays registered, readable and
 *   messageable. A held trigger is recorded once and dropped: lifting the pause
 *   never replays a pile of stale work at once.
 *
 * ## Who may do what
 *
 * Anyone, person or agent, may pause any agent, DorkBot included. Anyone may
 * lift a pause EXCEPT the paused agent itself, and a caller DorkOS cannot name
 * (an agent token that resolved to nobody) is refused too, because it could be
 * that agent. Every refusal is recorded.
 *
 * ## Which agent a turn belongs to
 *
 * The same answer every turn-path identity check gives (`toolActorOf` in the
 * audit's tool record): the agent whose home the turn stands in, so a worktree
 * or managed checkout of the agent counts as the agent, or the agent the turn
 * was dispatched as (`resolveAgentHome(cwd, turnAgentOf(opts))`).
 *
 * @module services/mesh/pause/agent-pause
 */
import path from 'node:path';
import { agentPauses, agents, eq, type Db } from '@dorkos/db';
import type { AuditActor, AuditSurface } from '@dorkos/shared/audit-schemas';
import type { AgentRuntime, LiveSessionRef, MessageOpts } from '@dorkos/shared/agent-runtime';
import {
  AGENT_PAUSE_REASON_MAX,
  AGENT_PAUSED_CODE,
  CANNOT_RESUME_SELF_CODE,
  type AgentPause,
  type AgentPauseResult,
} from '@dorkos/shared/mesh-schemas';
import { homeOf, resolveAgentHome, turnAgentOf } from '../../core/agent-identity/agent-home.js';
import { auditTrail, recordAudit } from '../../audit/audit-trail.js';
import { UNIDENTIFIED_ACCOUNT_ID } from '../../audit/account-ids.js';
import { logger } from '../../../lib/logger.js';

/** An agent as a pause names it. */
export interface PausedAgentRef {
  /** Mesh id. */
  id: string;
  /** Display name, else name. */
  name: string;
  /** When its pause began, when it is paused: each pause is new news. */
  pausedAt?: string;
}

/** The parts of a turn's options that say whose turn it is. */
export type TurnAgentOpts = Pick<MessageOpts, 'cwd' | 'forAgent' | 'roomTurn'> | undefined;

/**
 * How many sessions the hold remembers the agent of after their turn ended, so
 * a pause can still find a session whose folder is not the agent's home (one
 * dispatched AS the agent). The oldest is forgotten first.
 */
const REMEMBERED_SESSIONS = 2_000;

/** What started a turn the pause held back. */
export type HeldVia = 'message' | 'schedule' | 'room' | 'turn';

/** Where each kind of held trigger came in, for the audit row's source. */
const HELD_SURFACE: Record<HeldVia, AuditSurface> = {
  message: 'app',
  schedule: 'task',
  room: 'system',
  turn: 'system',
};

/** How each kind of held trigger reads in the audit row's summary. */
const HELD_LABEL: Record<HeldVia, string> = {
  message: 'a message',
  schedule: 'a scheduled run',
  room: 'a room turn',
  turn: 'a turn',
};

/** A turn that is running right now, so a pause can stop it. */
export interface LiveTurn {
  /** The session it runs in. */
  sessionId: string;
  /** The turn's options, read only when a pause asks whose turn it is. */
  opts: TurnAgentOpts;
  /** End it. Answers the runtime's receipt; only an acknowledged stop counts. */
  interrupt: () => Promise<{ outcome: string }>;
  /**
   * Set by a pause whatever the runtime answered. A turn still launching (its
   * runtime awaiting a sign-in or a settings read) answers `not-running`, so
   * the hold reads this at its next event and ends the turn itself.
   */
  stopRequested?: boolean;
}

/** A turn, message or run refused because its agent is paused. */
export class AgentPausedError extends Error {
  /** The code the app reads to offer Resume. */
  readonly code = AGENT_PAUSED_CODE;

  /**
   * Refuse on behalf of a paused agent.
   *
   * @param agent - The paused agent.
   */
  constructor(readonly agent: PausedAgentRef) {
    super(`${agent.name} is paused. Resume it before it can work again.`);
    this.name = 'AgentPausedError';
    this.pausedAt = agent.pausedAt;
  }

  /** When the pause began, so a surface can say so once per pause. */
  readonly pausedAt: string | undefined;
}

/** A paused agent (or a caller that could be it) tried to lift its own pause. */
export class CannotResumeSelfError extends Error {
  /** The code every surface answers with. */
  readonly code = CANNOT_RESUME_SELF_CODE;

  /**
   * Refuse a resume that could be the paused agent's own.
   *
   * @param message - The sentence every surface shows.
   */
  constructor(message: string) {
    super(message);
    this.name = 'CannotResumeSelfError';
  }
}

/** The agent named does not exist on this server. */
export class PauseAgentNotFoundError extends Error {
  /** The code every surface answers with. */
  readonly code = 'AGENT_NOT_FOUND';

  /**
   * Refuse an id no agent is registered under.
   *
   * @param agentId - The id nobody is registered under.
   */
  constructor(readonly agentId: string) {
    super(`No agent has the id "${agentId}".`);
    this.name = 'PauseAgentNotFoundError';
  }
}

/** What the pause service needs from the rest of the server. */
export interface AgentPauseServiceDeps {
  /** The consolidated database. */
  db: Db;
  /** Tell connected apps the paused set changed. */
  onChange?: () => void;
  /**
   * Every registered runtime, read when a pause lands so each can end the
   * agent's sessions from its own records. Absent in tests that do not care.
   */
  runtimes?: () => readonly Pick<AgentRuntime, 'type' | 'endSessionsWhere'>[];
}

/** Trim a reason to what the log keeps, or drop an empty one. */
function cleanReason(reason: string | undefined): string | undefined {
  const trimmed = reason?.trim();
  return trimmed ? trimmed.slice(0, AGENT_PAUSE_REASON_MAX) : undefined;
}

/**
 * The one owner of which agents are paused. See the module doc.
 */
export class AgentPauseService {
  private readonly pauses = new Map<string, AgentPause>();
  private readonly liveTurns = new Set<LiveTurn>();
  /** Which agent each session the hold ran belongs to, newest last. */
  private readonly sessionAgents = new Map<string, string>();
  private stopTaskRuns: ((agentId: string) => Promise<number>) | undefined;

  constructor(private readonly deps: AgentPauseServiceDeps) {
    for (const row of deps.db.select().from(agentPauses).all()) {
      this.pauses.set(row.agentId, {
        agentId: row.agentId,
        pausedBy: {
          accountId: row.pausedBy,
          kind: row.pausedByKind as AuditActor['kind'],
          name: row.pausedByName,
        },
        pausedAt: row.pausedAt,
        ...(row.reason ? { reason: row.reason } : {}),
      });
    }
  }

  /**
   * Wire the scheduler's stop, once it exists (it is built later in startup).
   *
   * @param stop - Stops every running scheduled run of one agent, answering how many.
   */
  setTaskRunStopper(stop: (agentId: string) => Promise<number>): void {
    this.stopTaskRuns = stop;
  }

  /** Every pause in force, oldest first. */
  list(): AgentPause[] {
    return [...this.pauses.values()].sort((a, b) => a.pausedAt.localeCompare(b.pausedAt));
  }

  /**
   * The pause on an agent, by mesh id or by its home folder.
   *
   * @param ref - A mesh id, or an absolute folder (a worktree of the home counts).
   */
  isPaused(ref: string): AgentPause | undefined {
    if (this.pauses.size === 0) return undefined;
    const direct = this.pauses.get(ref);
    if (direct || !path.isAbsolute(ref)) return direct;
    const home = homeOf(resolveAgentHome(ref));
    const id = home ? this.agentIdAt(home) : undefined;
    return id ? this.pauses.get(id) : undefined;
  }

  /**
   * A paused agent by mesh id, named for a refusal, or `undefined` when it is
   * not paused.
   *
   * @param agentId - The agent's mesh id.
   */
  pausedAgent(agentId: string): PausedAgentRef | undefined {
    return this.pausedRef(agentId);
  }

  /**
   * The paused agent a turn belongs to, or `undefined` when it is not paused.
   * Free when nothing is paused, which is almost always.
   *
   * @param opts - The turn's options.
   */
  pausedAgentOfTurn(opts: TurnAgentOpts): PausedAgentRef | undefined {
    if (this.pauses.size === 0) return undefined;
    const id = this.agentIdOfTurn(opts);
    return id ? this.pausedRef(id) : undefined;
  }

  /**
   * The paused agent a session belongs to, or `undefined` when it is not
   * paused: the turn's own folder or agent when it names one, else the agent
   * the hold last saw run there, else the folder the runtime stored for it.
   *
   * @param sessionId - The session.
   * @param storedCwd - Reads the session's stored folder from its runtime.
   * @param opts - The turn's options, when it has any.
   */
  pausedAgentOfSession(
    sessionId: string,
    storedCwd: () => string | undefined,
    opts?: TurnAgentOpts
  ): PausedAgentRef | undefined {
    if (this.pauses.size === 0) return undefined;
    const named = opts?.cwd || opts?.forAgent || opts?.roomTurn;
    const id = named
      ? this.agentIdOfTurn(opts)
      : (this.sessionAgents.get(sessionId) ?? this.agentIdOfCwd(safeRead(storedCwd)));
    return id ? this.pausedRef(id) : undefined;
  }

  /**
   * Remember a running turn until it ends, so a pause can stop it, and which
   * agent its session belongs to, so a pause can end the session after.
   *
   * @param turn - The turn.
   * @returns Forget it.
   */
  trackTurn(turn: LiveTurn): () => void {
    this.liveTurns.add(turn);
    this.rememberSession(turn);
    return () => {
      this.liveTurns.delete(turn);
    };
  }

  /**
   * Pause an agent everywhere: record it, stop its live turns and running
   * scheduled runs, and hold everything that would start one.
   *
   * Pausing an agent that is already paused changes nothing and records
   * nothing, but still stops anything that slipped in.
   *
   * @param agentId - The agent's mesh id.
   * @param actor - Who paused it.
   * @param reason - Why, when they said.
   * @throws {PauseAgentNotFoundError} When no agent has that id.
   */
  async pause(agentId: string, actor: AuditActor, reason?: string): Promise<AgentPauseResult> {
    const agent = this.requireAgent(agentId);
    const why = cleanReason(reason);
    let pause = this.pauses.get(agentId);
    const changed = pause === undefined;
    if (!pause) {
      pause = {
        agentId,
        pausedBy: actor,
        pausedAt: new Date().toISOString(),
        ...(why ? { reason: why } : {}),
      };
      this.deps.db
        .insert(agentPauses)
        .values({
          agentId,
          pausedBy: actor.accountId,
          pausedByKind: actor.kind,
          pausedByName: actor.name,
          pausedAt: pause.pausedAt,
          reason: why ?? null,
        })
        .onConflictDoNothing()
        .run();
      this.pauses.set(agentId, pause);
      // Where it came in (MCP, HTTP, the app) is the caller's scope's to say.
      recordAudit({
        actor,
        action: 'agent.paused',
        operation: 'modify',
        target: { type: 'agent', id: agentId, name: agent.name },
        outcome: 'ok',
        ...(why ? { reason: why } : {}),
        change: [{ field: 'paused', before: false, after: true }],
        summary: `Paused ${agent.name} everywhere`,
      });
    }
    const stoppedSessions = await this.interruptTurnsOf(agentId);
    for (const sessionId of await this.endSessionsOf(agentId)) stoppedSessions.add(sessionId);
    const stoppedTurns = stoppedSessions.size;
    const stoppedRuns = await this.stopRunsOf(agentId);
    if (changed) this.changed();
    logger.info('[agent-pause] paused', { agentId, stoppedTurns, stoppedRuns, changed });
    return { agentId, paused: true, changed, pause, stoppedTurns, stoppedRuns };
  }

  /**
   * Lift an agent's pause. What it was held from is not replayed.
   *
   * @param agentId - The agent's mesh id.
   * @param actor - Who lifted it. Never the paused agent itself.
   * @param reason - Why, when they said.
   * @throws {CannotResumeSelfError} When the actor is the paused agent, or an
   *   agent DorkOS cannot name. The refusal is recorded.
   * @throws {PauseAgentNotFoundError} When no agent has that id.
   */
  resume(agentId: string, actor: AuditActor, reason?: string): AgentPauseResult {
    const agent = this.requireAgent(agentId);
    const why = cleanReason(reason);
    const refusal =
      actor.kind === 'agent' && actor.accountId === agentId
        ? "An agent can't lift its own pause. Ask a person or another agent."
        : actor.accountId === UNIDENTIFIED_ACCOUNT_ID
          ? "DorkOS can't tell which agent is asking, so it can't lift this pause."
          : null;
    if (refusal) {
      // Where it came in (MCP, HTTP, the app) is the caller's scope's to say.
      recordAudit({
        actor,
        action: 'agent.resumed',
        operation: 'modify',
        target: { type: 'agent', id: agentId, name: agent.name },
        outcome: 'refused',
        error: CANNOT_RESUME_SELF_CODE,
        ...(why ? { reason: why } : {}),
        summary: `Refused to lift ${agent.name}'s pause: ${refusal}`,
      });
      throw new CannotResumeSelfError(refusal);
    }
    if (!this.pauses.has(agentId)) return { agentId, paused: false, changed: false };
    this.deps.db.delete(agentPauses).where(eq(agentPauses.agentId, agentId)).run();
    this.pauses.delete(agentId);
    recordAudit({
      actor,
      action: 'agent.resumed',
      operation: 'modify',
      target: { type: 'agent', id: agentId, name: agent.name },
      outcome: 'ok',
      ...(why ? { reason: why } : {}),
      change: [{ field: 'paused', before: true, after: false }],
      summary: `Lifted ${agent.name}'s pause`,
    });
    this.changed();
    logger.info('[agent-pause] resumed', { agentId });
    return { agentId, paused: false, changed: true };
  }

  /**
   * Drop an agent's pause because the agent itself is gone (unregistered or
   * deleted), so no row outlives it. Nobody lifted the pause, so nothing is
   * recorded as a resume; the unregister is the record.
   *
   * @param agentId - The agent's mesh id.
   * @returns Whether it was paused.
   */
  forget(agentId: string): boolean {
    if (!this.pauses.has(agentId)) return false;
    this.deps.db.delete(agentPauses).where(eq(agentPauses.agentId, agentId)).run();
    this.pauses.delete(agentId);
    for (const [sessionId, owner] of this.sessionAgents) {
      if (owner === agentId) this.sessionAgents.delete(sessionId);
    }
    this.changed();
    logger.info('[agent-pause] dropped the pause of a removed agent', { agentId });
    return true;
  }

  /**
   * Record one trigger the pause held back, so nothing is dropped silently.
   * Recorded by DorkOS itself: nobody acted, a turn simply did not start.
   *
   * @param agent - The paused agent.
   * @param held - What was held, and where it came from.
   */
  recordHeld(
    agent: PausedAgentRef,
    held: { via: HeldVia; sessionId?: string; runtime?: string; taskRunId?: string }
  ): void {
    const trail = auditTrail();
    if (!trail) return;
    trail.log.record({
      actor: trail.accounts.system(),
      source: {
        surface: HELD_SURFACE[held.via],
        ...(held.runtime ? { runtime: held.runtime } : {}),
        ...(held.sessionId ? { sessionId: held.sessionId } : {}),
        ...(held.taskRunId ? { taskRunId: held.taskRunId } : {}),
      },
      action: 'agent.turn_held',
      operation: 'execute',
      target: { type: 'agent', id: agent.id, name: agent.name },
      outcome: 'refused',
      error: AGENT_PAUSED_CODE,
      summary: `Held ${HELD_LABEL[held.via]} for ${agent.name}: it is paused`,
    });
  }

  /**
   * Stop one session of a paused agent now: its turn, and everything its
   * runtime holds for it. For a turn the agent opened on its own.
   *
   * @param runtime - The runtime the session runs on.
   * @param sessionId - The session.
   * @param agent - The paused agent, for the log line.
   */
  async stopSession(
    runtime: Pick<AgentRuntime, 'interruptQuery' | 'endSessionsWhere'>,
    sessionId: string,
    agent: PausedAgentRef
  ): Promise<void> {
    try {
      await runtime.interruptQuery(sessionId);
      await runtime.endSessionsWhere((session) => session.sessionId === sessionId);
    } catch (err) {
      logger.warn('[agent-pause] could not stop a turn the agent started', {
        agentId: agent.id,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The agent a turn belongs to, by mesh id. */
  private agentIdOfTurn(opts: TurnAgentOpts): string | undefined {
    const home = homeOf(resolveAgentHome(opts?.cwd, turnAgentOf(opts)));
    return home ? this.agentIdAt(home) : undefined;
  }

  /** The agent whose home (or a worktree of it) a folder is, by mesh id. */
  private agentIdOfCwd(cwd: string | undefined): string | undefined {
    return cwd ? this.agentIdOfTurn({ cwd }) : undefined;
  }

  /** Note which agent a session belongs to, forgetting the oldest past the cap. */
  private rememberSession(turn: LiveTurn): void {
    let agentId: string | undefined;
    try {
      agentId = this.agentIdOfTurn(turn.opts);
    } catch {
      agentId = undefined;
    }
    if (!agentId) return;
    this.sessionAgents.delete(turn.sessionId);
    this.sessionAgents.set(turn.sessionId, agentId);
    if (this.sessionAgents.size > REMEMBERED_SESSIONS) {
      const oldest = this.sessionAgents.keys().next().value;
      if (oldest !== undefined) this.sessionAgents.delete(oldest);
    }
  }

  /** The mesh id of the agent registered at a home folder. */
  private agentIdAt(home: string): string | undefined {
    return this.deps.db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.projectPath, home))
      .get()?.id;
  }

  /** An agent by mesh id, named as the team names it, or `undefined`. */
  private agentRef(agentId: string): PausedAgentRef | undefined {
    const row = this.deps.db
      .select({ id: agents.id, name: agents.name, displayName: agents.displayName })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get();
    return row ? { id: row.id, name: row.displayName || row.name } : undefined;
  }

  /** A paused agent, named, with when its pause began; `undefined` when not paused. */
  private pausedRef(agentId: string): PausedAgentRef | undefined {
    const pause = this.pauses.get(agentId);
    const agent = pause ? this.agentRef(agentId) : undefined;
    return agent && pause ? { ...agent, pausedAt: pause.pausedAt } : undefined;
  }

  private requireAgent(agentId: string): PausedAgentRef {
    const agent = this.agentRef(agentId);
    if (!agent) throw new PauseAgentNotFoundError(agentId);
    return agent;
  }

  /**
   * Interrupt every live turn of one agent. Answers the sessions whose stop the
   * runtime acknowledged: a stop that failed, or found nothing running, is
   * not counted.
   */
  private async interruptTurnsOf(agentId: string): Promise<Set<string>> {
    const mine = [...this.liveTurns].filter((turn) => {
      try {
        return this.agentIdOfTurn(turn.opts) === agentId;
      } catch {
        return false;
      }
    });
    const stopped = new Set<string>();
    for (const turn of mine) turn.stopRequested = true;
    await Promise.all(
      mine.map(async (turn) => {
        try {
          const receipt = await turn.interrupt();
          if (receipt.outcome === 'acked' || receipt.outcome === 'closed') {
            stopped.add(turn.sessionId);
          }
        } catch (err) {
          logger.warn('[agent-pause] could not interrupt a turn', {
            agentId,
            sessionId: turn.sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
    );
    return stopped;
  }

  /**
   * Ask every runtime to end the sessions it holds live for one agent, read
   * from its own records: a session in the agent's home or a worktree of it,
   * or one the hold saw run as the agent. Answers the sessions that ended.
   */
  private async endSessionsOf(agentId: string): Promise<Set<string>> {
    const ended = new Set<string>();
    const byCwd = new Map<string, string | undefined>();
    const belongs = (session: LiveSessionRef): boolean => {
      // A session the hold saw run as some agent is that agent's, whatever
      // folder it stands in: another agent's session in this home is not ours.
      const owner = this.sessionAgents.get(session.sessionId);
      if (owner !== undefined) return owner === agentId;
      if (!session.cwd) return false;
      if (!byCwd.has(session.cwd)) byCwd.set(session.cwd, this.agentIdOfCwd(session.cwd));
      return byCwd.get(session.cwd) === agentId;
    };
    for (const runtime of this.deps.runtimes?.() ?? []) {
      try {
        for (const sessionId of await runtime.endSessionsWhere(belongs)) ended.add(sessionId);
      } catch (err) {
        logger.warn('[agent-pause] a runtime could not end the agent’s sessions', {
          agentId,
          runtime: runtime.type,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return ended;
  }

  private async stopRunsOf(agentId: string): Promise<number> {
    if (!this.stopTaskRuns) return 0;
    try {
      return await this.stopTaskRuns(agentId);
    } catch (err) {
      logger.warn('[agent-pause] could not stop scheduled runs', {
        agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  private changed(): void {
    try {
      this.deps.onChange?.();
    } catch {
      // Telling the apps is never worth the pause.
    }
  }
}

/** Read a value that must never fail the caller. */
function safeRead(read: () => string | undefined): string | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

let active: AgentPauseService | undefined;

/**
 * Make the pause service reachable server-wide. Called once at startup.
 *
 * @param service - The service.
 */
export function initAgentPause(service: AgentPauseService): void {
  active = service;
}

/** Forget the pause service. For tests. */
export function resetAgentPause(): void {
  active = undefined;
}

/** The pause service, or `undefined` before {@link initAgentPause} (nothing is paused). */
export function agentPause(): AgentPauseService | undefined {
  return active;
}
