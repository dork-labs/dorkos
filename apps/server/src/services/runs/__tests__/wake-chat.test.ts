/**
 * Wakes (spec `turns-survive-restarts` §6.2 `wake_chat`, §6.3; T7, DOR-5215):
 * one event, one turn, whatever dies in between. Over the real space face,
 * outbox worker, computer face, launch path, dispatcher and SQLite; only the
 * runtime is a double and the clock is injected. A "kill" drops every
 * in-memory object without a shutdown path and lets every lease run out, then
 * the next process boots on the same database (§8, Tier A).
 *
 * Every source in §6.3 saves its wake through the same door (`wakeChat`), so
 * these cases prove "a kill between claim and turn loses none and doubles
 * none" for each of them; each source's own test proves it mints its event id
 * and saves the wake with the change that causes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sessionMessageQueue, turnEffects, turnRuns } from '@dorkos/db';
import type { StreamEvent } from '@dorkos/shared/types';
import type { WakeRequest } from '@dorkos/shared/turn-port';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { dispatchMessage } from '../../session/message-dispatcher.js';
import { getOrCreateProjector } from '../../session/session-state-projector.js';
import { wakeChat } from '../index.js';
import { EFFECT_LEASE_MS } from '../effects/worker.js';
import { wakeChatHandler } from '../effects/handlers/wake-chat.js';
import { quickTurn, wakeHarness, type WakeHarness } from './wake-harness.js';

const EPOCH = '01BOOTEPOCHWAKE00000000000';
const NEXT_EPOCH = '01BOOTEPOCHWAKE00000000001';
const WORDS = 'The sign-in finished. Pick the job back up.';

let h: WakeHarness;
let releaseLongTurn: (() => void) | undefined;

/** One event's wake, as a source saves it. */
function wake(eventId = 'event-1', extra: Partial<WakeRequest['start']> = {}): WakeRequest {
  return {
    sourceKind: 'signin',
    eventId,
    start: {
      sessionId: h.sessionId,
      cwd: h.home,
      content: WORDS,
      origin: { kind: 'resume' },
      tier: 'owner',
      ...extra,
    },
  };
}

/** The wake's effect, by its key. */
function wakeEffect(eventId = 'event-1') {
  const row = h.db
    .select({ id: turnEffects.id })
    .from(turnEffects)
    .where(eq(turnEffects.key, `wake:signin:${eventId}`))
    .get();
  return row ? h.record().effects.get(row.id) : undefined;
}

/** Every run made under one event's key, read straight from the table. */
function runsUnder(eventId = 'event-1') {
  return h.db
    .select()
    .from(turnRuns)
    .where(eq(turnRuns.startKey, `wake:signin:${eventId}`))
    .all();
}

/** Passes until the worker has nothing more due now. */
async function drain(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) await h.pass();
}

/** A person's turn holding the chat until released. */
async function personWorking(): Promise<void> {
  h.runtime.withScenarios([
    async function* (content: string): AsyncGenerator<StreamEvent> {
      h.answered.push(content);
      yield { type: 'text_delta', data: { text: 'working' } };
      await new Promise<void>((resolve) => {
        releaseLongTurn = resolve;
      });
      yield { type: 'done', data: {} };
    },
    quickTurn(h.answered),
    quickTurn(h.answered),
  ]);
  await dispatchMessage({
    origin: { kind: 'interactive' },
    sessionId: h.sessionId,
    clientId: 'person-window',
    content: 'the person is working',
    projector: getOrCreateProjector(h.sessionId, h.home),
    runtime: runtimeRegistry.get(h.runtime.type),
    cwd: h.home,
  });
  await vi.waitFor(() => expect(h.runtime.isTurnOpen(h.sessionId)).toBe(true));
}

beforeEach(() => {
  h = wakeHarness({ epoch: EPOCH });
});

afterEach(async () => {
  releaseLongTurn?.();
  releaseLongTurn = undefined;
  await h.dispose();
});

describe('one key, one run (§6.4)', () => {
  it('answers a start under a key already used with that run, and saves nothing', () => {
    const start = { ...wake().start, startKey: 'wake:signin:event-1' };
    const first = h.record().port.start(start);
    const again = h.record().port.start({ ...start, content: 'a second copy' });
    expect(again.runId).toBe(first.runId);
    expect(runsUnder()).toHaveLength(1);
    expect(h.record().effects.listForRun(first.runId)).toHaveLength(1);
  });

  it('turns one event saved twice into one wake, one run and one turn', async () => {
    expect(wakeChat(wake())).toBe(true);
    expect(wakeChat(wake())).toBe(false);
    await drain();
    expect(h.answered).toEqual([WORDS]);
    const [run] = runsUnder();
    expect(run).toMatchObject({ ending: 'completed', startedAt: expect.any(String) });
    // Its words wait at the wake, never in the composer.
    expect(run!.sourceRef).toMatch(/^wake:/);
    expect(run!.queueMessageId).toBeNull();
    expect(wakeEffect()).toMatchObject({ state: 'done', outcome: { runId: run!.id } });
  });
});

