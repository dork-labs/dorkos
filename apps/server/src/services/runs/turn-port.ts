/**
 * The space face of the turn port (spec `turns-survive-restarts` §3.1,
 * DOR-5157): the one door a space-side caller starts and watches a turn
 * through.
 *
 * `start()` answers at acceptance, never at turn start: it saves the run
 * (`queued`, transition 1, with the reason it waits when admission would hold
 * it now) and its `start_turn` effect in one transaction and returns. The outbox's worker then hands the run over: the `start_turn`
 * handler asks admission (`admission.ts`), and only then the computer face
 * (`services/session/turn-port`), which is the only turn code this domain
 * imports (§3.4). Waiting is decided here, on the space side; the computer
 * face only accepts or refuses.
 *
 * **Where the words are.** The run record holds no words (§4.1). Until the
 * turn starts they are where the caller keeps them: in its own store, named
 * by `sourceRef` and read back through the {@link WordSource} its kind's owner
 * registered, so a restart in between loses nothing; or, for a caller with no
 * store, in this process only, so a restart in between cancels the run as
 * `start_lost` (§4.7) and its asker hears it. Either way the words are
 * forgotten here the moment the run starts or ends without starting.
 *
 * **Refusals at the door.** A start the space face can judge itself is
 * refused before anything is saved, with the plain sentence the caller shows:
 * words past the cap, a malformed request, an agent no registered agent
 * answers to (§3.1).
 *
 * **Watching.** {@link SpaceTurnPort.watch} hears every committed status
 * change of a run, as the run now reads, after the transaction that made it
 * (§3.1 `watch`). Every device reads the durable half, `run_update` on the
 * chat's stream (`run-view.ts`); this is the in-process half a space-side
 * caller needs today.
 *
 * {@link SpaceTurnPort.watchEvents} hears what the run's turn says, event by
 * event, for a caller that reads it (a scheduled task's summary, T12).
 *
 * `stop` came with its first caller, the scheduler (T12); `answer` arrives
 * with its own.
 *
 * @module services/runs/turn-port
 */
import {
  RunIdSchema,
  StartTurnInputSchema,
  wordsWaitInComposer,
  type StartTurnInput,
  type StartTurnResult,
  type WaitReason,
} from '@dorkos/shared/turn-port';
import { SESSION_RELAY_MAX_MESSAGE_LENGTH } from '@dorkos/shared/session-relay';
import type { InterruptReceipt, StreamEvent } from '@dorkos/shared/schemas';
import { logger } from '../../lib/logger.js';
import { chatKeyOf, type ComputerTurnPort } from '../session/turn-port/index.js';
import type { StartTurns } from './effects/start-turns.js';
import type { EffectStore } from './effects/effect-store.js';
import { letGoOfWakeWords, WAKE_SOURCE } from './effects/wakes.js';
import { StartPayloadSchema, startPayloadOf, type StartPayload } from './effects/start-payload.js';
import type { RunStore, TurnRun } from './run-store.js';
import { writeStopReceipt, writeStopRequest } from './run-stops.js';

/** The statuses after which a run never goes back in line, so its words are no longer needed. */
export const RUN_ENDS: ReadonlySet<TurnRun['status']> = new Set([
  'ended',
  'settled',
  'cancelled',
  'superseded',
]);

/** Why the space face refused a start before saving anything. */
export type SpaceRefusalReason =
  'content_too_long' | 'invalid_input' | 'invalid_agent_path' | 'agent_paused';

/** A start refused at `start()`: nothing was saved. */
export class TurnStartRefusedError extends Error {
  /**
   * Refuse a start.
   *
   * @param reason - Which check refused it.
   * @param message - The plain sentence a caller shows.
   */
  constructor(
    readonly reason: SpaceRefusalReason,
    message: string
  ) {
    super(message);
    this.name = 'TurnStartRefusedError';
  }
}

