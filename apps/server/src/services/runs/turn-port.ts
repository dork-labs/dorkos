/**
 * The space face of the turn port (spec `turns-survive-restarts` §3.1,
 * DOR-5157): the one door a space-side caller starts and watches a turn
 * through.
 *
 * `start()` answers at acceptance, never at turn start: it saves the run
 * (`queued`, transition 1) and its `start_turn` effect in one transaction and
 * returns. The outbox's worker then hands the run over: the `start_turn`
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
 * (§3.1 `watch`). The durable `run_update` stream with its cursor is T3's;
 * this is the in-process half a space-side caller needs today.
 *
 * `stop` and `answer` arrive with their first callers (T6 onward).
 *
 * @module services/runs/turn-port
 */
import {
  StartTurnInputSchema,
  wordsWaitInComposer,
  type StartTurnInput,
  type StartTurnResult,
} from '@dorkos/shared/turn-port';
import { SESSION_RELAY_MAX_MESSAGE_LENGTH } from '@dorkos/shared/session-relay';
import { logger } from '../../lib/logger.js';
import { chatKeyOf } from '../session/turn-port/index.js';
import type { EffectStore } from './effects/effect-store.js';
import { startPayloadOf } from './effects/start-payload.js';
import type { RunStore, TurnRun } from './run-store.js';

/** Why the space face refused a start before saving anything. */
export type SpaceRefusalReason = 'content_too_long' | 'invalid_input' | 'invalid_agent_path';

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
   */
  read(id: string): string | undefined;
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
   * @returns The run's id, its status (`queued`) and its place among the chat's waiting runs.
   * @throws {TurnStartRefusedError} When the start is refused before anything is saved.
   */
  start(input: StartTurnInput): StartTurnResult {
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
    const home = this.deps.agentHome?.();
    if (start.agentId !== undefined && home && home(start.agentId) === undefined) {
      throw new TurnStartRefusedError(
        'invalid_agent_path',
        'Choose a registered agent before starting this chat'
      );
    }
    const { runs, effects } = this.deps;
    const run = runs.transaction(() => {
      const created = runs.create({
        chatKey: start.sessionId,
        status: 'queued',
        openedBy: 'caller',
        origin: start.origin,
        ...(start.agentId !== undefined ? { agentId: start.agentId } : {}),
        ...(start.askedByRef !== undefined ? { askedByRef: start.askedByRef } : {}),
        ...(start.sourceRef !== undefined ? { sourceRef: start.sourceRef } : {}),
        ...(start.notAfter !== undefined ? { notAfter: start.notAfter } : {}),
      });
      effects.insert({
        kind: 'start_turn',
        key: `start:${created.id}:${created.attempt}`,
        runId: created.id,
        // The chat it orders behind: only a run whose words stay at their
        // source waits in line here; a composer's words wait as a queue row.
        ...(wordsWaitInComposer(start.origin) ? {} : { sessionId: created.sessionId }),
        payload: startPayloadOf(start),
        delivery: 'repeatable',
        notAfter: start.notAfter ?? null,
      });
      return created;
    });
    this.words.set(run.id, start.content);
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
  wordsOf(run: Pick<TurnRun, 'id' | 'sourceRef'>): string | undefined {
    const held = this.words.get(run.id);
    if (held !== undefined || run.sourceRef === null) return held;
    const colon = run.sourceRef.indexOf(':');
    return this.sources.get(run.sourceRef.slice(0, colon))?.read(run.sourceRef.slice(colon + 1));
  }

  /**
   * A run moved (inside its transaction): forget its words once it no longer
   * waits to start, and tell the watchers after the transaction commits.
   *
   * @param run - The run, as stored after the move.
   */
  moved(run: TurnRun): void {
    if (run.status !== 'queued' && run.status !== 'starting') this.words.delete(run.id);
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
