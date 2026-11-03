/**
 * Starting the agent turns to-dos ask for (DOR-3088, Security's Musts 1, 2, 4 and 5), with caps
 * that hold on their own, whatever the rooms' limits are set to:
 *
 * - **Depth 2.** A to-do deeper than {@link TODO_TURN_MAX_DEPTH} starts nothing; it waits for the
 *   person.
 * - **10 a day per charge.** Every turn is charged to whoever made the change that asked for it:
 *   the agent that assigned or reassigned the to-do, or an outsider (`outsider:<id>`). Only the
 *   person who owns this DorkOS is never charged. Past 10 in a UTC day the turn is queued for the
 *   next one. Counted from `todo_turns`, never from the room settings.
 * - **No self-assigned turns.** A note to self never starts one.
 * - **Shares the rooms' limits.** A charged turn also asks the rooms' turn budget, keyed by its
 *   charge, so it counts in the install's wallet when that is on. With the rooms' limits off
 *   (`rooms.turnLimitsEnabled: false`) the budget answers yes without counting, and the caps above
 *   still hold. A budget refusal is hourly, so the turn waits to retry rather than being dropped.
 *
 * A paused agent's to-do is held, and resuming the agent wakes nothing: the person reassigns or
 * reopens it (Security's Should).
 *
 * @module services/commitments/todo-turns
 */
