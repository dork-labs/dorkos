/**
 * K13 (spec `turns-survive-restarts` §8; T15, DOR-5234): today's
 * background-work wake (DOR-2065), routed through the run record as a
 * `lost_work_wake` and unchanged for the user. The runtime under test is
 * `FakeAgentRuntime` declaring `wakesForLostBackgroundWork`, with a seeded
 * record, as the ticket rules: recovery reads the capability per runtime and
 * never assumes Claude Code. Over the real dispatcher and launch path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { dispatchMessage } from '../../session/message-dispatcher.js';
import { getOrCreateProjector } from '../../session/session-state-projector.js';
import { CUT_SHORT_WAKE_MESSAGE } from '../../session/runtime-turns/wake-cut-short-work.js';
import { RUNS } from '../../../config/constants.js';
import { continuationWords } from '../recovery/continue-after-restart.js';
import { lostWorkKey, type LostWorkRecord } from '../recovery/lost-work.js';
import {
  AGENT,
  boot,
  deadBoot,
  h,
  kill,
  pass,
  quick,
  runningRun,
  setUpHarness,
  tearDownHarness,
} from './restart-harness.js';

/** The ledger as the boot reads it: records, and which were let go. */
let ledger: LostWorkRecord[];

/** One record a previous run left: the chat's ended turn held background work. */
function record(overrides: Partial<LostWorkRecord> = {}): LostWorkRecord {
  return {
    key: `proc-${h.sessionId}`,
    sessionId: h.sessionId,
    cwd: AGENT.home,
    since: h.now - 60_000,
    runtime: h.inner.type,
    ...overrides,
  };
}

/** A boot that found these records, and lets each go as recovery says. */
function bootWith(records: LostWorkRecord[], elsewhere: string[] = []) {
  ledger = [...records];
  return boot({
    lostWork: records,
    release: (gone) => {
      ledger = ledger.filter((kept) => kept !== gone);
    },
    drivenElsewhere: (ids) => new Set(ids.filter((id) => elsewhere.includes(id))),
  });
}

/** The wakes the runtime ran. */
const wakes = (): string[] => h.answered.filter((words) => words === CUT_SHORT_WAKE_MESSAGE);

let release: (() => void) | undefined;

beforeEach(async () => {
  await setUpHarness();
  h.declares.wakesForLostBackgroundWork = true;
  h.inner.hasSession.mockReturnValue(true);
  release = undefined;
});

afterEach(async () => {
  release?.();
  await vi.waitFor(() => expect(h.inner.isTurnOpen(h.sessionId)).toBe(false));
  await tearDownHarness();
});

describe('K13: an ended turn whose process held background work', () => {
  it('wakes its chat once, with today’s message, under a run its key names; a second boot wakes nobody', async () => {
    const found = record();
    bootWith([found]);
    await pass();
    await vi.waitFor(() => expect(wakes()).toHaveLength(1));

    const run = h.record!.store.findByStartKey(lostWorkKey(found));
    expect(run).toMatchObject({ origin: { kind: 'resume' }, status: 'ended' });
    expect(ledger).toEqual([]);

    // A boot that died before it let the record go reads it again.
    kill();
    bootWith([found]);
    await pass();
    expect(wakes()).toHaveLength(1);
    expect(ledger).toEqual([]);
  });

  it('wakes no busy chat, no room or task chat, nothing past the age bound, and no runtime that does not declare it', async () => {
    const roomChat = crypto.randomUUID();
    const stale = record({ key: 'proc-stale', since: h.now - RUNS.RESTART_AGE_BOUND_MS - 1 });
    // The chat is busy with a turn that runs until released.
    h.inner.withScenarios([
      async function* busy(content: string): AsyncGenerator<StreamEvent> {
        h.answered.push(content);
        yield { type: 'text_delta', data: { text: 'working' } };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { type: 'done', data: {} };
      },
      quick,
    ]);
    bootWith([], []);
    await dispatchMessage({
      origin: { kind: 'interactive' },
      sessionId: h.sessionId,
      clientId: 'person-window',
      content: 'the person is working',
      projector: getOrCreateProjector(h.sessionId, AGENT.home),
      runtime: runtimeRegistry.get(h.inner.type),
      cwd: AGENT.home,
    });
    await vi.waitFor(() => expect(h.inner.isTurnOpen(h.sessionId)).toBe(true));

    const busy = record({ key: 'proc-busy' });
    const room = record({ key: 'proc-room', sessionId: roomChat });
    const undeclared = record({
      key: 'proc-other',
      sessionId: crypto.randomUUID(),
      runtime: 'not-declared',
    });
    // A later boot of the same process reads them; the live turn is this boot's.
    const recovery = h.record!.recovery;
    ledger = [busy, room, stale, undeclared];
    recovery.recoverAtBoot({
      lostWork: ledger,
      release: (gone) => {
        ledger = ledger.filter((kept) => kept !== gone);
      },
      drivenElsewhere: (ids) => new Set(ids.filter((id) => id === roomChat)),
    });
    await pass();
    expect(wakes()).toEqual([]);
    expect(ledger).toEqual([]);
  });

  it('folds into the continuation when the same chat is also picked back up', async () => {
    runningRun(deadBoot().store);
    kill();
    bootWith([record()]);
    await pass();
    await vi.waitFor(() => expect(h.answered).toHaveLength(1));
    expect(h.answered).toEqual([
      continuationWords([{ kind: 'background_work', label: 'a background task' }]),
    ]);
    expect(wakes()).toEqual([]);
    expect(ledger).toEqual([]);
  });
});
