/**
 * The heavy shell commands a Codex agent is running count in the machine's line (DOR-4743), in
 * the same line as every other agent's heavy job (`core/load-gate/`).
 *
 * **Why counting, not holding.** DorkOS can hold a Codex command only at the ask Codex sends before
 * running it (`load-gate-hold.ts`). On Full access Codex asks about nothing, and on the other levels
 * it runs whatever its sandbox allows without asking, so DorkOS first hears of such a command once
 * it is running (`item/started`). The approval policy is deliberately left as it is. What DorkOS
 * does instead:
 *
 * - **A running command takes a slot.** A heavy command's `item/started` takes a slot at once,
 *   never waiting, past the load limit (`LoadGate.occupy`), shared by the chat's running commands
 *   (`codexRunningKey`), and gives it back at its `item/completed`, at the turn's end, or when
 *   the process goes away (both end the turn). Every other agent's heavy job, on any runtime, then
 *   waits behind it. A light command, such as `ls`, takes nothing.
 * - **A new Codex reply waits to start** while the computer is busy and Codex commands already hold
 *   slots ({@link CodexRunningCommands.startWhenCalm}): it could start more of them, unheld. It shows
 *   the same `waiting_for_load` status a waiting job does, and a Stop ends it before Codex is told
 *   anything. It is a person's reply, not a heavy job, so it starts anyway at `maxWaitMinutes`,
 *   never waiting as long as the hard cap.
 *
 * **An asked command counts once.** Codex sends `item/started` for a command it is about to ask
 * about, then the ask (verified on 0.154), so the command's slot goes back while its ask waits in
 * line and its card is up ({@link CodexRunningCommands.suspend}): it is not running yet. Once the
 * ask is answered the command takes a slot again until it completes
 * ({@link CodexRunningCommands.resume}). An ask that arrives before its `item/started` is handled
 * the same way, and so is a second ask about a command already running (its network access): no
 * card ever holds a slot, because a person may take hours to answer it.
 *
 * **What is left.** A Codex command still starts on a busy computer when its reply began while the
 * computer was calm: it never waits, it is only counted, and everything else waits behind it. A
 * command Codex keeps running after its reply ends (a background terminal) gives its slot back at
 * the reply's end. A chat's running commands share one slot, as every thread's heavy jobs do. A
 * Codex helper's own commands are not counted at all: the transport listens to the main thread
 * only, so a helper on Full access runs heavy jobs unseen. A reply that was stopped but that Codex
 * keeps running for a while (a lingering turn) gives its slots back when DorkOS closes the turn,
 * not when Codex finally ends it.
 *
 * Nothing here logs or shows command text: the program's name and counts only.
 *
 * @module services/runtimes/codex/app-server/running-commands
 */
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../../../lib/logger.js';
import {
  DEFAULT_POLL_MS,
  errorName,
  isAbortError,
  type HeldSlot,
} from '../../../core/load-gate/load-gate.js';
import { machineLoadGate } from '../../../core/load-gate/machine-load-gate.js';
import { loadStartWaitEvent, type RuntimeWaitDeps } from '../../../core/load-gate/runtime-wait.js';
import type { TurnSink } from './thread-channel.js';
import type { ServerNotification } from './protocol/methods.js';

/**
 * The share key a Codex chat's running commands count under: one slot for all of them, as a
 * thread's heavy jobs share one everywhere (`chat-turns.ts`). Deliberately not the key its asks
 * wait under (`codexShareKey`, `load-gate-hold.ts`): Codex reports a command it is about to ask
 * about as started, so a slot shared with the asks would let a sibling ask straight past the line.
 * An ask can therefore wait behind a command its own chat is running; nothing it waits on waits on
 * it, so it never deadlocks.
 *
 * @param sessionId - The DorkOS session.
 */
const codexRunningKey = (sessionId: string): string => `codex:${sessionId}:running`;

/** What the registry counts with: the gate, the log, and the clock its heartbeats are timed on. */
export type RunningCommandsDeps = RuntimeWaitDeps & {
  /** The wall clock; the gate's own in tests, so a heartbeat's timing is the test's. */
  now?: () => number;
};

/**
 * How often a talking command refreshes its slot at most: the gate's own poll, well inside the
 * lease, so a command that prints thousands of lines costs a file touch every few seconds, not one
 * per line.
 */