import { ulid } from 'ulidx';
import {
  and,
  chatMessages,
  eq,
  inArray,
  sessionStartedBy,
  todoTurns,
  type CommitmentRow,
  type Db,
  type TodoTurnRow,
} from '@dorkos/db';
import type { TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { logger } from '../../lib/logger.js';
import { todoTurnDecision, todoTurnPower, TODO_TURN_MAX_DEPTH } from './todo-turn-power.js';
import { buildTodoTurnPrompt, type TodoSourceText } from './todo-turn-prompt.js';
import type { TodoParent } from './todo-service.js';

/**
 * How many hops back `parentOf` looks for the to-do a chat descends from. A chain longer than this
 * through spin-offs and messages is deeper than any cap lets a to-do go.
 */
const TODO_CHAIN_HOPS = 8;

/** How many chats `parentOf` reads in all, so a chat many others messaged stays cheap to check. */
const TODO_CHAIN_CHATS = 64;

/** How many to-do turns one charge may start in a UTC day. */
export const TODO_TURNS_PER_ASSIGNER_PER_DAY = 10;

/** What launching a to-do turn is given. */
export interface TodoTurnLaunch {
  /** The to-do. */
  readonly todoId: string;
  /** The agent to run it. */
  readonly agentId: string;
  /** The message it starts with. */
  readonly content: string;
  /** Every bound that holds, or undefined for the agent's own level. */
  readonly permissionCeiling: TurnPermissionCeiling | undefined;
  /** The outsider mark, carried on. */
  readonly carriedMarks: { outsider: true } | undefined;
}

/** What the turns are built from. */
export interface TodoTurnsDeps {
  /** The DorkOS database (`todo_turns`). */
  readonly db: Db;
  /** Start the turn; resolves with the chat it runs in, or rejects. */
  launch(request: TodoTurnLaunch): Promise<{ sessionId: string }>;
  /** Whether an agent is paused. */
  isPaused(agentId: string): boolean;
  /**
   * The rooms' shared turn budget for a charge: `false` when the install's agent-to-agent limit is
   * spent this hour. Answers `true` without counting when those limits are off.
   */
  sharedBudget(chargedTo: string): boolean;
  /**
   * The source message's text, read by the server from the room, and only when the agent running
   * the turn is a member of that room. Undefined otherwise.
   */
  readSource(entryId: string, agentId: string): TodoSourceText | undefined;
  /** The clock (tests pin it). */
  readonly now?: () => Date;
}

/** What happened when a to-do asked for a turn. */
export type TodoTurnOutcome =
  | { readonly status: 'started'; readonly sessionId: string }
  | { readonly status: 'queued' }
  | { readonly status: 'retry'; readonly reason: string }
  | { readonly status: 'held'; readonly reason: string }
  | { readonly status: 'none'; readonly reason: string };

/** `YYYY-MM-DD` in UTC. */
function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Starts, queues and holds to-do turns. */
export class TodoTurns {
  private readonly now: () => Date;

  /**
   * Build the turns.
   *
   * @param deps - The database, the launcher and the lookups.
   */
  constructor(private readonly deps: TodoTurnsDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * A to-do now asks an agent to act: start its turn, or say why not.
   *
   * @param row - The stored to-do, as it now stands.
   * @param chargedTo - Whose spend the turn counts against: the acting agent, `outsider:<id>`, or
   *   null for the person who owns this DorkOS.
   */
  async request(row: CommitmentRow, chargedTo: string | null): Promise<TodoTurnOutcome> {
    const decision = todoTurnDecision(row);
    if (decision.kind === 'none') return { status: 'none', reason: decision.reason };
    const agentId = row.agentId!;
    if (decision.kind === 'hold') {
      this.record(row, agentId, chargedTo, 'held', `depth over ${TODO_TURN_MAX_DEPTH}`);
      return { status: 'held', reason: 'depth' };
    }
    if (this.deps.isPaused(agentId)) {
      this.record(row, agentId, chargedTo, 'held', 'paused');
      return { status: 'held', reason: 'paused' };
    }
    if (chargedTo !== null) {
      if (this.startedToday(chargedTo) >= TODO_TURNS_PER_ASSIGNER_PER_DAY) {
        this.record(row, agentId, chargedTo, 'queued', 'daily cap');
        return { status: 'queued' };
      }
      if (!this.deps.sharedBudget(chargedTo)) {
        this.record(row, agentId, chargedTo, 'retry', 'rooms budget');
        return { status: 'retry', reason: 'rooms budget' };
      }
    }
    return this.start(row, agentId, chargedTo);
  }

  /**
   * Try again every turn that is waiting: those queued on an earlier day, and those a passing
   * refusal left to retry. Oldest first, under the same caps. Each waiting row is claimed by
   * deleting it, so two overlapping checks never start the same one twice; a to-do closed or
   * reassigned since is dropped.
   *
   * @param readTodo - Read a to-do's current row.
   */
  async drainQueued(readTodo: (id: string) => CommitmentRow | undefined): Promise<void> {
    const today = utcDay(this.now());
    const waiting = this.deps.db
      .select()
      .from(todoTurns)
      .where(inArray(todoTurns.status, ['queued', 'retry']))
      .all()
      .filter((turn) => turn.status === 'retry' || turn.day < today)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const seen = new Set<string>();
    for (const turn of waiting) {
      const claimed = this.deps.db.delete(todoTurns).where(eq(todoTurns.id, turn.id)).run();
      if (claimed.changes === 0) continue;
      // One to-do reopened while capped can be waiting more than once: it runs once.
      if (seen.has(turn.todoId)) continue;
      seen.add(turn.todoId);
      const row = readTodo(turn.todoId);
      if (!row || row.agentId !== turn.agentId) continue;
      await this.request(row, turn.chargedTo);
    }
  }

  /**
   * The chain a to-do made from a chat continues (Must 5, Security's PR 4 G1): the to-do turns that
   * chat descends from, read from the server's own records, never from the caller. It walks back
   * through every hop a chain can take to reach another agent: a spin-off (`session_start`, via
   * `session_started_by`) and a message one chat sent another (`chat_send`, via `chat_messages`).
   *
   * Every to-do turn found contributes its depth and chain. An agent that sent a message on the way
   * joins the chain only when the chat it sent from itself descends from a to-do turn, so
   * A → B → (a chat B messaged) → A is refused like A → B → A, while an unrelated message into the
   * same chat adds nobody. Undefined for a chat no to-do turn led to.
   *
   * At most {@link TODO_CHAIN_HOPS} hops back and {@link TODO_CHAIN_CHATS} chats in all.
   *
   * @param sessionId - The calling chat.
   * @param readTodo - Read a to-do's current row.
   */
  parentOf(
    sessionId: string,
    readTodo: (id: string) => CommitmentRow | undefined
  ): TodoParent | undefined {
    const graph = this.ancestry(sessionId, readTodo);
    if (graph.turns.size === 0) return undefined;
    const reaches = new Map<string, boolean>();
    const reachesTurn = (chat: string, path: Set<string>): boolean => {
      const known = reaches.get(chat);
      if (known !== undefined) return known;
      if (graph.turns.has(chat)) return reaches.set(chat, true).get(chat)!;
      if (path.has(chat)) return false;
      path.add(chat);
      const found = (graph.parents.get(chat) ?? []).some((edge) => reachesTurn(edge.from, path));
      path.delete(chat);
      reaches.set(chat, found);
      return found;
    };
    let depth = -1;
    let capped = false;
    const agents = new Set<string>();
    for (const { row, agentId } of graph.turns.values()) {
      depth = Math.max(depth, row.chainDepth);
      for (const id of JSON.parse(row.chainAgents) as string[]) agents.add(id);
      agents.add(agentId);
      const power = todoTurnPower(row);
      if (power.ceiling !== undefined || power.carriedMarks !== undefined) capped = true;
    }
    for (const edges of graph.parents.values()) {
      for (const edge of edges) {
        if (edge.agentId && reachesTurn(edge.from, new Set())) agents.add(edge.agentId);
      }
    }
    return { depth, agents: [...agents], capped };
  }

  /** The chats a chat descends from, with the to-do turns among them, read from the ledger. */
  private ancestry(
    sessionId: string,
    readTodo: (id: string) => CommitmentRow | undefined
  ): {
    turns: Map<string, { row: CommitmentRow; agentId: string }>;
    parents: Map<string, { from: string; agentId: string | null }[]>;
  } {
    const db = this.deps.db;
    const turns = new Map<string, { row: CommitmentRow; agentId: string }>();
    const parents = new Map<string, { from: string; agentId: string | null }[]>();
    const seen = new Set<string>([sessionId]);
    let frontier = [sessionId];
    for (let hop = 0; hop < TODO_CHAIN_HOPS && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const chat of frontier) {
        const turn = db
          .select({ todoId: todoTurns.todoId, agentId: todoTurns.agentId })
          .from(todoTurns)
          .where(and(eq(todoTurns.sessionId, chat), eq(todoTurns.status, 'started')))
          .get();
        const row = turn ? readTodo(turn.todoId) : undefined;
        if (turn && row) turns.set(chat, { row, agentId: turn.agentId });
        const spawner = db
          .select({ from: sessionStartedBy.startedBySessionId })
          .from(sessionStartedBy)
          .where(eq(sessionStartedBy.sessionId, chat))
          .get();
        const senders = db
          .select({ from: chatMessages.fromSessionId, agentId: chatMessages.fromAgentId })
          .from(chatMessages)
          .where(eq(chatMessages.toSessionId, chat))
          .all();
        const edges = [
          ...(spawner?.from ? [{ from: spawner.from, agentId: null }] : []),
          ...senders.flatMap((sender) =>
            sender.from ? [{ from: sender.from, agentId: sender.agentId ?? null }] : []
          ),
        ];
        parents.set(chat, edges);
        for (const edge of edges) {
          if (seen.has(edge.from) || seen.size >= TODO_CHAIN_CHATS) continue;
          seen.add(edge.from);
          next.push(edge.from);
        }
      }
      frontier = next;
    }
    return { turns, parents };
  }

  /** How many turns a charge started today. */
  private startedToday(chargedTo: string): number {
    return this.deps.db
      .select({ id: todoTurns.id })
      .from(todoTurns)
      .where(
        and(
          eq(todoTurns.chargedTo, chargedTo),
          eq(todoTurns.day, utcDay(this.now())),
          eq(todoTurns.status, 'started')
        )
      )
      .all().length;
  }

  /** Launch the turn at the to-do's stored power, counted against its charge. */
  private async start(
    row: CommitmentRow,
    agentId: string,
    chargedTo: string | null
  ): Promise<TodoTurnOutcome> {
    const power = todoTurnPower(row);
    const source = row.sourceRoomEntryId
      ? this.deps.readSource(row.sourceRoomEntryId, agentId)
      : undefined;
    // Counted before launch, so two to-dos in one tick cannot both spend the last turn.
    const turn = this.record(row, agentId, chargedTo, 'started', null);
    try {
      const { sessionId } = await this.deps.launch({
        todoId: row.id,
        agentId,
        content: buildTodoTurnPrompt(row, source),
        permissionCeiling: power.ceiling,
        carriedMarks: power.carriedMarks,
      });
      this.deps.db
        .update(todoTurns)
        .set({ sessionId, startedAt: this.now().toISOString() })
        .where(eq(todoTurns.id, turn.id))
        .run();
      return { status: 'started', sessionId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Not started, so not counted: it waits to be tried again on the next check.
      this.deps.db
        .update(todoTurns)
        .set({ status: 'retry', reason: `launch failed: ${message}`.slice(0, 300) })
        .where(eq(todoTurns.id, turn.id))
        .run();
      logger.warn('[todos] a to-do turn did not start', { todoId: row.id, error: message });
      return { status: 'retry', reason: 'launch failed' };
    }
  }

  /** Write one ledger row. */
  private record(
    row: CommitmentRow,
    agentId: string,
    chargedTo: string | null,
    status: TodoTurnRow['status'],
    reason: string | null
  ): TodoTurnRow {
    const at = this.now();
    const turn: TodoTurnRow = {
      id: ulid(),
      todoId: row.id,
      agentId,
      chargedTo,
      status,
      reason,
      day: utcDay(at),
      sessionId: null,
      createdAt: at.toISOString(),
      startedAt: null,
    };
    this.deps.db.insert(todoTurns).values(turn).run();
    return turn;
  }
}
