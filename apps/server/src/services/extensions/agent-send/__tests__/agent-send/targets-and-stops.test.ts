import {
  h,
  EXT,
  bootTurnPort,
  build,
  chat,
  gate,
  personTurn,
  quickTurn,
  runOfMessage,
  settle,
} from './harness.js';
import { describe, expect, it, vi } from 'vitest';
import { resetMessageDispatcher } from '../../../../session/message-dispatcher.js';
import { getRunRecord, uninstallRunRecord } from '../../../../runs/index.js';
import { RUN_LEASE_MS } from '../../../../runs/run-store.js';
import { EFFECT_LEASE_MS } from '../../../../runs/effects/worker.js';

/** A made-up agent's Mesh id and home. */
const AGENT = '01KJXYKJYW4N8QGQ5W4GB6YM9J';
const HOME = '/agents/reviewer';

describe('ctx.agent.send — capacity', () => {
  it('waits as queued with a reason while the machine is full, then runs when there is room', async () => {
    h.capFull = true;
    h.runtime.withScenarios([quickTurn()]);

    const receipt = await h.service.send(EXT, { to: h.session, text: 'soon', idempotencyKey: 'k' });

    expect(receipt).toEqual({
      messageId: expect.any(String),
      status: 'queued',
      reason: 'at_capacity',
      sessionId: h.session,
    });
    await settle();
    // Not refused, not held here: its run waits for room.
    expect(h.runtime.sendMessage).not.toHaveBeenCalled();
    expect(h.store.get(receipt.messageId)?.status).toBe('queued');
    expect(runOfMessage(receipt.messageId)).toMatchObject({
      status: 'queued',
      waitReason: 'machine_full',
    });
    expect(h.events).toEqual([]);

    h.capFull = false;
    await vi.waitFor(
      () => expect(h.events.map((e) => e.kind)).toEqual(['turn.started', 'turn.done']),
      {
        timeout: 3_000,
      }
    );
    expect(h.runtime.sendMessage).toHaveBeenCalledTimes(1);
    // The resend answers with where the message is now, and sends nothing.
    expect(await h.service.send(EXT, { to: h.session, text: 'soon', idempotencyKey: 'k' })).toEqual(
      { messageId: receipt.messageId, status: 'started', sessionId: h.session }
    );
    expect(h.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('holds a message whose new chat the extension’s own start limits refuse, then sends it', async () => {
    h.agents.set(AGENT, HOME);
    h.limitFull = true;
    h.runtime.withScenarios([quickTurn()]);

    const receipt = await h.service.send(EXT, { to: AGENT, text: 'soon', idempotencyKey: 'k' });

    expect(receipt).toMatchObject({ status: 'queued', reason: 'at_capacity', sessionId: null });
    expect(h.store.get(receipt.messageId)?.status).toBe('held');
    await h.service.drainHeld();
    expect(h.store.get(receipt.messageId)?.status).toBe('held');

    h.limitFull = false;
    await h.service.drainHeld();
    await settle();
    expect(h.events.map((e) => e.kind)).toEqual(['turn.started', 'turn.done']);
    h.projectors.push(h.reserved[0]!);
  });
});

it('fails a held message whose agent can no longer take it, never silently', async () => {
  h.agents.set(AGENT, HOME);
  h.limitFull = true;
  const receipt = await h.service.send(EXT, { to: AGENT, text: 'soon', idempotencyKey: 'k' });
  h.agents.delete(AGENT);

  h.limitFull = false;
  await h.service.drainHeld();

  expect(h.events).toEqual([
    expect.objectContaining({
      kind: 'turn.failed',
      messageId: receipt.messageId,
      reason: 'undeliverable',
    }),
  ]);
});

describe('ctx.agent.send — who it is for', () => {
  it('refuses a chat it may not write into, and an id nobody knows', async () => {
    h.sessions.set('room-chat', chat({ launchOrigin: 'room' }));
    h.sessions.set('bridged', chat({ launchOrigin: 'relay-binding' }));

    await expect(
      h.service.send(EXT, { to: 'room-chat', text: 'x', idempotencyKey: 'a' })
    ).rejects.toMatchObject({
      code: 'not_allowed',
    });
    await expect(
      h.service.send(EXT, { to: 'bridged', text: 'x', idempotencyKey: 'b' })
    ).rejects.toMatchObject({
      code: 'not_allowed',
    });
    await expect(
      h.service.send(EXT, { to: 'nobody', text: 'x', idempotencyKey: 'c' })
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(getRunRecord()!.port.list(h.session)).toEqual([]);
  });

  it('opens one chat with an agent, in its home, and keeps sending there', async () => {
    h.agents.set(AGENT, HOME);
    h.runtime.withScenarios([quickTurn(), quickTurn()]);

    const first = await h.service.send(EXT, { to: AGENT, text: 'one', idempotencyKey: 'a' });
    await settle();
    const second = await h.service.send(EXT, { to: AGENT, text: 'two', idempotencyKey: 'b' });
    await settle();

    expect(h.reserved).toHaveLength(1);
    expect(second.sessionId).toBe(first.sessionId);
    expect(h.dispatched[0]!.request).toMatchObject({ agentPath: HOME, cwd: HOME });
    expect(h.dispatched[0]!.request.seedContext).toContain('Flow Dashboard');
    expect(h.dispatched[1]!.request).not.toHaveProperty('seedContext');
    // Both ran as the agent, by its Mesh id on the run.
    expect(runOfMessage(first.messageId)?.agentId).toBe(AGENT);
    h.projectors.push(first.sessionId!);
  });

  it('refuses an older chat DorkOS cannot place (no launch origin)', async () => {
    // A chat bound before migration 0119 has no origin: it may as well be a
    // room's or a bridged chat, so it is not taken for a person's.
    h.sessions.set('legacy', chat({ launchOrigin: null }));

    await expect(
      h.service.send(EXT, { to: 'legacy', text: 'x', idempotencyKey: 'a' })
    ).rejects.toMatchObject({ code: 'not_allowed' });
    expect(h.dispatched).toEqual([]);
  });

  it('refuses a person’s chat a room has taken over', async () => {
    h.sessions.set('in-a-room', chat({ launchOrigin: 'interactive', roomBound: true }));

    await expect(
      h.service.send(EXT, { to: 'in-a-room', text: 'x', idempotencyKey: 'a' })
    ).rejects.toMatchObject({ code: 'not_allowed' });
  });

  it('writes only into its own extension chats, never another extension’s', async () => {
    h.sessions.set(
      'theirs-started',
      chat({ launchOrigin: 'extension-start', startedByExtension: 'other-app' })
    );
    h.sessions.set(
      'theirs-agent-chat',
      chat({ launchOrigin: 'agent-launch', startedByExtension: 'other-app' })
    );
    h.sessions.set(
      'mine-started',
      chat({ launchOrigin: 'extension-start', startedByExtension: EXT })
    );
    h.sessions.set('unowned-ext-chat', chat({ launchOrigin: 'extension-message' }));
    h.runtime.withScenarios([quickTurn()]);

    for (const to of ['theirs-started', 'theirs-agent-chat', 'unowned-ext-chat']) {
      await expect(
        h.service.send(EXT, { to, text: 'x', idempotencyKey: to })
      ).rejects.toMatchObject({
        code: 'not_allowed',
      });
    }
    await expect(
      h.service.send(EXT, { to: 'mine-started', text: 'x', idempotencyKey: 'mine' })
    ).resolves.toMatchObject({ status: 'queued', sessionId: 'mine-started' });
    await settle();
    h.projectors.push('mine-started');
  });

  it('reports ONE chat id for a message: the receipt’s, on every event', async () => {
    h.agents.set(AGENT, HOME);
    h.runtime.withScenarios([quickTurn()]);

    const receipt = await h.service.send(EXT, { to: AGENT, text: 'one', idempotencyKey: 'a' });
    await settle();

    expect(receipt.sessionId).toBe(h.reserved[0]);
    expect(h.events.map((e) => e.sessionId)).toEqual([receipt.sessionId, receipt.sessionId]);
    h.projectors.push(h.reserved[0]!);
  });
});

describe('ctx.agent.send — the extension stops', () => {
  it('fails a send its start limits would hold once its extension has stopped, instead of holding it', async () => {
    // An extension's last call can land after its stop; nothing it sent may go out then.
    h.agents.set(AGENT, HOME);
    h.limitFull = true;
    h.service.extensionStopped(EXT);
    const receipt = await h.service.send(EXT, { to: AGENT, text: 'soon', idempotencyKey: 'k' });
    h.limitFull = false;
    await h.service.drainHeld();
    await settle();

    expect(receipt).toMatchObject({ status: 'failed', failure: 'stopped' });
    expect(h.runtime.sendMessage).not.toHaveBeenCalled();
    expect(h.events).toEqual([
      expect.objectContaining({
        kind: 'turn.failed',
        messageId: receipt.messageId,
        reason: 'stopped',
      }),
    ]);
  });

  it('fails its held messages with `stopped`, and keeps them out of any chat', async () => {
    h.agents.set(AGENT, HOME);
    h.limitFull = true;
    h.runtime.withScenarios([quickTurn()]);
    const receipt = await h.service.send(EXT, { to: AGENT, text: 'soon', idempotencyKey: 'k' });
    const other = await h.service.send('other-app', {
      to: AGENT,
      text: 'soon',
      idempotencyKey: 'k',
    });

    h.service.extensionStopped(EXT);
    h.limitFull = false;
    await h.service.drainHeld();
    await settle();

    expect(h.events).toEqual([
      expect.objectContaining({
        kind: 'turn.failed',
        messageId: receipt.messageId,
        reason: 'stopped',
      }),
    ]);
    // Only the other extension's message was sent.
    expect(h.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.store.get(other.messageId)?.status).not.toBe('failed');
    h.projectors.push(...h.reserved);
  });

  it('takes its messages still waiting in a chat’s queue back too, and never runs them', async () => {
    const first = gate();
    await personTurn(first.wait);
    const receipt = await h.service.send(EXT, {
      to: h.session,
      text: 'later',
      idempotencyKey: 'q',
    });
    await settle();
    expect(h.queue.list(h.session).map((row) => row.id)).toEqual([receipt.messageId]);

    h.service.extensionStopped(EXT);
    first.open();
    await settle();

    expect(h.queue.list(h.session)).toEqual([]);
    expect(runOfMessage(receipt.messageId)?.status).toBe('cancelled');
    expect(h.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual([
      expect.objectContaining({
        kind: 'turn.failed',
        messageId: receipt.messageId,
        reason: 'stopped',
      }),
    ]);
  });

  it('leaves held messages alone when the whole server shuts down', async () => {
    h.agents.set(AGENT, HOME);
    h.limitFull = true;
    const receipt = await h.service.send(EXT, { to: AGENT, text: 'soon', idempotencyKey: 'k' });

    h.service.stop();
    h.service.extensionStopped(EXT);

    expect(h.store.get(receipt.messageId)?.status).toBe('held');
  });
});

describe('ctx.agent.send — across a restart', () => {
  it('a message queued in the chat runs on its own after a restart, with its mark; one with no row left reads interrupted', async () => {
    let clock = Date.now();
    uninstallRunRecord();
    bootTurnPort({ now: () => clock });
    h.service.stop();
    h.service = build();
    await h.service.start();
    h.service.subscribe(EXT, (event) => h.events.push(event));

    // A message queued behind the person's turn when the process dies.
    const first = gate();
    await personTurn(first.wait);
    const waiting = await h.service.send(EXT, {
      to: h.session,
      text: 'survive this',
      idempotencyKey: 'w',
    });
    await settle();
    expect(h.queue.list(h.session).map((row) => row.id)).toEqual([waiting.messageId]);

    // The process dies with both in flight: nothing shuts down, and the next
    // boot starts once every lease has run out.
    h.service.stop();
    resetMessageDispatcher();
    uninstallRunRecord();
    clock += Math.max(RUN_LEASE_MS, EFFECT_LEASE_MS) + 10_000;
    h.events = [];
    h.store.insert({
      id: 'm-running',
      extensionId: EXT,
      idempotencyKey: 'r',
      agentId: null,
      sessionId: h.session,
      cwd: null,
      status: 'started',
      receiptStatus: 'started',
      receiptReason: null,
      failureReason: null,
      content: null,
    });
    h.runtime.withScenarios([quickTurn(), quickTurn()]);
    h.runtime.sendMessage.mockClear();

    bootTurnPort({ epoch: '01BOOTEPOCHAGENTSEND000001', now: () => clock });
    h.service = build();
    await h.service.start();
    // Kept while nobody listened, delivered to the first listener.
    h.service.subscribe(EXT, (event) => h.events.push(event));
    await settle();
    // Its row is still in the queue: never handed over twice.
    expect(h.queue.list(h.session).map((row) => row.id)).toEqual([waiting.messageId]);
    expect(h.dispatched.filter((opts) => opts.runId === waiting.messageId)).toHaveLength(1);

    // Re-armed at start: the idle chat runs it on its own.
    await vi.waitFor(() => expect(h.events).toHaveLength(3), { timeout: 3_000 });
    expect(h.events).toEqual([
      expect.objectContaining({
        kind: 'turn.failed',
        messageId: 'm-running',
        reason: 'interrupted',
      }),
      { kind: 'turn.started', messageId: waiting.messageId, sessionId: h.session },
      { kind: 'turn.done', messageId: waiting.messageId, sessionId: h.session, outcome: 'ok' },
    ]);
    // The row the restart left carries the outsider mark too, read from who
    // queued it (DOR-4594).
    const adopted = h.runtime.sendMessage.mock.calls.find((call) =>
      String(call[1]).includes('survive this')
    );
    expect(adopted?.[2]).toMatchObject({ carriedMarks: { outsider: true } });
    first.open();
  });
});

describe('ctx.agent.send — opening and upgrading (DOR-5232)', () => {
  it('opens ONE chat for two first messages sent close together, before either is handed over', async () => {
    h.agents.set(AGENT, HOME);
    h.runtime.withScenarios([quickTurn(), quickTurn()]);
    // No settle between them: the first chat is not bound yet.
    const first = await h.service.send(EXT, { to: AGENT, text: 'one', idempotencyKey: 'a' });
    const second = await h.service.send(EXT, { to: AGENT, text: 'two', idempotencyKey: 'b' });
    expect(second.sessionId).toBe(first.sessionId);
    expect(h.reserved).toHaveLength(1);
    await settle();
    expect(h.events.filter((e) => e.kind === 'turn.done')).toHaveLength(2);
    h.projectors.push(first.sessionId!);
  });

  it('sends a held message an earlier version saved under a UUID, on a run id of its own', async () => {
    h.agents.set(AGENT, HOME);
    h.store.insert({
      id: '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c',
      extensionId: EXT,
      idempotencyKey: 'old',
      agentId: AGENT,
      sessionId: null,
      cwd: null,
      status: 'held',
      receiptStatus: 'queued',
      receiptReason: 'at_capacity',
      failureReason: null,
      content: 'from before the upgrade',
    });
    h.runtime.withScenarios([quickTurn()]);
    await h.service.drainHeld();
    await settle();
    expect(h.events.map((e) => [e.kind, e.messageId])).toEqual([
      ['turn.started', '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c'],
      ['turn.done', '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c'],
    ]);
    h.projectors.push(...h.reserved);
  });

  it('leaves a message an earlier version queued in the chat to the queue, and hears it run', async () => {
    h.service.stop();
    h.events = [];
    // Queued by the version before: a row in the chat's queue, no run.
    const id = '6a7b8c9d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
    h.queue.enqueue({
      id,
      sessionId: h.session,
      content: 'queued before the upgrade',
      clientId: `extension:${EXT}`,
      disposition: 'queue',
      context: null,
    });
    h.store.insert({
      id,
      extensionId: EXT,
      idempotencyKey: 'old-q',
      agentId: null,
      sessionId: h.session,
      cwd: null,
      status: 'queued',
      receiptStatus: 'queued',
      receiptReason: 'busy',
      failureReason: null,
      content: null,
    });
    h.runtime.withScenarios([quickTurn()]);
    h.service = build();
    await h.service.start();
    h.service.subscribe(EXT, (event) => h.events.push(event));
    await vi.waitFor(() => expect(h.events).toHaveLength(2), { timeout: 3_000 });
    // Run once, heard by its own id: never called interrupted, so never resent.
    expect(h.events.map((e) => [e.kind, e.messageId])).toEqual([
      ['turn.started', id],
      ['turn.done', id],
    ]);
    expect(h.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });
});