/** Reads a run's words back from the store its caller keeps them in. */
export interface WordSource {
  /**
   * The words, or `undefined` when the source no longer holds them.
   *
   * @param id - The source's own id: what follows `<kind>:` in the run's `sourceRef`.
   * @param run - The run, by the chat it is kept under now (a rebind moves a
   *   chat's rows to the id the runtime settled on, and its runs with them).
   */
  read(id: string, run: Pick<TurnRun, 'sessionId'>): string | undefined;
  /**
   * The app that asked, when the source is a mini app's: named in the owner's
   * notice when a start it was answered never runs (§3.1).
   *
   * @param id - The source's own id.
   * @param run - The run, by the chat it is kept under now.
   */
  app?(
    id: string,
    run: Pick<TurnRun, 'sessionId'>
  ): { extensionId: string; name: string } | undefined;
  /**
   * Let the words go for good: the run will never read them, though no move
   * of its says so (recovery decided a turn a restart ended, §7.3, step 4).
   *
   * @param id - The source's own id.
   * @param run - The run, by the chat it is kept under now.
   */
  forget?(id: string, run: Pick<TurnRun, 'sessionId'>): void;
}

/** Which runs a watcher hears. */
export type RunWatchFilter = { runId: string } | { sessionId: string } | undefined;

/** What {@link SpaceTurnPort} needs. */
export interface SpaceTurnPortDeps {
  runs: RunStore;
  effects: EffectStore;
  /**
   * The folder a registered agent lives in, by Mesh id, or `undefined` when
   * no agent answers to it. Absent (no Mesh yet), the computer face judges.
   */
  agentHome?: () => ((agentId: string) => string | undefined) | undefined;
  /**
   * Admission's answer for a run just saved, so it shows why it waits from
   * its first moment (§4.6) and its caller can say so. The `start_turn`
   * handler asks again before every hand-over; this decides nothing.
   */
  preview?: (run: TurnRun, start: StartPayload) => WaitReason | undefined;
  /**
   * The paused agent a start is for, when it is paused (admission's own
   * source): a mini app's send or start is refused then, as it always has
   * been, because nobody can yet see a waiting run to take it back (§3.5).
   */
  pausedAgent?: (
    agentId: string | null,
    cwd: string | undefined,
    sessionId: string
  ) => { name: string } | undefined;
  /** Whether a queue row still holds a run's words (this computer's queue). */
  queueRowExists?: (queueMessageId: string) => boolean;
  /** The computer face, for taking back a run its caller no longer wants. */
  computer?: () => ComputerTurnPort | undefined;
  /** The record side of the hand-overs, for cancelling a run that never left here. */
  starts?: () => StartTurns | undefined;
  /** Every event of a run's turn from now on (`watchRunEvents` on this computer). */
  events?: (runId: string, hear: (event: StreamEvent) => void) => () => void;
}

/** The space face. See the module documentation. */
export class SpaceTurnPort {
  /** Words held for runs with no source, by run id, until they start or end. */
  private readonly words = new Map<string, string>();
  private readonly sources = new Map<string, WordSource>();
  private readonly watchers = new Set<{ filter: RunWatchFilter; hear: (run: TurnRun) => void }>();

  /**
   * Build the space face over the run record and its outbox.
   *
   * @param deps - The stores, and Mesh's answer for an agent.
   */
  constructor(private readonly deps: SpaceTurnPortDeps) {}

