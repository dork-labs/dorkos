/**
 * The real beat launch through the turn port (spec `heartbeats` §7.1, §7.2;
 * spec `turns-survive-restarts` T8): the space face, admission, the
 * `start_turn` handler, the computer face, the launch path, the dispatcher and
 * the run record are all real, over a `FakeAgentRuntime` and a clock the
 * outbox reads, so the worker's passes are driven one at a time.
 *
 * The proof the step is done: a beat that finds every launch slot taken is
 * never refused for it. It waits, and its turn starts when a slot frees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ulid } from 'ulidx';
import { agents, sessionMetadata, type Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent } from '@dorkos/shared/types';
import type { StartTurnInput } from '@dorkos/shared/turn-port';

import { runtimeRegistry } from '../../core/runtime-registry.js';
import {
  clearTestHomes,
  registerTestHomes,
} from '../../core/agent-identity/__tests__/agent-home-fixture.js';
import {
  resetMessageDispatcher,
  setQueuedChatCeilingResolver,
} from '../../session/message-dispatcher.js';
import { MessageQueueStore, setMessageQueueStore } from '../../session/message-queue-store.js';
import { disposeProjector } from '../../session/session-state-projector.js';
import { dispatchSessionMessage } from '../../session/launch/launch-session.js';
import { agentLaunchMaxLive, claimCappedLaunch } from '../../session/launch/launch-cap.js';
import { createComputerTurnPort } from '../../session/turn-port/computer-turn-port.js';
import { isAgentLaunchCapFull } from '../../session/turn-port/index.js';
import {
  getRunRecord,
  installRunRecord,
  uninstallRunRecord,
  type RunRecord,
} from '../../runs/index.js';
import type { SpaceTurnPort } from '../../runs/turn-port.js';
import { createBeatTurnLauncher, type BeatLaunchRequest } from '../beat-launch.js';
import { isBeatTurn, registerBeatTurn, resetBeatTurns } from '../beat-turns.js';

/** Two made-up agents and their homes. */
const JUNO = { id: '01KBEATAGENTJ0000000000000', home: '/demo/agents/juno' } as const;
const MIRA = { id: '01KBEATAGENTM0000000000000', home: '/demo/agents/mira' } as const;
const HOMES: Record<string, string> = { [JUNO.id]: JUNO.home, [MIRA.id]: MIRA.home };

let db: Db;
let runtime: FakeAgentRuntime;
let record: RunRecord;
let clock: number;
let chats: string[];
/** Slots of the launch cap this test took by hand, let go after each case. */
let claimed: Array<() => void>;
let releaseLongTurn: (() => void) | undefined;
/** What each turn the runtime ran was given. */
let answered: string[];

/** A beat's turn that works until released. */
const longTurn = async function* (content: string): AsyncGenerator<StreamEvent> {
  answered.push(content);
  yield { type: 'text_delta', data: { text: 'working' } };
  await new Promise<void>((resolve) => {
    releaseLongTurn = resolve;
  });
  yield { type: 'done', data: {} };
};

/** A turn that answers at once. */
const quick = async function* (content: string): AsyncGenerator<StreamEvent> {
  answered.push(content);
  yield { type: 'text_delta', data: { text: 'checked' } };
  yield { type: 'done', data: {} };
};

/** Let every pending microtask and timer-0 callback run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** One worker pass, as a wake runs it, and everything it set going. */
async function pass(): Promise<void> {
  await record.worker.runOnce();
  await settle();
}

/** A beat chat of an agent, already bound to the fake runtime. */
function beatChat(agent: { home: string }): string {
  const sessionId = crypto.randomUUID();
  chats.push(sessionId);
  db.insert(sessionMetadata)
    .values({
      sessionId,
      runtime: runtime.type,
      agentPath: agent.home,
      createdAt: new Date().toISOString(),
    })
    .run();
  return sessionId;
}

