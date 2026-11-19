/**
 * A Codex agent's heavy shell job waits its turn while the computer is busy (DOR-4209), in the
 * same machine-wide line as every other agent's (`core/load-gate/`).
 *
 * **Where it holds.** Codex runs a command without a word to DorkOS unless it stops to ask about
 * it (`item/commandExecution/requestApproval`, which blocks the command until it is answered). That
 * ask is the only place DorkOS can hold a Codex command, so a heavy command's ask waits here before
 * the transport's own handling of it runs at all. Once the wait ends, however it ends (its turn, a
 * let-through, the hard cap, a gate failure, the turn ending, the process going away), the
 * transport's handling runs exactly as it would have without this: the same open-turn check, the
 * same mapping, the same card. A light command's ask goes straight to it, as before.
 *
 * **It holds, it never decides.** Nothing here writes an answer of its own but in two cases, both
 * with nobody left to ask: an ask Codex withdrew while it waited (`serverRequest/resolved`), and an
 * ask whose turn ended while it waited (a Stop, the turn completing, the process going away). Each
 * gets the method's own "no" (`undefined`), which is what the transport sends any ask it has no
 * turn for; running the normal handling instead would raise a card into a turn that is over. Never
 * a yes.
 *
 * **One place in line per chat.** Every ask of one chat waits under one share key
 * (`codex:<chat>:main`, `core/load-gate/chat-turns.ts`): a second heavy ask that arrives while the
 * first still waits takes the same place, not a ticket of its own, and goes on with it. Codex
 * withdrawing one of them leaves the place standing for the others. The key is not what keeps a
 * Codex ask from waiting on itself: its slot goes back before any card goes up. It only keeps a
 * turn's asks together. The chat's running commands count under a key of their own
 * (`running-commands.ts`), because Codex reports a command it is about to ask about as started: so
 * an ask can wait behind a command its own chat is running, which never waits on the ask. Only the
 * main thread's asks are ever held: an ask from a Codex helper's own thread names no DorkOS turn
 * and goes to the normal handling, which refuses it.
 *
 * **The slot is given back as the normal handling starts.** That handling ends in a person's card
 * or a refusal, every time: DorkOS never approves a Codex command on its own. A card gives its slot
 * back, the rule Claude Code's hook follows, because a person approving is already a gate and a card
 * can wait for hours. A refusal runs nothing. So a Codex job waits for its turn to be asked about,
 * and once a person approves, it runs straight away, without waiting again. While it runs it is
 * counted, as every Codex command is (below).
 *
 * **Counted, not held: what Codex runs without asking (DOR-4743).** On Full access
 * (`approvalPolicy: 'never'`, `turn-parts.ts`) Codex asks about nothing, and on the other levels
 * it asks only about a command that needs more than its sandbox allows, or one a person has not
 * already approved for the session. DorkOS sees such a command only once it is running, so it
 * cannot wait; it takes a slot while it runs instead, and a new Codex reply waits to start on a
 * busy computer while Codex commands hold slots (`running-commands.ts`, which this holder owns, so
 * an asked command's slot goes back while its ask waits and comes back once it is answered). The
 * approval policy is deliberately left as it is.
 *
 * Nothing here logs or shows command text: the program's name and counts only.
 *
 * @module services/runtimes/codex/app-server/load-gate-hold
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { waitForHeavyTurn, wouldHold } from '../../../core/load-gate/runtime-wait.js';
import type { ServerRequest } from './protocol/methods.js';
import { CodexRunningCommands, type RunningCommandsDeps } from './running-commands.js';

/**
 * What the holder waits and counts with: the gate, the settings, the log and the clock, the
 * server's own by default.
 */
export type HeavyAskDeps = RunningCommandsDeps;

/** The one ask a heavy command can be held at. */
const COMMAND_APPROVAL_METHOD = 'item/commandExecution/requestApproval';

/** What a held ask needs of the open turn it belongs to. */
export interface HeldAskTurn {
  /** The DorkOS session, for the person's own list of waiting jobs. */
  readonly sessionId: string;
  /** Settles when the turn ends, however it ends: completed, crashed, or closed. */
  readonly completed: Promise<string>;
  /** Push events into the turn: the wait's status line. */
  deliver(events: StreamEvent[]): void;
}

/** What {@link requestTurn} reads of an open turn. */
interface RoutableTurn {
  readonly process: unknown;
  turnId: string | undefined;
}

/**
 * The open turn a server request belongs to: the one on its thread, in the process that sent it,
 * and the same turn when the request names one. `undefined` when it names none of DorkOS's.
 *
 * @param byThread - The open turns, by thread id.
 * @param process - The process the request came from.
 * @param request - The request as it arrived.
 */
export function requestTurn<T extends RoutableTurn>(
  byThread: ReadonlyMap<string, T>,
  process: T['process'],
  request: ServerRequest
): T | undefined {
  const params = (request.params ?? {}) as { threadId?: unknown; turnId?: unknown };
  const turn = typeof params.threadId === 'string' ? byThread.get(params.threadId) : undefined;
  if (!turn || turn.process !== process) return undefined;
  const wrongTurn =
    typeof params.turnId === 'string' && turn.turnId !== undefined && params.turnId !== turn.turnId;
  return wrongTurn ? undefined : turn;
}

/** The command an ask is about, when it is a plain command ask: never typing into a running one. */
function askedCommand(request: ServerRequest): { command: string; itemId?: string } | undefined {
  if (request.method !== COMMAND_APPROVAL_METHOD) return undefined;
  const params = (request.params ?? {}) as { command?: unknown; kind?: unknown; itemId?: unknown };
  if (typeof params.command !== 'string' || params.command === '') return undefined;
  if (params.kind !== undefined && params.kind !== null && params.kind !== 'command') {
    return undefined;
  }
  return {
    command: params.command,
    ...(typeof params.itemId === 'string' ? { itemId: params.itemId } : {}),
  };
}

