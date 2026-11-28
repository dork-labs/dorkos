/**
 * T6 (DOR-5214, spec `turns-survive-restarts` §3.5, §4.6, §10 child C) and T6b
 * (DOR-5503): a spin-off's first message, a message sent from the web and a
 * chat message start their turns through the turn port, handed over at once,
 * and a busy machine makes their work wait with its place shown instead of
 * refusing it (`LAUNCH_CAP_FULL`, `RELAY_TOO_MANY_NEW_CHATS`) or holding it
 * outside the port (the chat messages' own cap hold).
 *
 * Over the real launch path, dispatcher, projector, SQLite queue and run
 * record; only the runtime underneath is a double, and the clock the record
 * and outbox read is injected so the worker's passes run one at a time.
 *
 * The parity cases hold the trust the direct path gave these turns: what the
 * launch path is handed through the port must carry every ceiling, mark,
 * launcher and identity the caller's own call carried, never less.
 */
import { describe, expect, it, vi } from 'vitest';
import { WEB_NEW_CHATS_MAX } from '@dorkos/shared/turn-hand-over';
import {
  AGENT,
  LEVEL,
  PARENT,
  answered,
  chat,
  db,
  fillMachine,
  freeMachine,
  fromTheWeb,
  inner,
  launched,
  pass,
  record,
  releases,
  spinOff,
  useHandOverNow,
} from './hand-over-now.fixture.js';
import { sessionMessageQueue } from '@dorkos/db';

useHandOverNow();

describe('a busy machine makes work wait, with its place shown', () => {
  it('a spin-off at a full machine waits for a slot, shows its place, and starts when one frees', async () => {
    // Purpose: fails if LAUNCH_CAP_FULL refuses a spin-off again, or its wait is not visible.
    fillMachine();
    const child = chat();
    const answer = await record.handOver(spinOff(child, 'From Scout: tidy the tests'));
    expect(answer).toMatchObject({ kind: 'waiting', waitReason: 'machine_full', queuePosition: 1 });
    expect(record.view(child)).toEqual([
      expect.objectContaining({ status: 'queued', waitReason: 'machine_full', queuePosition: 1 }),
    ]);
    expect(launched).toEqual([]);

    await freeMachine();
    await vi.waitFor(() => expect(answered).toEqual(['From Scout: tidy the tests']));
    expect(record.store.get(answer.runId)).toMatchObject({ status: 'running', waitReason: null });
  });
  it(`a new chat from the web past ${WEB_NEW_CHATS_MAX} running waits for one to finish, then starts`, async () => {
    // Purpose: fails if RELAY_TOO_MANY_NEW_CHATS refuses a new web chat again.
    const running = Array.from({ length: WEB_NEW_CHATS_MAX }, () => chat());
    for (const id of running) {
      expect(await record.handOver(fromTheWeb(id, `hello ${id}`))).toMatchObject({
        kind: 'handed',
      });
    }
    await vi.waitFor(() => expect(answered).toHaveLength(WEB_NEW_CHATS_MAX));
    const late = chat();
    const answer = await record.handOver(fromTheWeb(late, 'one more'));
    expect(answer).toMatchObject({ kind: 'waiting', waitReason: 'machine_full' });
    // Its place shows on the chat's runs, though its words are not a queue row yet.
    expect(record.view(late)).toEqual([
      expect.objectContaining({ status: 'queued', waitReason: 'machine_full', queuePosition: 1 }),
    ]);

    releases.shift()!();
    await vi.waitFor(() =>
      expect(record.store.get(record.store.listForChat(running[0]!)[0]!.id)?.status).toMatch(
        /ended|settled/u
      )
    );
    await pass();
    await vi.waitFor(() => expect(answered).toContain('one more'));
    expect(record.store.get(answer.runId)?.queueMessageId).toBe(answer.runId);
  });
  it('answers a refusal at the door with the launch path’s own sentence, and cancels the run', async () => {
    const child = chat();
    const answer = await record.handOver(
      spinOff(child, 'From Scout: next door', {
        launcher: { kind: 'agent', agentPath: '/elsewhere' },
      })
    );
    expect(answer).toMatchObject({
      kind: 'refused',
      reason: 'desk_not_own',
      refusal: { code: 'DESK_NOT_OWN', message: expect.any(String) },
    });
    expect(record.store.get(answer.runId)).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'desk_not_own' },
    });
  });
});

