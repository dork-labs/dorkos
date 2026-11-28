/**
 * Tier A, the words a restart cut before the runtime read them (spec
 * `turns-survive-restarts` §7.3 step 4, §6.2 the `delivered` fact, §8 K3; T15,
 * DOR-5234): another chat's message is never replayed, and its sender gets a
 * report into its own chat through the report path (`chat-report-back.ts`),
 * within the age bound only. And a row a turn kept whose `turn_end` was seen,
 * retired before recovery looked, never stays hidden: it is handed back as any
 * `started` run's row is.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatMessages } from '@dorkos/db';
import { getMessageQueueStore } from '../../session/message-queue-store.js';
import {
  ChatMessageStore,
  setChatMessageStore,
} from '../../session/chat-messages/chat-message-store.js';
import { ChatReportBack } from '../../session/chat-messages/chat-report-back.js';
import { setChatReportBack } from '../../session/chat-messages/chat-message-current.js';
import { RUNS } from '../../../config/constants.js';
import {
  AGENT,
  boot,
  deadBoot,
  h,
  kill,
  pass,
  setUpHarness,
  startedRun,
  tearDownHarness,
} from './restart-harness.js';

/** The chat that sent the message. */
const SENDER = '6f0f3c1e-0000-4000-8000-00000000a11c';

/** Every report the report path sent, as `chat_send` was asked to send it. */
let sent: { to: string; message: string; kind: string }[];

/** A message the sender's chat sent, waiting in the chat's queue row `rowId`. */
function sentByAnotherChat(rowId: string): void {
  const at = new Date(h.now).toISOString();
  h.db
    .insert(chatMessages)
    .values({
      id: `msg-${rowId}`,
      toSessionId: h.sessionId,
      fromSessionId: SENDER,
      fromAgentPath: AGENT.home,
      fromAgentName: 'Porter',
      kind: 'message',
      text: 'a message from another chat',
      delivery: 'queue',
      status: 'working',
      queueMessageId: rowId,
      ceilingJson: '"runtime-default"',
      createdAt: at,
      updatedAt: at,
    })
    .run();
}

/** The report path, over a sender that only records what it was asked to send. */
function wireReports(): void {
  setChatMessageStore(new ChatMessageStore(h.db));
  setChatReportBack(
    new ChatReportBack({
      service: {
        send: async (_caller, input, kind) => {
          sent.push({ to: input.to, message: input.message, kind: kind ?? 'message' });
          return {} as never;
        },
      },
      store: { listStopsOf: () => [], latestInterruptFrom: () => undefined },
      reportTargetOf: () => null,
      agentPathOf: async () => AGENT.home,
      holdsBackgroundWork: async () => false,
      statusOf: () => null,
      history: async () => [],
      delay: async () => {},
      later: () => {},
    })
  );
}

/** A chat's message, cut after `turn_start` by a boot that died. */
function chatMessageCut() {
  const run = startedRun(deadBoot().store, {
    row: 'a message from another chat',
    origin: { kind: 'chat-message' },
  });
  sentByAnotherChat(run.queueMessageId!);
  return run;
}

beforeEach(async () => {
  await setUpHarness();
  sent = [];
  wireReports();
});

afterEach(async () => {
  setChatReportBack(undefined);
  setChatMessageStore(undefined);
  await tearDownHarness();
});

describe('K3: another chat’s words, cut before the runtime read them', () => {
  it('are taken away, never replayed, and its chat gets a report saying so', async () => {
    const run = chatMessageCut();
    kill();
    boot();
    await pass();

    expect(getMessageQueueStore()!.get(run.queueMessageId!)).toBeUndefined();
    expect(h.answered).toEqual([]);
    expect(h.lifecycle).toContainEqual(
      expect.objectContaining({
        phase: 'settled',
        messageId: run.queueMessageId,
        outcome: 'failed',
      })
    );
    expect(sent).toEqual([
      expect.objectContaining({
        to: SENDER,
        kind: 'report',
        message: expect.stringContaining('DorkOS restarted'),
      }),
    ]);

    // A second boot decides nothing twice, and reports nothing twice.
    kill();
    boot();
    await pass();
    expect(sent).toHaveLength(1);
  });

  it('past the age bound: the row goes, and no report wakes the sender', async () => {
    const run = chatMessageCut();
    kill();
    h.now += 2 * RUNS.RESTART_AGE_BOUND_MS;
    boot();
    await pass();

    expect(getMessageQueueStore()!.get(run.queueMessageId!)).toBeUndefined();
    expect(sent).toEqual([]);
  });
});

describe('a kept row whose turn_end was seen, retired before recovery looked', () => {
  /** A person's message, cut after `turn_start`, its `turn_end` recorded before the kill. */
  function endedBeforeTheKill(origin: { kind: 'interactive' } | { kind: 'chat-message' }) {
    const dying = deadBoot();
    const run = startedRun(dying.store, { row: 'words a crash caught mid-turn', origin });
    dying.store.annotate(run.id, { ending: 'completed' });
    return run;
  }

  it('a person’s row comes back as a restored draft, never hidden for good', async () => {
    const run = endedBeforeTheKill({ kind: 'interactive' });
    kill();
    // A reader retires it first: ended with its recorded ending, row kept.
    boot({}, { recover: false });
    h.record!.store.retireDeadRuns();
    expect(getMessageQueueStore()!.get(run.queueMessageId!)?.inTurn).toBe(true);

    h.record!.recovery.recoverAtBoot();
    expect(h.record!.store.get(run.id)).toMatchObject({
      ending: 'completed',
      endingDetail: { delivery: 'unknown' },
    });
    expect(getMessageQueueStore()!.get(run.queueMessageId!)).toMatchObject({
      inTurn: false,
      restored: true,
    });
    expect(h.answered).toEqual([]);
  });

  it('another chat’s row goes and its chat hears it, when recovery retires it itself', async () => {
    const run = endedBeforeTheKill({ kind: 'chat-message' });
    sentByAnotherChat(run.queueMessageId!);
    kill();
    boot();
    await pass();
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    expect(h.record!.store.get(run.id)?.ending).toBe('completed');
    expect(getMessageQueueStore()!.get(run.queueMessageId!)).toBeUndefined();
    expect(sent[0]).toMatchObject({ to: SENDER, kind: 'report' });
  });
});