const BEAT_EVERY_MS = DEFAULT_POLL_MS;

/** What the registry reads of an open turn. */
export interface RunningCommandsTurn {
  /** The DorkOS session. */
  readonly sessionId: string;
  /** Settles when the turn ends, however it ends: completed, crashed, or closed. */
  readonly completed: Promise<string>;
}

/** A command the turn started, and the slot it holds while it runs. */
interface RunningItem {
  readonly command: string;
  slot: HeldSlot | null;
  /** When the slot was last refreshed: taken counts as refreshed. */
  lastBeat: number;
}

/** One open turn's commands. */
interface TurnCommands {
  readonly items: Map<string, RunningItem>;
  /** Commands whose ask is waiting in line or on a person: not running yet. */
  readonly asking: Set<string>;
}

/** The parts of a command notification read here. */
interface CommandParams {
  item?: { type?: unknown; id?: unknown; command?: unknown };
  itemId?: unknown;
}

/** Counts the heavy commands Codex runs in DorkOS's open turns. */
export class CodexRunningCommands {
  private readonly turns = new Map<RunningCommandsTurn, TurnCommands>();
  private readonly ended = new WeakSet<RunningCommandsTurn>();
  private readonly now: () => number;
  /** Whether a failure to count has been logged; once is enough. */
  private failureLogged = false;

  /**
   * Construct the registry.
   *
   * @param deps - The gate, the log and the clock; the server's own by default.
   */
  constructor(private readonly deps: RunningCommandsDeps = {}) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Watch a turn's notifications for its commands, then hand each on to the sink unchanged. Every
   * slot the turn's commands hold goes back when the turn ends.
   *
   * @param sink - The turn's sink; its `notify` is wrapped in place, so the channel's view of it,
   *   its turn id included, is unchanged.
   * @param turn - The open turn.
   * @returns The same sink.
   */
  watch(sink: TurnSink, turn: RunningCommandsTurn): TurnSink {
    const notify = sink.notify;
    sink.notify = (notification) => {
      try {
        this.observe(turn, notification);
      } catch (error) {
        // Counting must never cost the turn a notification.
        if (!this.failureLogged) {
          this.failureLogged = true;
          (this.deps.log ?? logger).warn('[LoadGate] a Codex command could not be counted', {
            error: errorName(error),
          });
        }
      }
      notify.call(sink, notification);
    };
    void turn.completed.then(() => this.endTurn(turn));
    return sink;
  }

  /**
   * A command's ask arrived: it is not running yet, so its slot goes back while the ask waits.
   *
   * @param turn - The open turn.
   * @param itemId - The command's item, when the ask names one.
   */
  suspend(turn: RunningCommandsTurn, itemId: string | undefined): void {
    const commands = this.commandsOf(turn);
    if (commands === undefined || itemId === undefined) return;
    commands.asking.add(itemId);
    const item = commands.items.get(itemId);
    item?.slot?.release();
    if (item) item.slot = null;
  }

  /**
   * A command's ask was answered: if it runs now, it takes a slot until it completes.
   *
   * @param turn - The open turn.
   * @param itemId - The command's item, when the ask names one.
   */
  resume(turn: RunningCommandsTurn, itemId: string | undefined): void {
    const commands = this.commandsOf(turn);
    if (commands === undefined || itemId === undefined) return;
    commands.asking.delete(itemId);
    const item = commands.items.get(itemId);
    if (item && item.slot === null) {
      item.slot = this.occupy(turn, item.command);
      item.lastBeat = this.now();
    }
  }

  /** How many Codex commands hold a slot now. */
  holding(): number {
    let count = 0;
    for (const commands of this.turns.values()) {
      for (const item of commands.items.values()) if (item.slot !== null) count += 1;
    }
    return count;
  }