/** Where a waiting ask is filed: its process and its JSON-RPC id. */
const waitKey = (processKey: string, jsonRpcId: unknown): string =>
  `${processKey}:${String(jsonRpcId)}`;

/**
 * The share key every held ask of one chat waits under: its place in line and its slot are the
 * chat's, so its second ask never waits behind its first.
 *
 * @param sessionId - The DorkOS session.
 */
export const codexShareKey = (sessionId: string): string => `codex:${sessionId}:main`;

/** One ask waiting in line, and why its wait may have stopped. */
interface WaitingAsk {
  readonly stop: AbortController;
  /** Codex withdrew it. */
  withdrawn: boolean;
  /** Its turn ended. */
  turnEnded: boolean;
}

/** Holds Codex's heavy command asks until the machine's line lets them through. */
export class CodexHeavyAsks {
  /** Each ask still waiting, by process and JSON-RPC id. */
  private readonly waiting = new Map<string, WaitingAsk>();
  /** The items each turn already held once: a second ask about one (its network) never waits. */
  private readonly held = new WeakMap<HeldAskTurn, Set<string>>();
  /** The heavy commands Codex is running, counted in the same line (DOR-4743). */
  readonly running: CodexRunningCommands;

  /**
   * Construct the holder.
   *
   * @param deps - The gate, the settings and the log; the server's own by default.
   */
  constructor(private readonly deps: HeavyAskDeps = {}) {
    this.running = new CodexRunningCommands(deps);
  }

  /**
   * Hold one server request if it is a heavy command's ask in one of DorkOS's open turns, then
   * answer it with `answer`, the transport's normal handling. Anything else is answered at once,
   * exactly as before.
   *
   * @param process - The process the request came from.
   * @param request - The request as it arrived.
   * @param byThread - The open turns, by thread id: where the ask's turn is found.
   * @param answer - The transport's normal handling of the request.
   */
  hold<T extends RoutableTurn & HeldAskTurn>(
    process: T['process'] & { readonly key: string },
    request: ServerRequest,
    byThread: ReadonlyMap<string, T>,
    answer: () => unknown
  ): unknown {
    const turn = requestTurn(byThread, process, request);
    const ask = turn === undefined ? undefined : askedCommand(request);
    if (turn === undefined || ask === undefined) return answer();
    // A light command, the gate off, or a second ask about one command (its network access): no
    // wait, but its card still holds no slot.
    if (!wouldHold(ask.command, this.deps) || this.heldBefore(turn, ask.itemId)) {
      return this.cardHoldsNoSlot(turn, ask.itemId, answer);
    }
    const key = waitKey(process.key, request.id);
    const entry: WaitingAsk = { stop: new AbortController(), withdrawn: false, turnEnded: false };
    this.waiting.set(key, entry);
    // The turn ending, however it ends, stops the wait, and the chat's place leaves the line with
    // its last ask.
    void turn.completed.then(() => {
      entry.turnEnded = true;
      entry.stop.abort();
    });
    // Asked about, the command is not running: the slot its `item/started` took goes back while
    // the ask waits and its card is up, so it is never counted twice.
    this.running.suspend(turn, ask.itemId);
    const waited = waitForHeavyTurn(
      {
        command: ask.command,
        owner: { chatId: turn.sessionId },
        shareKey: codexShareKey(turn.sessionId),
        signal: entry.stop.signal,
        notify: (event) => turn.deliver([event]),
      },
      this.deps
    );
    return waited.then((slot) => {
      if (this.waiting.get(key) === entry) this.waiting.delete(key);
      // Before the card goes up, never after: see the module's TSDoc.
      slot?.release();
      // Codex withdrew it, or its turn is over: nobody is left to ask (see the module's TSDoc).
      if (entry.withdrawn || entry.turnEnded) return undefined;
      return this.cardHoldsNoSlot(turn, ask.itemId, answer);
    });
  }

  /**
   * Run the normal handling (a person's card, or a refusal) with the command's slot given back, and
   * take it again once the ask is answered: it runs then, or Codex reports it declined at once and
   * its `item/completed` gives the slot back. A card can wait for hours; it never holds a slot.
   */
  private cardHoldsNoSlot(
    turn: HeldAskTurn,
    itemId: string | undefined,
    answer: () => unknown
  ): Promise<unknown> {
    this.running.suspend(turn, itemId);
    return Promise.resolve(answer()).finally(() => this.running.resume(turn, itemId));
  }

  /**
   * Codex cleared a request (`serverRequest/resolved`): if it is still waiting in line, it stops,
   * and nobody is asked about it.
   *
   * @param processKey - The process the notification came from.
   * @param jsonRpcId - The cleared request's id.
   */
  resolvedByServer(processKey: string, jsonRpcId: unknown): void {
    const key = waitKey(processKey, jsonRpcId);
    const entry = this.waiting.get(key);
    if (!entry) return;
    this.waiting.delete(key);
    entry.withdrawn = true;
    // Only this ask leaves; the chat's other asks keep its place in line (`chat-turns.ts`).
    entry.stop.abort();
  }

  /** Whether this turn already held the item once; records it if not. */
  private heldBefore(turn: HeldAskTurn, itemId: string | undefined): boolean {
    if (itemId === undefined) return false;
    let items = this.held.get(turn);
    if (!items) {
      items = new Set();
      this.held.set(turn, items);
    }
    if (items.has(itemId)) return true;
    items.add(itemId);
    return false;
  }
}