  /**
   * Start a turn: save the run and its `start_turn` and answer at once.
   *
   * @param input - A {@link StartTurnInput}; parsed here, so a caller cannot pass more.
   * @param opts.runId - The run's id, when the caller minted it (a ULID): a caller
   *   that keeps the words in its own row names the run by that row's id, so the
   *   row, the run, the queue row its words become and the caller's receipt share
   *   one id. Not part of the port's payload; the space side mints every run id.
   * @returns The run's id, its status (`queued`) and its place among the chat's waiting runs.
   *   A start under a `startKey` that already made a run saves nothing and answers that run.
   * @throws {TurnStartRefusedError} When the start is refused before anything is saved.
   */
  start(input: StartTurnInput, opts: { runId?: string } = {}): StartTurnResult {
    const parsed = StartTurnInputSchema.safeParse(input);
    if (!parsed.success) {
      const tooLong =
        typeof input?.content === 'string' &&
        input.content.length > SESSION_RELAY_MAX_MESSAGE_LENGTH;
      throw tooLong
        ? new TurnStartRefusedError(
            'content_too_long',
            `Keep the message under ${SESSION_RELAY_MAX_MESSAGE_LENGTH.toLocaleString('en-US')} characters.`
          )
        : new TurnStartRefusedError(
            'invalid_input',
            `The turn could not be started: ${parsed.error.issues[0]?.message ?? 'bad input'}.`
          );
    }
    const start = parsed.data;
    if (opts.runId !== undefined && !RunIdSchema.safeParse(opts.runId).success) {
      throw new TurnStartRefusedError(
        'invalid_input',
        'The turn could not be started: bad run id.'
      );
    }
    const home = this.deps.agentHome?.();
    if (start.agentId !== undefined && home && home(start.agentId) === undefined) {
      throw new TurnStartRefusedError(
        'invalid_agent_path',
        'Choose a registered agent before starting this chat'
      );
    }
    const app =
      start.origin.kind === 'extension-message' || start.origin.kind === 'extension-start';
    // A send to a chat by id names no agent or folder: its chat's agent answers.
    const paused = app
      ? this.deps.pausedAgent?.(start.agentId ?? null, start.cwd, start.sessionId)
      : undefined;
    if (paused) {
      // Today's words and today's rule: nothing is queued, nothing kept for later.
      throw new TurnStartRefusedError('agent_paused', `${paused.name} is paused.`);
    }
    const { runs, effects } = this.deps;
    const [run, again] = runs.transaction((): [TurnRun, boolean] => {
      // One key, one run (§6.4): a source asking again is answered, never doubled.
      const made = start.startKey !== undefined ? runs.findByStartKey(start.startKey) : undefined;
      if (made) return [made, true];
      let created = runs.create({
        ...(opts.runId !== undefined ? { id: opts.runId } : {}),
        chatKey: start.sessionId,
        status: 'queued',
        openedBy: 'caller',
        origin: start.origin,
        ...(start.agentId !== undefined ? { agentId: start.agentId } : {}),
        ...(start.sourceRef !== undefined ? { sourceRef: start.sourceRef } : {}),
        ...(start.notAfter !== undefined ? { notAfter: start.notAfter } : {}),
        ...(start.startKey !== undefined ? { startKey: start.startKey } : {}),
      });
      const waits = this.deps.preview?.(created, startPayloadOf(start));
      if (waits !== undefined) created = runs.move(created, 'queued', { waitReason: waits });
      effects.insert({
        kind: 'start_turn',
        key: `start:${created.id}:${created.attempt}`,
        runId: created.id,
        // The chat it orders behind: only a run whose words stay at their
        // source waits in line here; a composer's words wait as a queue row.
        ...(wordsWaitInComposer(start.origin, start.notAfter)
          ? {}
          : { sessionId: created.sessionId }),
        payload: startPayloadOf(start),
        delivery: 'repeatable',
        notAfter: start.notAfter ?? null,
      });
      return [created, false];
    });
    if (!again) this.words.set(run.id, start.content);
    return { runId: run.id, status: run.status, queuePosition: this.queuePositionOf(run) };
  }

  /**
   * One run by id (§3.1 `get`).
   *
   * @param runId - The run.
   */
  get(runId: string): TurnRun | undefined {
    return this.deps.runs.get(runId);
  }

  /**
   * A chat's runs, oldest first (§3.1 `list`).
   *
   * @param sessionId - The chat, by any id it answers to.
   */
  list(sessionId: string): TurnRun[] {
    return this.deps.runs.listForChat(sessionId);
  }

  /**
   * Take back a run that has not started, because its caller is gone (a mini
   * app stopped or was removed): its queue row leaves the chat's queue, or a
   * run with no row is cancelled, even while its hand-over is under way (the
   * row that hand-over writes is not kept, and its launch finds the run gone).
   * A run whose launch has begun is left to end as it ends.
   *
   * @param runId - The run.
   * @param why - Kept on the run when it is cancelled here.
   * @returns Whether it was taken back: false when it had already begun, or ended.
   */
  withdraw(runId: string, why: string): boolean {
    const run = this.deps.runs.get(runId);
    if (run?.status !== 'queued') return false;
    const computer = this.deps.computer?.();
    if (run.queueMessageId !== null) {
      // The computer face is always wired at boot; without it nothing removes the row.
      computer?.removeQueued(run.sessionId, run.queueMessageId);
      return this.deps.runs.get(runId)?.status === 'cancelled';
    }
    // A plan waiting in the dispatcher is dropped; one still being handed
    // over meets the cancelled run.
    computer?.withdraw(run.id);
    this.deps.starts?.()?.cancel(run.id, why);
    return this.deps.runs.get(runId)?.status === 'cancelled';
  }