  /**
   * Before a reply starts: wait while the computer is busy and Codex commands already hold slots,
   * saying so in the chat. Never throws: a gate that breaks lets the reply start.
   *
   * @param request - The session, and the signal a Stop fires.
   * @returns `true` to start the reply; `false` when it was stopped, after its one `done`.
   */
  async *startWhenCalm(request: {
    readonly sessionId: string;
    readonly signal: AbortSignal;
  }): AsyncGenerator<StreamEvent, boolean> {
    // Nothing of Codex's is running: a new reply adds nothing unseen to a busy computer.
    if (this.holding() === 0) return true;
    const log = this.deps.log ?? logger;
    const said: StreamEvent[] = [];
    const state: { ended?: 'start' | 'stopped' } = {};
    let wake = (): void => {};
    const waited = (async () => {
      await (this.deps.gate ?? machineLoadGate)().waitWhileBusy(() => this.holding() > 0, {
        signal: request.signal,
        onWait: () => {
          said.push(loadStartWaitEvent());
          wake();
        },
      });
    })();
    waited
      .then(
        () => 'start' as const,
        (error: unknown) => {
          if (isAbortError(error)) return 'stopped' as const;
          log.warn('[LoadGate] the wait to start broke; the reply starts', {
            error: errorName(error),
          });
          return 'start' as const;
        }
      )
      .then((ended) => {
        state.ended = ended;
        wake();
      });
    for (;;) {
      while (said.length > 0) yield said.shift()!;
      if (state.ended !== undefined) break;
      await new Promise<void>((resolve) => (wake = resolve));
    }
    if (state.ended === 'start') return true;
    yield { type: 'done', data: { sessionId: request.sessionId } };
    return false;
  }

  private observe(turn: RunningCommandsTurn, notification: ServerNotification): void {
    if (this.ended.has(turn)) return;
    const params = notification.params as CommandParams | undefined;
    if (notification.method === 'item/started') this.started(turn, params?.item);
    else if (notification.method === 'item/completed') this.finished(turn, params?.item?.id);
    else if (notification.method === 'item/commandExecution/outputDelta') {
      if (typeof params?.itemId === 'string') this.talking(turn, params.itemId);
    }
  }

  private started(turn: RunningCommandsTurn, item: CommandParams['item']): void {
    if (item?.type !== 'commandExecution') return;
    if (typeof item.id !== 'string' || typeof item.command !== 'string') return;
    const commands = this.commandsOf(turn);
    if (commands === undefined || commands.items.has(item.id)) return;
    // Its ask is waiting: it is not running yet, and takes a slot once the ask is answered.
    const slot = commands.asking.has(item.id) ? null : this.occupy(turn, item.command);
    commands.items.set(item.id, { command: item.command, slot, lastBeat: this.now() });
  }

  /**
   * A command still talking is still running: its slot stays fresh past the hard cap, at most once
   * a poll, since each refresh touches a file.
   */
  private talking(turn: RunningCommandsTurn, itemId: string): void {
    const item = this.turns.get(turn)?.items.get(itemId);
    if (!item?.slot) return;
    const at = this.now();
    if (at - item.lastBeat < BEAT_EVERY_MS) return;
    item.lastBeat = at;
    item.slot.heartbeat();
  }

  private finished(turn: RunningCommandsTurn, itemId: unknown): void {
    if (typeof itemId !== 'string') return;
    const commands = this.turns.get(turn);
    commands?.items.get(itemId)?.slot?.release();
    commands?.items.delete(itemId);
    commands?.asking.delete(itemId);
  }

  private endTurn(turn: RunningCommandsTurn): void {
    this.ended.add(turn);
    const commands = this.turns.get(turn);
    this.turns.delete(turn);
    for (const item of commands?.items.values() ?? []) item.slot?.release();
  }

  /** The turn's commands, or `undefined` once it ended. */
  private commandsOf(turn: RunningCommandsTurn): TurnCommands | undefined {
    if (this.ended.has(turn)) return undefined;
    let commands = this.turns.get(turn);
    if (!commands) {
      commands = { items: new Map(), asking: new Set() };
      this.turns.set(turn, commands);
    }
    return commands;
  }

  /** Take a slot for a running command, or `null` when it is light, the gate is off or broke. */
  private occupy(turn: RunningCommandsTurn, command: string): HeldSlot | null {
    try {
      return (this.deps.gate ?? machineLoadGate)().occupy(command, {
        shareKey: codexRunningKey(turn.sessionId),
      });
    } catch (error) {
      (this.deps.log ?? logger).warn('[LoadGate] a running command could not be counted', {
        error: errorName(error),
      });
      return null;
    }
  }
}
