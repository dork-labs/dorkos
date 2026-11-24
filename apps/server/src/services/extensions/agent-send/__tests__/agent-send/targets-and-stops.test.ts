import { h, EXT, dispatchHooks, gate, quickTurn, settle, chat, build } from './harness.js';
import { describe, expect, it, vi } from 'vitest';

describe('ctx.agent.send — capacity', () => {
  it('holds the message as queued with a reason, then sends it when there is room', async () => {
    h.capFull = true;
    h.runtime.withScenarios([quickTurn()]);

    const receipt = await h.service.send(EXT, { to: h.session, text: 'soon', idempotencyKey: 'k' });

    expect(receipt).toEqual({
      messageId: expect.any(String),
      status: 'queued',
      reason: 'at_capacity',
      sessionId: h.session,
    });
    expect(h.runtime.sendMessage).not.toHaveBeenCalled();
    expect(h.store.get(receipt.messageId)?.status).toBe('held');
    // Still full: still held, nothing failed.
    await h.service.drainHeld();
    expect(h.store.get(receipt.messageId)?.status).toBe('held');
    expect(h.events).toEqual([]);

    h.capFull = false;
    await h.service.drainHeld();
    await settle();

    expect(h.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.runtime.sendMessage).toHaveBeenCalledWith(
      h.session,
      expect.any(String),
      expect.objectContaining({ messageId: receipt.messageId })
    );
    expect(h.events.map((e) => e.kind)).toEqual(['turn.started', 'turn.done']);
    // The resend still answers with the first receipt.
    expect(await h.service.send(EXT, { to: h.session, text: 'soon', idempotencyKey: 'k' })).toEqual(
      receipt
    );
  });
});

it('fails a held message whose chat stopped taking messages, never silently', async () => {
  h.capFull = true;
  const receipt = await h.service.send(EXT, { to: h.session, text: 'soon', idempotencyKey: 'k' });
  h.sessions.set(h.session, chat({ launchOrigin: 'room' }));

  h.capFull = false;
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
    expect(h.dispatched).toEqual([]);
  });

  it('opens one chat with an agent, in its home, and keeps sending there', async () => {
    h.agents.set('01AGENT', '/agents/reviewer');
    h.runtime.withScenarios([quickTurn(), quickTurn()]);

    const first = await h.service.send(EXT, { to: '01AGENT', text: 'one', idempotencyKey: 'a' });
    await settle();
    const second = await h.service.send(EXT, { to: '01AGENT', text: 'two', idempotencyKey: 'b' });
    await settle();

    expect(h.reserved).toHaveLength(1);
    expect(second.sessionId).toBe(first.sessionId);
    expect(h.dispatched[0]!.request).toMatchObject({ agentPath: '/agents/reviewer' });
    expect(h.dispatched[0]!.request.seedContext).toContain('Flow Dashboard');
    expect(h.dispatched[1]!.request).not.toHaveProperty('seedContext');
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
    ).resolves.toMatchObject({ status: 'started' });
    h.projectors.push('mine-started');
  });

  it('reports ONE chat id for a new chat, even when the runtime settles on another', async () => {
    h.agents.set('01AGENT', '/agents/reviewer');
    dispatchHooks.canonicalFor = () => 'canonical-chat';
    h.runtime.withScenarios([quickTurn()]);

    const receipt = await h.service.send(EXT, { to: '01AGENT', text: 'one', idempotencyKey: 'a' });
    await settle();

    expect(receipt.sessionId).toBe('canonical-chat');
    expect(h.events.map((e) => e.sessionId)).toEqual(['canonical-chat', 'canonical-chat']);
    h.projectors.push(h.reserved[0]!);
  });
});

describe('ctx.agent.send — the extension stops', () => {
  it('fails a held message whose retry was mid-flight when the extension stopped', async () => {
    h.capFull = true;
    const receipt = await h.service.send(EXT, { to: h.session, text: 'soon', idempotencyKey: 'k' });
    const hold = gate();
    dispatchHooks.dispatchGate = hold.wait;
    const draining = h.service.drainHeld();
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(2));

    // The row reads `queued` mid-retry, so the stop cannot see it as held.
    h.service.extensionStopped(EXT);
    hold.open();
    await draining;
    dispatchHooks.dispatchGate = undefined;
    h.capFull = false;
    await h.service.drainHeld();
    await settle();

    expect(h.runtime.sendMessage).not.toHaveBeenCalled();
    expect(h.events).toEqual([
      expect.objectContaining({
        kind: 'turn.failed',
        messageId: receipt.messageId,
        reason: 'stopped',
      }),
    ]);
  });

  it('fails a first send still in flight when the extension stopped, instead of holding it', async () => {
    h.capFull = true;
    const hold = gate();
    dispatchHooks.dispatchGate = hold.wait;
    const sending = h.service.send(EXT, { to: h.session, text: 'soon', idempotencyKey: 'k' });
    await vi.waitFor(() => expect(h.dispatched).toHaveLength(1));

    h.service.extensionStopped(EXT);
    hold.open();
    const receipt = await sending;
    dispatchHooks.dispatchGate = undefined;
    h.capFull = false;
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
    h.capFull = true;
    const receipt = await h.service.send(EXT, { to: h.session, text: 'soon', idempotencyKey: 'k' });
    const other = await h.service.send('other-app', {
      to: h.session,
      text: 'soon',
      idempotencyKey: 'k',
    });

    h.service.extensionStopped(EXT);
    h.capFull = false;
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
  });

  it('leaves held messages alone when the whole server shuts down', async () => {
    h.capFull = true;
    const receipt = await h.service.send(EXT, { to: h.session, text: 'soon', idempotencyKey: 'k' });

    h.service.stop();
    h.service.extensionStopped(EXT);

    expect(h.store.get(receipt.messageId)?.status).toBe('held');
  });
});

describe('ctx.agent.send — across a restart', () => {
  it('reports a message that was running as interrupted, and re-arms one still queued', async () => {
    h.service.stop();
    h.events = [];
    const running = h.store.insert({
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
    h.queue.enqueue({
      id: 'm-waiting',
      sessionId: h.session,
      content: 'waiting',
      clientId: `extension:${EXT}`,
      disposition: 'queue',
      context: null,
    });
    h.store.insert({
      id: 'm-waiting',
      extensionId: EXT,
      idempotencyKey: 'w',
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
    await settle();
    // Kept while nobody listened, delivered to the first listener.
    h.service.subscribe(EXT, (event) => h.events.push(event));

    expect(h.events).toEqual([
      expect.objectContaining({
        kind: 'turn.failed',
        messageId: running.id,
        reason: 'interrupted',
      }),
      { kind: 'turn.started', messageId: 'm-waiting', sessionId: h.session },
      { kind: 'turn.done', messageId: 'm-waiting', sessionId: h.session, outcome: 'ok' },
    ]);
  });
});
