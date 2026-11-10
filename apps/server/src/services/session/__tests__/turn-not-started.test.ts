/**
 * A turn the runtime refuses before the agent sees the message settles
 * `failed`, with the runtime's words, so nothing it carried is reported
 * delivered (DOR-2994). Through the real session launch and dispatcher on a
 * `FakeAgentRuntime`: the refusal is an `error` + `done` pair, never a throw,
 * which is exactly the shape that used to read as a turn that ran.
 */
import { ChatReportBack, type ChatReportBackDeps } from '../chat-messages/chat-report-back.js';
import {
  getSpinOffStartup,
  SPIN_OFF_START_TIMEOUT_MS,
} from '../chat-messages/startup/spin-off-startup.js';
import { wireSpinOffStartup } from '../chat-messages/startup/wire-spin-off-startup.js';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent } from '@dorkos/shared/types';

vi.mock('../../../lib/boundary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/boundary.js')>()),
  validateBoundary: vi.fn(async (p: string) => p),
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
}));

import { runtimeRegistry } from '../../core/runtime-registry.js';
import { dispatchSessionMessage } from '../launch/launch-session.js';
import { onDispatchLifecycle, type DispatchLifecycleEvent } from '../message-dispatcher.js';
import { TURN_NO_ANSWER, turnNotStarted } from '../launch/turn-not-started.js';

const SESSION = '00000000-0000-4000-8000-0000000000d2';
const REFUSAL = 'Too many chats are holding an agent open right now (the limit is 12).';

let home: string;
let runtime: FakeAgentRuntime;
let settled: DispatchLifecycleEvent[];
let unsubscribe: () => void;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'turn-not-started-'));
  runtime = new FakeAgentRuntime('fake-refusal');
  runtimeRegistry.setDb(createTestDb());
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault('fake-refusal');
  settled = [];
  unsubscribe = onDispatchLifecycle((event) => {
    if (event.phase === 'settled') settled.push(event);
  });
});

afterEach(async () => {
  unsubscribe();
  await rm(home, { recursive: true, force: true });
});

/** Send one chat message; resolves with how its turn settled, as the caller is told. */
function send(content: string): Promise<[outcome: 'ok' | 'failed', refusal?: string]> {
  return new Promise((resolve, reject) => {
    const mesh = { listWithPaths: () => [{ id: 'agent-juno', name: 'juno', projectPath: home }] };
    dispatchSessionMessage({
      sessionId: SESSION,
      origin: { kind: 'chat-message' },
      request: { content, agentPath: home },
      clientId: 'chat:sender',
      meshCore: mesh as never,
      roomSessionPlace: undefined,
      onSettled: (outcome, refusal) => resolve([outcome, refusal]),
    }).catch(reject);
  });
}

describe('a turn the runtime refused before the agent saw it', () => {
  it('settles failed, and says why on the settled event', async () => {
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield* turnNotStarted(
          SESSION,
          'warm-ceiling',
          REFUSAL,
          'cannot warm session: 12 warm sessions already'
        );
      },
    ]);

    // The caller hears why too: that is how a heartbeat records it as refused.
    expect(await send('hello')).toEqual(['failed', 'warm-ceiling']);
    expect(settled).toEqual([
      expect.objectContaining({ outcome: 'failed', reason: 'warm-ceiling' }),
    ]);
  });

  it('still settles ok for a turn that ran and then hit an error', async () => {
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'Working on it' } } as StreamEvent;
        yield { type: 'error', data: { message: 'The model is overloaded.' } } as StreamEvent;
        yield { type: 'done', data: { sessionId: SESSION } } as StreamEvent;
      },
    ]);

    expect(await send('hello')).toEqual(['ok', undefined]);
    expect(settled[0]).not.toHaveProperty('reason');
  });

  // DOR-3287: QA's census sat "delivered" for 3 days behind this exact turn.
  it('says nobody read it when the turn ended on an error with no agent output', async () => {
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'session_status', data: { sessionId: SESSION } } as StreamEvent;
        yield {
          type: 'error',
          data: { message: "You've hit your weekly limit", code: 'rate_limit' },
        } as StreamEvent;
        yield { type: 'done', data: { sessionId: SESSION } } as StreamEvent;
      },
    ]);

    // A caller reads a reason as a refusal, and a beat records one; this turn ran.
    expect(await send('hello')).toEqual(['ok', undefined]);
    expect(settled).toEqual([expect.objectContaining({ outcome: 'ok', reason: TURN_NO_ANSWER })]);
  });

  it('counts a turn the agent answered after an error as one that ran', async () => {
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'error', data: { message: 'Retrying.' } } as StreamEvent;
        yield { type: 'text_delta', data: { text: 'Done' } } as StreamEvent;
        yield { type: 'done', data: { sessionId: SESSION } } as StreamEvent;
      },
    ]);

    expect(await send('hello')).toEqual(['ok', undefined]);
    expect(settled[0]).not.toHaveProperty('reason');
  });
});

describe('spin-off first-turn deadline through the real dispatcher (DOR-3351)', () => {
  let stop: () => void;
  let report: Mock<ChatReportBackDeps['service']['send']>;
  beforeEach(() => {
    vi.useFakeTimers();
    report = vi
      .fn<ChatReportBackDeps['service']['send']>()
      .mockResolvedValue({ messageId: 'report', chatId: 'starter', status: 'queued' });
    const reports = new ChatReportBack({
      service: { send: report },
      store: { listStopsOf: () => [], latestInterruptFrom: () => undefined },
      reportTargetOf: () => ({ parentSessionId: 'starter' }),
      agentPathOf: async () => home,
      holdsBackgroundWork: async () => false,
      statusOf: () => null,
      history: async () => [],
    });
    stop = wireSpinOffStartup(reports);
    getSpinOffStartup()!.watch(SESSION, home);
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it.each(['refused', 'throws', 'empty'] as const)(
    'reports a runtime that %s before producing any output',
    async (mode) => {
      runtime.withScenarios([
        async function* (): AsyncGenerator<StreamEvent> {
          if (mode === 'refused') yield* turnNotStarted(SESSION, 'warm-ceiling', REFUSAL);
          if (mode === 'throws') throw new Error('The runtime failed before reading the message.');
        },
      ]);
      await send('Start the made-up task');
      await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS - 1);
      expect(report).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(report).toHaveBeenCalledOnce();
      const reason =
        mode === 'refused'
          ? REFUSAL
          : mode === 'throws'
            ? 'The runtime failed before reading the message.'
            : 'The runtime did not start its first turn within five minutes.';
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: SESSION }),
        expect.objectContaining({
          to: 'starter',
          summary: 'Failed: never started',
          message: 'Failed: never started.\n\n' + reason,
        }),
        'report'
      );
      expect(getSpinOffStartup()!.failureOf(SESSION)).toBe(reason);
    }
  );

  it('does not report a runtime that answers normally and then goes idle', async () => {
    runtime.withScenarios([
      async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'text_delta', data: { text: 'Done.' } };
        yield { type: 'done', data: {} };
      },
    ]);
    await send('Start the made-up task');
    await vi.advanceTimersByTimeAsync(SPIN_OFF_START_TIMEOUT_MS);
    expect(report).not.toHaveBeenCalled();
    expect(getSpinOffStartup()!.failureOf(SESSION)).toBeNull();
  });
});