  /**
   * Stop one run (§3.1 `stop`), leaving its chat's queue and other runs alone.
   * A run that has not begun is taken back and cancelled (`stopped`). A run
   * whose turn is running has the request written on it before its computer
   * is asked, and the receipt after, so a crash in between still shows it was
   * asked (§4.4). A launch under way has no turn to stop yet: nothing is
   * asked, and the caller asks again once the run has `started`.
   *
   * @param runId - The run.
   * @param by - Who asked, as a `dork:` reference, when known.
   * @returns The receipt, or `undefined` when no turn was asked to stop.
   */
  async stop(runId: string, by?: string): Promise<InterruptReceipt | undefined> {
    const run = this.deps.runs.get(runId);
    if (!run || RUN_ENDS.has(run.status)) return undefined;
    if (run.status === 'queued' && this.withdraw(runId, 'stopped')) return undefined;
    const request = writeStopRequest(this.deps.runs, run.sessionId, {
      via: 'stop',
      ...(by !== undefined ? { by } : {}),
    });
    const computer = this.deps.computer?.();
    if (request?.runId !== runId || !computer) return undefined;
    const receipt = await computer.stop(runId);
    if (receipt) writeStopReceipt(this.deps.runs, request, receipt);
    return receipt;
  }

  /**
   * Hear every event of a run's turn from now on: what its runtime says, as
   * the chat's stream shows it. Nothing before the call is replayed.
   *
   * @param runId - The run.
   * @param hear - Called with each event.
   * @returns A function that stops listening.
   */
  watchEvents(runId: string, hear: (event: StreamEvent) => void): () => void {
    return this.deps.events?.(runId, hear) ?? (() => {});
  }