/** A beat's launch, as the cycle asks for it, keeping how it settled. */
function beatLaunch(
  agent: { id: string },
  sessionId: string,
  extra: Partial<BeatLaunchRequest> = {}
) {
  const settled: Array<[string, string | undefined]> = [];
  const messageId = ulid();
  const launched = createBeatTurnLauncher(() => record.port).launch({
    sessionId,
    messageId,
    agentId: agent.id,
    runtime: runtime.type,
    content: `This is a heartbeat for ${sessionId}.`,
    onSettled: (outcome, refusal) => settled.push([outcome, refusal]),
    ...extra,
  });
  return { launched, settled, runId: messageId };
}

beforeEach(() => {
  db = createTestDb();
  clock = Date.now();
  chats = [];
  claimed = [];
  answered = [];
  const now = new Date().toISOString();
  for (const agent of [JUNO, MIRA]) {
    db.insert(agents)
      .values({
        id: agent.id,
        name: agent === JUNO ? 'juno' : 'mira',
        runtime: 'claude-code',
        projectPath: agent.home,
        registeredAt: now,
        updatedAt: now,
      })
      .run();
  }
  registerTestHomes([JUNO.home, MIRA.home]);
  setMessageQueueStore(new MessageQueueStore(db));
  runtime = new FakeAgentRuntime('fake-beat');
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtimeRegistry.setDb(db);
  runtimeRegistry.register(runtime);
  runtimeRegistry.setDefault(runtime.type);
  setQueuedChatCeilingResolver(() => 'runtime-default');
  const computer = createComputerTurnPort({
    meshCore: () => ({
      getProjectPath: (id: string) => HOMES[id],
      listWithPaths: () =>
        [
          { id: JUNO.id, name: 'juno', projectPath: JUNO.home },
          { id: MIRA.id, name: 'mira', projectPath: MIRA.home },
        ] as never,
    }),
    roomSessionPlace: () => undefined,
  });
  installRunRecord(db, {
    epoch: '01BOOTEPOCHBEAT00000000000',
    now: () => clock,
    computer: () => computer,
    agentHome: () => (id) => HOMES[id],
    admission: {
      admission: { pausedAgent: () => undefined, machineFull: isAgentLaunchCapFull },
    },
  });
  record = getRunRecord()!;
});

afterEach(async () => {
  releaseLongTurn?.();
  releaseLongTurn = undefined;
  for (const release of claimed) release();
  await settle();
  setQueuedChatCeilingResolver(undefined);
  resetMessageDispatcher();
  uninstallRunRecord();
  setMessageQueueStore(undefined);
  for (const sessionId of chats) disposeProjector(sessionId);
  clearTestHomes();
  resetBeatTurns();
  vi.restoreAllMocks();
});