describe('trust parity: the port hands the launch path what the direct call did', () => {
  it('a spin-off keeps its launcher, ceiling, marks, account and asker, and counts toward the cap', async () => {
    // Purpose: fails if the port drops a ceiling, a mark or the launcher, or runs it unattended.
    const child = chat();
    const answer = await record.handOver(
      spinOff(child, 'From Scout: careful now', {
        permissionCeiling: LEVEL,
        carriedMarks: { outsider: true },
        seedContext: 'Started by Scout.',
        accountHint: 'work',
      })
    );
    expect(answer).toMatchObject({ kind: 'handed' });
    const [opts] = launched;
    expect(opts).toMatchObject({
      sessionId: child,
      origin: { kind: 'agent-launch' },
      launcher: { kind: 'agent', agentPath: AGENT.home },
      permissionCeiling: LEVEL,
      carriedMarks: { outsider: true },
      countsTowardLaunchCap: true,
      wordsAtSource: true,
      request: {
        content: 'From Scout: careful now',
        cwd: AGENT.home,
        agentPath: AGENT.home,
        seedContext: 'Started by Scout.',
        runtime: inner.type,
        account: 'work',
      },
    });
    expect(opts!.unattended).toBeUndefined();
    // Read as an agent's launch, never as another chat's or the web's.
    expect(opts!.clientId).toBe(`turn-port:${answer.runId}`);
    expect(record.store.get(answer.runId)?.askedByRef).toBe(`dork:chat:${PARENT}`);
  });
  it('a message from the web runs at the agent’s own level, under the relay’s identity', async () => {
    // Purpose: fails if a web message gains a person's clean-send identity (DOR-4693) or a bound.
    const id = chat();
    const answer = await record.handOver(fromTheWeb(id, 'from my phone'));
    expect(answer.kind).toBe('handed');
    const [opts] = launched;
    expect(opts!.clientId).toBe(`relay:${answer.runId}`);
    expect(opts).toMatchObject({ origin: { kind: 'session-relay', newChat: true } });
    expect(opts!.countsTowardLaunchCap).toBe(false);
    expect(opts!.permissionCeiling).toBeUndefined();
    expect(opts!.carriedMarks).toBeUndefined();
    expect(opts!.unattended).toBeUndefined();
    expect(opts!.launcher).toBeUndefined();
  });
  it('a chat message runs as the chat that sent it, and one naming no sender never queues', async () => {
    // Purpose: fails if a chat message could launch without its sender's ceiling (`chat:` identity).
    const id = chat();
    const sent = await record.handOver({
      sessionId: id,
      content: 'From Scout: a note',
      origin: { kind: 'chat-message' },
      tier: 'owner',
      cwd: AGENT.home,
      askedByRef: `dork:chat:${PARENT}`,
    });
    expect(sent.kind).toBe('handed');
    expect(launched[0]!.clientId).toBe(`chat:${PARENT}`);

    const other = chat();
    await expect(
      record.handOver({
        sessionId: other,
        content: 'no sender',
        origin: { kind: 'chat-message' },
        tier: 'owner',
        cwd: AGENT.home,
      })
    ).rejects.toThrow(/names the chat that sent it/u);
    expect(launched).toHaveLength(1);
    expect(
      db
        .select()
        .from(sessionMessageQueue)
        .all()
        .map((row) => row.sessionId)
    ).not.toContain(other);
    expect(record.store.listForChat(other)[0]).toMatchObject({
      status: 'cancelled',
      endingDetail: { cancelledBecause: 'start_failed' },
    });
  });
});