  /**
   * Hear every committed status change of the runs `filter` names (all, when
   * absent), as the run reads after the transaction that changed it. A
   * listener that throws is logged and never stops the others.
   *
   * @param hear - Called with the run.
   * @param filter - One run, one chat, or every run.
   * @returns A function that stops listening.
   */
  watch(hear: (run: TurnRun) => void, filter?: RunWatchFilter): () => void {
    const watcher = {
      filter: filter && 'sessionId' in filter ? { sessionId: chatKeyOf(filter.sessionId) } : filter,
      hear,
    };
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  /**
   * Read a run's words back from where its caller keeps them under a source
   * kind. One owner per kind; registering again replaces it.
   *
   * @param kind - The `<kind>` of the `sourceRef`s it reads.
   * @param source - The reader.
   * @returns A function that unregisters it.
   */
  registerSource(kind: string, source: WordSource): () => void {
    this.sources.set(kind, source);
    return () => {
      if (this.sources.get(kind) === source) this.sources.delete(kind);
    };
  }

  /**
   * Whether a run's words can be asked for: it has no source, or its source's
   * kind has a registered reader. A reader not registered yet (early in a
   * boot) is not the same as words that are gone.
   *
   * @param run - The run.
   */
  canReadWords(run: Pick<TurnRun, 'id' | 'sourceRef'>): boolean {
    if (this.words.has(run.id) || run.sourceRef === null) return true;
    return this.sources.has(run.sourceRef.slice(0, run.sourceRef.indexOf(':')));
  }

  /**
   * A run's words, where its caller keeps them: this process's copy, else
   * its source. `undefined` once neither has them (a restart took this
   * process's copy, or the source let them go).
   *
   * @param run - The run.
   */
  wordsOf(run: Pick<TurnRun, 'id' | 'sourceRef' | 'sessionId'>): string | undefined {
    const held = this.words.get(run.id);
    if (held !== undefined || run.sourceRef === null) return held;
    const colon = run.sourceRef.indexOf(':');
    return this.sources
      .get(run.sourceRef.slice(0, colon))
      ?.read(run.sourceRef.slice(colon + 1), run);
  }

  /**
   * The folder a run was started for, as its `start_turn` keeps it.
   *
   * @param runId - The run.
   */
  cwdOf(runId: string): string | undefined {
    const start = this.deps.effects
      .listForRun(runId)
      .find((effect) => effect.kind === 'start_turn');
    const parsed = StartPayloadSchema.safeParse(start?.payload);
    return parsed.success ? parsed.data.cwd : undefined;
  }

  /**
   * The run of a queue row, by the row's id, the row present or gone: how a
   * row an earlier version queued in a chat finds the run adoption gave it.
   *
   * @param queueMessageId - The queue row's id.
   */
  runOfQueueRow(queueMessageId: string): TurnRun | undefined {
    return this.deps.runs.findByQueueMessage(queueMessageId);
  }

  /**
   * Whether a chat's queue still holds a row by this id: a message an earlier
   * version queued in the chat, which the queue still starts.
   *
   * @param rowId - The queue row's id.
   */
  waitsInQueue(rowId: string): boolean {
    return this.deps.queueRowExists?.(rowId) ?? false;
  }

  /**
   * The mini app a run's source names, when it has one.
   *
   * @param run - The run.
   */
  appOf(
    run: Pick<TurnRun, 'sourceRef' | 'sessionId'>
  ): { extensionId: string; name: string } | undefined {
    if (run.sourceRef === null) return undefined;
    const colon = run.sourceRef.indexOf(':');
    return this.sources
      .get(run.sourceRef.slice(0, colon))
      ?.app?.(run.sourceRef.slice(colon + 1), run);
  }

  /**
   * Let a run's words go wherever its caller keeps them: this process's copy
   * and its source's (`WordSource.forget`).
   *
   * @param run - The run.
   */
  forgetWords(run: Pick<TurnRun, 'id' | 'sourceRef' | 'sessionId'>): void {
    this.words.delete(run.id);
    if (run.sourceRef === null) return;
    const colon = run.sourceRef.indexOf(':');
    this.sources.get(run.sourceRef.slice(0, colon))?.forget?.(run.sourceRef.slice(colon + 1), run);
  }

  /**
   * A run moved (inside its transaction): forget its words once it no longer
   * waits to start, and tell the watchers after the transaction commits.
   *
   * @param run - The run, as stored after the move.
   */
  moved(run: TurnRun): void {
    // Kept until the run can no longer come back to `queued`: a pause can cut
    // its turn even after the runtime's first event (transition 15).
    if (RUN_ENDS.has(run.status)) {
      this.words.delete(run.id);
      // A wake's words leave its payload with the run (§6.2).
      if (run.sourceRef?.startsWith(`${WAKE_SOURCE}:`)) {
        letGoOfWakeWords(this.deps.effects, run.sourceRef.slice(WAKE_SOURCE.length + 1));
      }
    }
    if (this.watchers.size === 0) return;
    // After the synchronous transaction it was called inside: a rolled-back
    // move is then read as it really stands, never as it was asked for.
    queueMicrotask(() => this.tell(run.id));
  }

  /** Tell the watchers how a run reads now. */
  private tell(runId: string): void {
    const run = this.deps.runs.get(runId);
    if (!run) return;
    for (const { filter, hear } of [...this.watchers]) {
      if (filter && 'runId' in filter && filter.runId !== run.id) continue;
      if (filter && 'sessionId' in filter && filter.sessionId !== run.sessionId) continue;
      try {
        hear(run);
      } catch (err) {
        logger.warn('[runs] a run watcher threw', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * A waiting run's place among its chat's runs without a queue row, 1-based
   * (§4.6): the order of the chat's open `start_turn` effects.
   */
  private queuePositionOf(run: TurnRun): number {
    const place = this.deps.effects.openStartRunsOf(run.sessionId).indexOf(run.id);
    return place === -1 ? 1 : place + 1;
  }
}