describe('a beat at the launch cap', () => {
  it('waits for a slot rather than being refused, and starts when a running turn frees one', async () => {
    // Purpose: fails if a beat at the cap ended refused ("Too many chats were
    // running"), or waited for anything but a slot to free.
    runtime.withScenarios([longTurn, quick]);
    // Every slot but one is taken by others; Juno's beat takes the last.
    for (let i = 1; i < agentLaunchMaxLive(); i++) claimed.push(claimCappedLaunch());
    const first = beatLaunch(JUNO, beatChat(JUNO));
    await pass();
    expect(await first.launched).toMatchObject({ status: 'started' });
    expect(isAgentLaunchCapFull()).toBe(true);

    let answer: unknown;
    const second = beatLaunch(MIRA, beatChat(MIRA));
    void second.launched.then((result) => (answer = result));
    await pass();
    // Mira's beat is not refused: it waits, saying why, and has not reached its agent.
    expect(record.store.get(second.runId)).toMatchObject({
      status: 'queued',
      waitReason: 'machine_full',
    });
    expect(answer).toBeUndefined();
    expect(answered).toHaveLength(1);

    // Juno's turn ends; its slot frees, and that run letting go wakes Mira's start.
    releaseLongTurn!();
    await vi.waitFor(() => expect(first.settled).toEqual([['ok', undefined]]));
    expect(isAgentLaunchCapFull()).toBe(false);
    await pass();
    expect(answer).toMatchObject({ status: 'started' });
    await vi.waitFor(() => expect(second.settled).toEqual([['ok', undefined]]));
    expect(answered).toEqual([
      expect.stringContaining('This is a heartbeat'),
      expect.stringContaining('This is a heartbeat'),
    ]);
    expect(record.store.get(second.runId)).toMatchObject({
      origin: { kind: 'heartbeat' },
      agentId: MIRA.id,
      ending: 'completed',
    });
  });

  it('takes back a beat still waiting when heartbeats stop, so it never starts late', async () => {
    for (let i = 0; i < agentLaunchMaxLive(); i++) claimed.push(claimCappedLaunch());
    const stopping = new AbortController();
    const beat = beatLaunch(JUNO, beatChat(JUNO), { signal: stopping.signal });
    await pass();
    expect(record.store.get(beat.runId)?.waitReason).toBe('machine_full');
    stopping.abort();
    expect(await beat.launched).toEqual({
      status: 'refused',
      message: 'Heartbeats stopped before it began.',
    });
    expect(record.store.get(beat.runId)).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'stopped' },
    });
    for (const release of claimed.splice(0)) release();
    clock += 60 * 60_000;
    await pass();
    expect(answered).toEqual([]);
  });
});

describe('what a beat asks the port for', () => {
  /** A space face that only records the start it was asked for. */
  function recordingFace(starts: StartTurnInput[]): SpaceTurnPort {
    return {
      start: (input: StartTurnInput) => {
        starts.push(input);
        return { runId: '01KBEATRVN0000000000000001', status: 'queued', queuePosition: 1 };
      },
      watch: () => () => undefined,
      get: () => undefined,
      withdraw: () => true,
    } as unknown as SpaceTurnPort;
  }

  it('an unattended heartbeat run on the agent’s own runtime, with the account a moved beat starts on', () => {
    const starts: StartTurnInput[] = [];
    const launcher = createBeatTurnLauncher(() => recordingFace(starts));
    const request = {
      sessionId: 'beat-chat',
      messageId: '01KBEATRVN0000000000000000',
      agentId: JUNO.id,
      runtime: 'claude-code',
      content: 'A heartbeat.',
      onSettled: () => undefined,
    };
    void launcher.launch({ ...request, account: 'claude5', carriedMarks: { outsider: true } });
    void launcher.launch(request);
    expect(starts[0]).toMatchObject({
      origin: { kind: 'heartbeat' },
      agentId: JUNO.id,
      runtime: 'claude-code',
      unattended: true,
      accountHint: 'claude5',
      carriedMarks: { outsider: true },
    });
    // A beat that stays where its chat is names no account.
    expect(starts[1]).not.toHaveProperty('accountHint');
  });

  it('is refused, saying so, before startup wired the turn port', async () => {
    const launched = await createBeatTurnLauncher(() => undefined).launch({
      sessionId: 'beat-chat',
      messageId: '01KBEATRVN0000000000000000',
      agentId: JUNO.id,
      runtime: 'claude-code',
      content: 'A heartbeat.',
      onSettled: () => undefined,
    });
    expect(launched).toEqual({ status: 'refused', message: 'DorkOS is still starting.' });
  });
});

describe('a beat chat', () => {
  it("makes a beat chat's turn somebody's own once a message that is not the beat's arrives", async () => {
    registerBeatTurn('beat-chat', { agentId: 'agent-juno', beatId: 'b1', messageId: 'm1' });
    await dispatchSessionMessage({
      sessionId: 'beat-chat',
      origin: { kind: 'interactive' },
      request: { content: 'Actually, skip the invoices today.', agentPath: '/not/an/agent' },
      clientId: 'window-1',
      meshCore: undefined,
      roomSessionPlace: undefined,
    });
    expect(isBeatTurn('beat-chat')).toBe(false);
  });
});
