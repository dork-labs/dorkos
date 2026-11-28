/**
 * Shared fakes for the relay request server tests: the agents, chat facts and a
 * server over fakes that records the frames it emitted and the audits it wrote.
 */
import { expect, vi, type Mock } from 'vitest';
import {
  RelayComputerFrameSchema,
  type RelayComputerFrame,
  type RelayRequest,
} from '@dorkos/shared/session-relay';
import type { Session } from '@dorkos/shared/types';
import type { RecordAuditInput } from '../../../../audit/audit-trail.js';
import type { StartTurnInput } from '@dorkos/shared/turn-port';
import type { HandOverNowAnswer } from '@dorkos/shared/turn-hand-over';
import type { DurableStreamSink } from '../../../streams/durable-stream-sink.js';
import type { SessionStreamRequest } from '../../../streams/session-stream-plan.js';
import {
  SessionRelayRequestServer,
  type RelayRequestServerDeps,
} from '../../relay-request-server.js';
import type { RelayAgent, RelaySessionFacts } from '../../relay-serves.js';

export const AGENT_ID = '01J0000000000000000000000A';
export const SYSTEM_ID = '01J0000000000000000000000S';
export const UNKNOWN_ID = '01J0000000000000000000000X';
export const PROJECT = '/work/acme';
const AGENTS: RelayAgent[] = [
  { id: AGENT_ID, projectPath: PROJECT, isSystem: false },
  { id: SYSTEM_ID, projectPath: '/home/me/.dork/agents/dorkbot', isSystem: true },
];

/** A lowercase UUID for test chat `n`. */
export const sid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const CHAT = sid(1);
export const NEW_CHAT = sid(99);

/** A session row for chat `id`. */
export function row(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    title: `Chat ${id.slice(-2)}`,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    ...over,
  } as Session;
}

/** The facts the server reads about chat `id`, served by default. */
export function facts(id: string, over: Partial<RelaySessionFacts> = {}): RelaySessionFacts {
  return {
    sessionId: id,
    cwd: PROJECT,
    agentPath: PROJECT,
    launchOrigin: 'interactive',
    row: row(id),
    ownedBy: { room: false, task: false, beat: false },
    ...over,
  };
}

/** One stream the server opened, and how to end it from the session side. */
export interface OpenStream {
  sink: DurableStreamSink;
  plan: SessionStreamRequest;
  done: () => void;
}

/** What {@link harness} hands a test. */
export interface RelayHarness {
  server: SessionRelayRequestServer;
  deps: RelayRequestServerDeps;
  frames: RelayComputerFrame[];
  audits: RecordAuditInput[];
  streams: OpenStream[];
  runtime: { type: string; interruptQuery: Mock; submitAnswers: Mock; approveTool: Mock };
  handOverTurn: Mock<(input: StartTurnInput) => Promise<HandOverNowAnswer>>;
  emit: (frame: RelayComputerFrame) => void;
  send: (id: string, request: unknown) => void;
  settle: () => Promise<unknown>;
  answerTo: (id: string) => RelayComputerFrame | undefined;
}

/** A server over fakes, the frames it emitted and the audit entries it wrote. */
export function harness(
  opts: { chats?: RelaySessionFacts[]; deps?: Partial<RelayRequestServerDeps> } = {}
): RelayHarness {
  const known = new Map((opts.chats ?? [facts(CHAT)]).map((f) => [f.sessionId, f]));
  const frames: RelayComputerFrame[] = [];
  const audits: RecordAuditInput[] = [];
  const streams: OpenStream[] = [];
  const runtime = {
    type: 'claude-code',
    interruptQuery: vi.fn(async () => ({
      outcome: 'not-running' as const,
      runtime: 'claude-code',
    })),
    submitAnswers: vi.fn(() => true),
    approveTool: vi.fn(() => true),
  };
  const handOverTurn = vi.fn(async (input: StartTurnInput): Promise<HandOverNowAnswer> => ({
    kind: 'handed',
    runId: '01KRELAYRUN000000000000000',
    receipt: {
      canonicalId: input.sessionId,
      outcome: { requested: 'queue', applied: 'queue', messageId: 'm1' },
      queuePosition: 1,
      queued: false,
    },
  }));
  const deps: RelayRequestServerDeps = {
    agents: () => AGENTS,
    locateSession: vi.fn(async (id: string) => known.get(id) ?? null),
    listAgentSessions: vi.fn(async () => [...known.values()]),
    resolveStreamPlan: vi.fn(async (f: RelaySessionFacts, resume: string | undefined) => ({
      sessionId: f.sessionId,
      runtime: {} as SessionStreamRequest['runtime'],
      ctx: { cwd: f.cwd!, permissionMode: 'default' },
      resume: resume ? { seq: 7, generation: 'g1' } : undefined,
    })),
    deliverSessionStream: vi.fn(
      (sink: DurableStreamSink, plan: SessionStreamRequest) =>
        new Promise<void>((resolve) => {
          streams.push({ sink, plan, done: resolve });
          sink.signal.addEventListener('abort', () => resolve());
        })
    ),
    handOverTurn,
    resolveRuntime: vi.fn(async () => runtime),
    clearQueuedMessages: vi.fn(() => [
      { id: 'q1', content: 'later', disposition: 'queue', enqueuedAt: 1, enqueuedBy: 'x' },
    ]) as unknown as RelayRequestServerDeps['clearQueuedMessages'],
    recordAudit: (input) => {
      audits.push(input);
    },
    owner: () => ({ accountId: 'acct-owner', kind: 'person', name: 'Dorian' }),
    approvalKeys: () => null,
    approvalPin: () => null,
    pendingApproval: () => null,
    approvableCard: () => true,
    approveTool: vi.fn(async () => true),
    bumpSignCount: vi.fn(async () => true),
    ...opts.deps,
  };
  const server = new SessionRelayRequestServer(deps);
  const emit = (frame: RelayComputerFrame) => {
    // Every frame the server sends is one the protocol accepts.
    expect(RelayComputerFrameSchema.safeParse(frame).success).toBe(true);
    frames.push(frame);
  };
  const send = (id: string, request: unknown) =>
    server.handle({ type: 'request', id, request: request as RelayRequest }, emit);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const answerTo = (id: string) => frames.find((f) => 'id' in f && f.id === id);
  return {
    server,
    deps,
    frames,
    audits,
    streams,
    runtime,
    handOverTurn,
    emit,
    send,
    settle,
    answerTo,
  };
}
