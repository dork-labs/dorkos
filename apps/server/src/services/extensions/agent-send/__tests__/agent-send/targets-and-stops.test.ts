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
    // The resend still answers with the first receipt.
    expect(await h.service.send(EXT, { to: h.session, text: 'soon', idempotencyKey: 'k' })).toEqual(
      receipt
    );
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
  it('a message still waiting runs after a restart; one an earlier build left can only be called interrupted', async () => {
    let clock = Date.now();
    uninstallRunRecord();
    bootTurnPort({ now: () => clock });
    h.service.stop();
    h.service = build();
    await h.service.start();
    h.service.subscribe(EXT, (event) => h.events.push(event));

    // A message waiting behind the person's turn when the process dies.
    const first = gate();
    await personTurn(first.wait);
    const waiting = await h.service.send(EXT, {
      to: h.session,
      text: 'survive this',
      idempotencyKey: 'w',
    });
    await settle();
    expect(runOfMessage(waiting.messageId)?.waitReason).toBe('chat_busy');

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
    h.runtime.withScenarios([quickTurn()]);

    bootTurnPort({ epoch: '01BOOTEPOCHAGENTSEND000001', now: () => clock });
    h.service = build();
    await h.service.start();
    // Kept while nobody listened, delivered to the first listener.
    h.service.subscribe(EXT, (event) => h.events.push(event));
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
    expect(h.runtime.sendMessage.mock.calls.map((call) => call[1])).toContainEqual(
      expect.stringContaining('survive this')
    );
    first.open();
  });
});
