import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmPersonPaint, heldProtocolCall, leaseFixture } from './page-leases-fixture.js';
import type { BrowserPersonInputLease } from '../leases/broker-contract.js';

const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function setup() {
  const f = await leaseFixture();
  fixtures.push(f);
  await f.open('chat-a');
  const broker = f.service.pageBroker;
  const viewer = await broker.captureViewerLease('chat-a', {
    ownerId: 'owner',
    appSessionId: 'app',
    clientInstanceId: 'client',
    viewerId: 'viewer',
  });
  return { ...f, broker, viewer, page: f.contexts[0].pages[0] };
}

describe('held person input', () => {
  it('retains drag buttons during movement and releases them on navigation', async () => {
    const f = await setup();
    const lease = await f.broker.takePersonControl(f.viewer);
    confirmPersonPaint(lease, f.viewer);
    await lease.runPerson({
      kind: 'pointer',
      type: 'mousePressed',
      x: 2,
      y: 3,
      button: 'left',
      clickCount: 1,
    });
    await lease.runPerson({
      kind: 'pointer',
      type: 'mouseMoved',
      x: 12,
      y: 13,
      button: 'none',
      clickCount: 0,
    });
    const protocol = f.protocolSessions.at(-1)!;
    expect(protocol.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mouseMoved', buttons: 1, x: 12, y: 13 })
    );
    f.page.navigate('https://next.example.test/');
    await vi.waitFor(() => expect(protocol.detach).toHaveBeenCalled());
    expect(protocol.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mouseReleased', buttons: 0, x: 12, y: 13 })
    );
    await expect(f.observe('chat-a')).rejects.toBeDefined();
  });
  it('keeps timed-out upload capacity and bytes until physical consumption settles', async () => {
    const f = await setup();
    await f.open('chat-b');
    await f.open('chat-c');
    const controls: { lease: BrowserPersonInputLease; ticket: { id: string }; bytes: Buffer }[] =
      [];
    const gates = [heldProtocolCall(), heldProtocolCall()];
    for (const [index, chat] of ['chat-a', 'chat-b', 'chat-c'].entries()) {
      const viewer =
        chat === 'chat-a'
          ? f.viewer
          : await f.broker.captureViewerLease(chat, { ...f.viewer.identity, viewerId: chat });
      const lease = await f.broker.takePersonControl(viewer);
      confirmPersonPaint(lease, viewer);
      const notify = vi.fn();
      lease.onFileChooser(notify);
      await lease.runPerson({ kind: 'text', text: 'fixture' });
      f.contexts[0].pages[index].events.emit('filechooser', {
        isMultiple: () => false,
        setFiles: vi.fn(async (files: unknown[]) => {
          if (files.length && gates[index]) await gates[index].run();
        }),
      });
      controls.push({ lease, ticket: notify.mock.calls[0][0], bytes: Buffer.from('PAYLOAD') });
    }
    vi.useFakeTimers();
    const uploads = controls.slice(0, 2).map(({ lease, ticket, bytes }) =>
      lease
        .chooseFiles(ticket.id, [{ name: 'fixture.txt', mimeType: 'text/plain', buffer: bytes }])
        .then(
          () => 'completed',
          () => 'uncertain'
        )
    );
    try {
      await Promise.all(gates.map((gate) => gate.started));
      await vi.advanceTimersByTimeAsync(3_001);
      expect(await Promise.all(uploads)).toEqual(['uncertain', 'uncertain']);
      expect(controls[0].bytes.toString()).toBe('PAYLOAD');
      const third = controls[2];
      await expect(
        third.lease.chooseFiles(third.ticket.id, [
          { name: 'fixture.txt', mimeType: 'text/plain', buffer: third.bytes },
        ])
      ).rejects.toMatchObject({ code: 'busy' });
      expect(third.bytes.every((byte) => byte === 0)).toBe(true);
    } finally {
      for (const gate of gates) gate.release();
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(controls[0].bytes.every((byte) => byte === 0)).toBe(true));
    const third = controls[2];
    await third.lease.chooseFiles(third.ticket.id, [
      { name: 'fresh.txt', mimeType: 'text/plain', buffer: Buffer.from('fresh') },
    ]);
  });

  it('failed chooser cancellation keeps hand-back closed', async () => {
    const f = await setup();
    const lease = await f.broker.takePersonControl(f.viewer);
    confirmPersonPaint(lease, f.viewer);
    lease.onFileChooser(vi.fn());
    await lease.runPerson({
      kind: 'key',
      type: 'keyDown',
      key: 'Shift',
      code: 'ShiftLeft',
      modifiers: 8,
    });
    await lease.runPerson({
      kind: 'pointer',
      type: 'mousePressed',
      x: 2,
      y: 3,
      button: 'left',
      clickCount: 1,
    });
    await lease.runPerson({ kind: 'touch', type: 'touchStart', points: [{ x: 2, y: 3, id: 1 }] });
    await lease.runPerson({ kind: 'composition', text: '仮', selectionStart: 1, selectionEnd: 1 });
    const protocol = f.protocolSessions.at(-1)!;
    await lease.runPerson({ kind: 'text', text: 'fixture' });
    f.page.events.emit('filechooser', {
      isMultiple: () => false,
      setFiles: vi.fn(async () => {
        throw Error('protocol refused');
      }),
    });
    await expect(f.broker.handBack(lease)).rejects.toBeDefined();
    expect(protocol.send).toHaveBeenCalledWith('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Shift',
      code: 'ShiftLeft',
      modifiers: 0,
    });
    expect(protocol.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mouseReleased', buttons: 0 })
    );
    expect(protocol.send).toHaveBeenCalledWith('Input.dispatchTouchEvent', {
      type: 'touchCancel',
      touchPoints: [],
    });
    expect(protocol.send).toHaveBeenCalledWith('Input.imeSetComposition', {
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
    });
    expect(protocol.detach).toHaveBeenCalledOnce();
    await expect(f.observe('chat-a')).rejects.toBeDefined();
    expect(f.page.events.listenerCount('filechooser')).toBe(0);
  });
  it('settles chooser cancellation when its captured page closes during cancellation', async () => {
    const f = await setup();
    const lease = await f.broker.takePersonControl(f.viewer);
    confirmPersonPaint(lease, f.viewer);
    const notify = vi.fn();
    lease.onFileChooser(notify);
    await lease.runPerson({ kind: 'text', text: 'fixture' });
    f.page.events.emit('filechooser', {
      isMultiple: () => false,
      setFiles: vi.fn(async () => {
        await f.page.page.close();
        throw Error('Target page has been closed');
      }),
    });
    await expect(lease.cancelFileChooser(notify.mock.calls[0][0].id)).resolves.toBeUndefined();
    expect(lease.isCurrent()).toBe(false);
    await expect(f.observe('chat-a')).rejects.toBeDefined();
  });
  it('keeps protected sign-in pages refused after hand-back in clean and marked chats', async () => {
    const f = await setup();
    f.service.handover.useOutsideTurnCheck(async (id) =>
      id === 'chat-a' ? 'read_outside_text' : null
    );
    await f.open('chat-b');
    for (const [index, chat] of ['chat-a', 'chat-b'].entries()) {
      const viewer =
        chat === 'chat-a'
          ? f.viewer
          : await f.broker.captureViewerLease(chat, { ...f.viewer.identity, viewerId: chat });
      const lease = await f.broker.takePersonControl(viewer);
      confirmPersonPaint(lease, viewer);
      await lease.runPerson({ kind: 'text', text: 'PERSON_ONLY_CANARY' });
      await expect(f.observe(chat)).rejects.toBeDefined();
      await expect(f.screenshot(chat)).rejects.toBeDefined();
      await f.broker.handBack(lease);
      await expect(lease.readSelection()).rejects.toBeDefined();
      f.contexts[0].pages[index].navigate('http://localhost:4242/sign-in');
      await expect(f.observe(chat)).rejects.toBeDefined();
      await expect(f.screenshot(chat)).rejects.toBeDefined();
    }
    await expect(f.ask('chat-a')).rejects.toMatchObject({ payload: { code: 'outside_turn' } });
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain('PERSON_ONLY_CANARY');
  });
  it('old-controller cleanup cannot release a replacement controller', async () => {
    const f = await setup();
    const first = await f.broker.takePersonControl(f.viewer);
    confirmPersonPaint(first, f.viewer);
    await first.runPerson({
      kind: 'key',
      type: 'keyDown',
      key: 'Shift',
      code: 'ShiftLeft',
      modifiers: 8,
    });
    await first.runPerson({ kind: 'touch', type: 'touchStart', points: [{ x: 2, y: 3, id: 1 }] });
    await first.runPerson({ kind: 'composition', text: '仮', selectionStart: 1, selectionEnd: 1 });
    const oldProtocol = f.protocolSessions.at(-1)!;
    await f.broker.abandon(first);
    expect(oldProtocol.send).toHaveBeenCalledWith('Input.dispatchTouchEvent', {
      type: 'touchCancel',
      touchPoints: [],
    });
    expect(oldProtocol.send).toHaveBeenCalledWith('Input.imeSetComposition', {
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
    });
    const nextViewer = await f.broker.captureViewerLease('chat-a', {
      ...f.viewer.identity,
      viewerId: 'next-viewer',
    });
    const second = await f.broker.takePersonControl(nextViewer);
    confirmPersonPaint(second, nextViewer);
    await second.runPerson({ kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 0 });
    const nextProtocol = f.protocolSessions.at(-1)!;
    nextProtocol.send.mockClear();
    await f.viewer.close();
    await expect(f.broker.handBack(first)).rejects.toBeDefined();
    expect(second.isCurrent()).toBe(true);
    expect(nextProtocol.send).not.toHaveBeenCalled();
    await f.broker.handBack(second);
    expect(nextProtocol.send).toHaveBeenCalledWith('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      modifiers: 0,
    });
  });

  it('drops a pending selection after custody is revoked and drains its physical read', async () => {
    const f = await setup();
    const lease = await f.broker.takePersonControl(f.viewer);
    confirmPersonPaint(lease, f.viewer);
    await lease.runPerson({ kind: 'composition', text: '', selectionStart: 0, selectionEnd: 0 });
    const protocol = f.protocolSessions.at(-1)!;
    const gate = heldProtocolCall();
    const original = protocol.send.getMockImplementation()!;
    protocol.send.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        await gate.run();
        return { result: { value: { text: 'PRIVATE_SELECTION', password: false } } };
      }
      return (original as (method: string) => Promise<unknown>)(method);
    });
    const reading = lease.readSelection().then(
      () => 'published',
      () => 'refused'
    );
    await gate.started;
    let released = false;
    const handBack = f.broker.handBack(lease).then(() => {
      released = true;
    });
    await Promise.resolve();
    expect(released).toBe(false);
    gate.release();
    expect(await reading).toBe('refused');
    await handBack;
  });

  it('cancels an expired input activation immediately and removes interception on revoke', async () => {
    const f = await setup();
    const lease = await f.broker.takePersonControl(f.viewer);
    confirmPersonPaint(lease, f.viewer);
    lease.onFileChooser(vi.fn());
    vi.useFakeTimers();
    await lease.runPerson({ kind: 'text', text: 'fixture' });
    await vi.advanceTimersByTimeAsync(1_001);
    const setFiles = vi.fn(async () => undefined);
    f.page.events.emit('filechooser', { isMultiple: () => false, setFiles });
    expect(setFiles).toHaveBeenCalledWith([]);
    await f.service.findSession('chat-a')!.revoke();
    expect(f.page.events.listenerCount('filechooser')).toBe(0);
    expect(lease.isCurrent()).toBe(false);
  });
  it('reads selection in an isolated world and never fills agent observations', async () => {
    const f = await setup();
    const lease = await f.broker.takePersonControl(f.viewer);
    confirmPersonPaint(lease, f.viewer);
    const count = f.protocolSessions.length;
    const protocol = f.protocolSessions.at(-1)!;
    protocol.send.mockImplementation(async (method: string) => {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 73 };
      return { result: { value: { text: 'PERSON_SELECTION', password: false } } };
    });
    protocol.send.mockClear();
    expect(await lease.readSelection()).toBe('PERSON_SELECTION');
    expect(f.protocolSessions).toHaveLength(count);
    expect(protocol.send.mock.calls).toContainEqual([
      'Runtime.evaluate',
      expect.objectContaining({ contextId: 73, returnByValue: true }),
    ]);
    expect(protocol.send.mock.calls.find(([method]) => method === 'Runtime.evaluate')?.[1]).toEqual(
      expect.objectContaining({ expression: expect.stringContaining('65536') })
    );
    await expect(f.observe('chat-a')).rejects.toBeDefined();
    await f.broker.handBack(lease);
    await expect(lease.readSelection()).rejects.toBeDefined();
  });

  it('intercepts only while person-held and immediately cancels unactivated choosers', async () => {
    const f = await setup();
    expect(f.page.events.listenerCount('filechooser')).toBe(0);
    const lease = await f.broker.takePersonControl(f.viewer);
    confirmPersonPaint(lease, f.viewer);
    const notify = vi.fn();
    lease.onFileChooser(notify);
    expect(f.page.events.listenerCount('filechooser')).toBe(1);
    const setFiles = vi.fn(async () => undefined);
    f.page.events.emit('filechooser', { isMultiple: () => false, setFiles });
    await vi.waitFor(() => expect(setFiles).toHaveBeenCalledWith([]));
    expect(notify).not.toHaveBeenCalled();
    await f.broker.handBack(lease);
    expect(f.page.events.listenerCount('filechooser')).toBe(0);
  });

  it('consumes fresh files as memory payloads once and drops stale chooser events', async () => {
    const f = await setup();
    const lease = await f.broker.takePersonControl(f.viewer);
    confirmPersonPaint(lease, f.viewer);
    const notify = vi.fn();
    lease.onFileChooser(notify);
    await lease.runPerson({ kind: 'text', text: 'fixture' });
    const setFiles = vi.fn(async () => undefined);
    f.page.events.emit('filechooser', { isMultiple: () => false, setFiles });
    const ticket = notify.mock.calls[0][0];
    const bytes = Buffer.from('FILE_CANARY');
    await lease.chooseFiles(ticket.id, [
      { name: 'fixture.txt', mimeType: 'text/plain', buffer: bytes },
    ]);
    expect(setFiles).toHaveBeenCalledExactlyOnceWith([
      { name: 'fixture.txt', mimeType: 'text/plain', buffer: expect.any(Buffer) },
    ]);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    await expect(lease.chooseFiles(ticket.id, [])).rejects.toBeDefined();
    const lateCallback = f.page.events.listeners('filechooser')[0];
    f.page.navigate('https://next.example.test/');
    expect(lease.isCurrent()).toBe(false);
    const late = vi.fn(async () => undefined);
    lateCallback({ isMultiple: () => true, setFiles: late });
    await vi.waitFor(() => expect(late).toHaveBeenCalledWith([]));
    await f.broker.abandon(lease).catch(() => undefined);
  });
});