describe('a kill between claim and turn loses none and doubles none', () => {
  const killPoints: [string, () => Promise<void>][] = [
    ['after the wake is saved, before the worker takes it', async () => {}],
    [
      'after the worker took the wake, before its run was made',
      async () => {
        expect(h.record().effects.leaseNext(EPOCH, EFFECT_LEASE_MS)?.kind).toBe('wake_chat');
      },
    ],
    [
      'after its run was made, before the wake was marked done',
      async () => {
        // Two stores, once the record moves (§6.4): only the key keeps this safe.
        expect(h.record().effects.leaseNext(EPOCH, EFFECT_LEASE_MS)?.kind).toBe('wake_chat');
        h.record().port.start({
          ...wake().start,
          startKey: 'wake:signin:event-1',
          sourceRef: `wake:${wakeEffect()!.id}`,
        });
      },
    ],
    [
      'after its run was handed over, before its turn started',
      async () => {
        h.holdLaunches(new Promise<void>(() => {}));
        // The pass never ends: its hand-over waits on the launch until the process dies.
        void h.pass();
        await vi.waitFor(() => {
          const [run] = runsUnder();
          const start = h
            .record()
            .effects.listForRun(run!.id)
            .find((effect) => effect.kind === 'start_turn');
          expect(start?.state).toBe('leased');
          expect(run!.status).toBe('queued');
        });
      },
    ],
  ];

  it.each(killPoints)('%s', async (_point, killHere) => {
    // Purpose: fails if a restart at this point dropped the wake, or ran its turn twice.
    expect(wakeChat(wake())).toBe(true);
    await killHere();
    h.kill();
    h.boot(NEXT_EPOCH);
    await drain();
    for (let i = 0; i < 3 && h.answered.length === 0; i++) {
      h.advance(10 * 60_000);
      await drain();
    }
    expect(h.answered).toEqual([WORDS]);
    const runs = runsUnder();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ ending: 'completed', startedAt: expect.any(String) });
    expect(wakeEffect()?.state).toBe('done');
  });
});

describe('the wake’s own rules', () => {
  it('drops a wake whose chat is stored nowhere, and makes no run', async () => {
    wakeChat({ ...wake(), onlyIfChatExists: { cwd: h.home } });
    const effect = h.record().effects.leaseNext(EPOCH, EFFECT_LEASE_MS)!;
    const chatExists = vi.fn(async () => false);
    const handler = wakeChatHandler({
      runs: h.record().store,
      effects: h.record().effects,
      port: h.record().port,
      chatExists,
    });
    const answer = await handler.handle(effect, {
      now: h.now,
      markDone: vi.fn(),
      release: vi.fn(),
    });
    expect(answer).toEqual({ kind: 'drop', reason: 'session_gone' });
    expect(chatExists).toHaveBeenCalledWith(h.sessionId, h.home);
    expect(runsUnder()).toEqual([]);
  });

  it('keeps a not-late wake out of the composer, waits for a busy chat, and expires past its deadline', async () => {
    // Purpose: fails if `whenBusy: 'refuse'` came back as a queue row, or a late wake still ran.
    await personWorking();
    // A person's click (`interactive`) with a deadline: words that would wait as a row without one.
    wakeChat(wake('click-1', { origin: { kind: 'interactive' }, notAfter: h.now() + 60_000 }));
    await drain();
    const [run] = runsUnder('click-1');
    expect(run).toMatchObject({ status: 'queued', waitReason: 'chat_busy', queueMessageId: null });
    expect(h.db.select().from(sessionMessageQueue).all()).toEqual([]);
    h.advance(60_001);
    await drain();
    expect(runsUnder('click-1')[0]).toMatchObject({ status: 'cancelled' });
    releaseLongTurn?.();
    await vi.waitFor(() => expect(h.runtime.isTurnOpen(h.sessionId)).toBe(false));
    await drain();
    expect(h.answered).toEqual(['the person is working']);
  });
});

describe('a wake lets go of its words (§6.2, F29)', () => {
  /** What a wake keeps once it let go: the event's names, never its words. */
  const keptOf = (eventId: string, origin: WakeRequest['start']['origin']) => ({
    sourceKind: 'signin',
    eventId,
    sessionId: h.sessionId,
    origin,
    wordsLetGo: true,
  });

  it('keeps no words once its run ended, and its key still refuses a second wake', async () => {
    expect(wakeChat(wake())).toBe(true);
    await drain();
    expect(runsUnder()[0]).toMatchObject({ ending: 'completed' });
    expect(wakeEffect()?.payload).toEqual(keptOf('event-1', { kind: 'resume' }));
    expect(JSON.stringify(wakeEffect()?.payload)).not.toContain(WORDS);
    expect(wakeChat(wake())).toBe(false);
    await drain();
    expect(runsUnder()).toHaveLength(1);
  });

  it('keeps no words once it expired with no run, and its key still refuses a second wake', async () => {
    wakeChat(wake('late-1', { notAfter: h.now() + 1_000 }));
    h.advance(1_001);
    await drain();
    expect(wakeEffect('late-1')?.state).toBe('expired');
    expect(runsUnder('late-1')).toEqual([]);
    expect(wakeEffect('late-1')?.payload).toEqual(keptOf('late-1', { kind: 'resume' }));
    expect(wakeChat(wake('late-1'))).toBe(false);
  });
});
