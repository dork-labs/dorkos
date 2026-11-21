import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmPersonPaint, heldProtocolCall, leaseFixture } from './page-leases-fixture.js';
import { PERSON_SAFETY_EXPRESSION } from '../leases/viewer-control/person-safety.js';

const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function setup() {
  const f = await leaseFixture();
  fixtures.push(f);
  await f.open('chat-a');
  const page = f.contexts[0].pages[0];
  page.navigate('https://example.com');
  const broker = f.service.pageBroker;
  const viewer = await broker.captureViewerLease('chat-a', {
    ownerId: 'owner',
    appSessionId: 'app',
    clientInstanceId: 'client',
    viewerId: 'view',
  });
  const lease = await broker.takePersonControl(viewer);
  confirmPersonPaint(lease, viewer);
  return {
    ...f,
    page,
    broker,
    viewer,
    lease,
    protocol: f.protocolSessions.at(-1)!,
    baseline: f.protocolSessions.length,
  };
}
describe('held generation races', () => {
  it('releases protocol keys, buttons, touch and composition before renewing same-site control', async () => {
    const f = await setup();
    await f.lease.runPerson({
      kind: 'key',
      type: 'keyDown',
      key: 'Shift',
      code: 'ShiftLeft',
      modifiers: 8,
    });
    await f.lease.runPerson({
      kind: 'pointer',
      type: 'mousePressed',
      x: 2,
      y: 3,
      button: 'left',
      clickCount: 1,
    });
    await f.lease.runPerson({ kind: 'touch', type: 'touchStart', points: [{ x: 2, y: 3, id: 1 }] });
    await f.lease.runPerson({
      kind: 'composition',
      text: '仮',
      selectionStart: 1,
      selectionEnd: 1,
    });
    f.page.navigate('https://example.com/next');
    await vi.waitFor(() => confirmPersonPaint(f.lease, f.viewer));
    expect(f.protocol.send).toHaveBeenCalledWith('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Shift',
      code: 'ShiftLeft',
      modifiers: 0,
    });
    expect(f.protocol.send).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mouseReleased', buttons: 0 })
    );
    expect(f.protocol.send).toHaveBeenCalledWith('Input.dispatchTouchEvent', {
      type: 'touchCancel',
      touchPoints: [],
    });
    expect(f.protocol.send).toHaveBeenCalledWith('Input.imeSetComposition', {
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
    });
    expect(f.protocol.detach).toHaveBeenCalledOnce();
    expect(f.lease.isCurrent()).toBe(true);
  });
  it('drops input queued behind authorization when the page commits', async () => {
    const f = await setup();
    const gate = heldProtocolCall();
    f.service.useProfileAccess(gate.run, () => true);
    const input = f.lease.runPerson({ kind: 'text', text: 'OLD_INPUT' }).catch(() => 'dropped');
    await gate.started;
    f.page.navigate('https://example.com/next');
    gate.release();
    expect(await input).toBe('dropped');
    await vi.waitFor(() => confirmPersonPaint(f.lease, f.viewer));
    expect(f.page.page.keyboard.insertText).not.toHaveBeenCalled();
    await expect(f.observe('chat-a')).rejects.toBeDefined();
  });
  it('captures takeover generation before its first authorization await', async () => {
    const f = await setup();
    await f.broker.abandon(f.lease);
    const gate = heldProtocolCall();
    f.service.useProfileAccess(gate.run, () => true);
    const taking = f.broker.takePersonControl(f.viewer).catch(() => 'dropped');
    await gate.started;
    f.page.navigate('https://example.com/next');
    gate.release();
    expect(await taking).toBe('dropped');
    expect(f.protocolSessions).toHaveLength(f.baseline);
  });
  it('drains a physical input but never accepts its response after a same-site commit', async () => {
    const f = await setup();
    const gate = heldProtocolCall();
    f.page.wheel.mockImplementationOnce(gate.run);
    const input = f.lease.runPerson({ kind: 'wheel', deltaX: 0, deltaY: 4 }).catch(() => 'dropped');
    await gate.started;
    f.page.navigate('https://example.com/next');
    expect(f.lease.inputReady()).toBe(false);
    expect(f.protocolSessions).toHaveLength(f.baseline);
    gate.release();
    expect(await input).toBe('dropped');
    await vi.waitFor(() => confirmPersonPaint(f.lease, f.viewer));
    expect(f.page.wheel).toHaveBeenCalledOnce();
  });
  it('drops an old selection response and cannot publish it into the renewed generation', async () => {
    const f = await setup();
    const protocol = f.protocol;
    const send = protocol.send.getMockImplementation()!;
    const gate = heldProtocolCall();
    protocol.send.mockImplementation(async (method: string, params) => {
      if (method === 'Runtime.evaluate' && params?.expression !== PERSON_SAFETY_EXPRESSION) {
        await gate.run();
        return { result: { value: { text: 'OLD_SELECTION', password: false } } };
      }
      return (send as (method: string, params?: unknown) => Promise<unknown>)(method, params);
    });
    const reading = f.lease.readSelection().catch(() => 'dropped');
    await gate.started;
    f.page.navigate('https://example.com/next');
    gate.release();
    expect(await reading).toBe('dropped');
    await vi.waitFor(() => confirmPersonPaint(f.lease, f.viewer));
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain('OLD_SELECTION');
  });
  it('cancels chooser tickets and their activation window on every navigation', async () => {
    const f = await setup();
    const notify = vi.fn();
    f.lease.onFileChooser(notify);
    await f.lease.runPerson({ kind: 'text', text: 'activate' });
    const setFiles = vi.fn(async () => undefined);
    f.page.events.emit('filechooser', { isMultiple: () => false, setFiles });
    const ticket = notify.mock.calls[0][0];
    f.page.navigate('https://example.com/next');
    await vi.waitFor(() => confirmPersonPaint(f.lease, f.viewer));
    expect(setFiles).toHaveBeenCalledExactlyOnceWith([]);
    const bytes = Buffer.from('OLD_FILE');
    await expect(
      f.lease.chooseFiles(ticket.id, [{ name: 'old.txt', mimeType: 'text/plain', buffer: bytes }])
    ).rejects.toBeDefined();
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    const late = vi.fn(async () => undefined);
    f.page.events.emit('filechooser', { isMultiple: () => false, setFiles: late });
    await vi.waitFor(() => expect(late).toHaveBeenCalledWith([]));
    expect(notify).toHaveBeenCalledOnce();
  });
  it('a live chooser cancellation failure releases held input but keeps all control closed', async () => {
    const f = await setup();
    f.lease.onFileChooser(vi.fn());
    await f.lease.runPerson({ kind: 'keyDown', key: 'Shift' });
    f.page.events.emit('filechooser', {
      isMultiple: () => false,
      setFiles: vi.fn(async () => {
        throw Error('removed input');
      }),
    });
    f.page.navigate('https://example.com/next');
    await vi.waitFor(() => expect(f.lease.isCurrent()).toBe(false));
    expect(f.page.page.keyboard.up).toHaveBeenCalledWith('Shift');
    await expect(f.observe('chat-a')).rejects.toBeDefined();
    await expect(f.broker.takePersonControl(f.viewer)).rejects.toMatchObject({
      code: 'file_picker_stuck',
      message: 'The file picker got stuck. Close this page in Chrome to hand back.',
    });
  });
  it('keeps input disabled after the one-second safety deadline and drains the late read', async () => {
    const f = await setup();
    const gate = heldProtocolCall();
    const attach = vi.mocked(f.contexts[0].context.newCDPSession);
    const original = attach.getMockImplementation()!;
    attach.mockImplementationOnce(async (...args) => {
      const protocol = await original(...args);
      const send = protocol.send.bind(protocol);
      protocol.send = vi.fn(async (method, params) => {
        if (method === 'Runtime.evaluate') await gate.run();
        return send(method, params);
      }) as typeof protocol.send;
      return protocol;
    });
    vi.useFakeTimers();
    f.page.navigate('https://example.com/next');
    await gate.started;
    const pending = f.protocolSessions.at(-1)!;
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.lease.isCurrent()).toBe(false);
    expect(f.lease.inputReady()).toBe(false);
    expect(pending.detach).not.toHaveBeenCalled();
    await expect(f.observe('chat-a')).rejects.toBeDefined();
    gate.release();
    vi.useRealTimers();
    await vi.waitFor(() => expect(pending.detach).toHaveBeenCalled());
    expect(f.lease.isCurrent()).toBe(false);
    expect(
      pending.send.mock.calls.filter(([method]) => method === 'Runtime.evaluate')
    ).toHaveLength(1);
  });
  it('a late safety read after a cross-site commit cannot restore control', async () => {
    const f = await setup();
    const gate = heldProtocolCall();
    const attach = vi.mocked(f.contexts[0].context.newCDPSession);
    const original = attach.getMockImplementation()!;
    attach.mockImplementationOnce(async (...args) => {
      const protocol = await original(...args);
      const send = protocol.send.bind(protocol);
      protocol.send = vi.fn(async (method, params) => {
        if (method === 'Runtime.evaluate') await gate.run();
        return (send as (method: string, params?: unknown) => Promise<unknown>)(method, params);
      }) as typeof protocol.send;
      return protocol;
    });
    f.page.navigate('https://example.com/next');
    await gate.started;
    const pendingProtocol = f.protocolSessions.at(-1)!;
    f.page.navigate('https://other.com');
    f.page.navigate('https://example.com/back');
    expect(f.lease.isCurrent()).toBe(false);
    gate.release();
    await vi.waitFor(() => expect(pendingProtocol.detach).toHaveBeenCalled());
    expect(f.lease.inputReady()).toBe(false);
    await expect(f.observe('chat-a')).rejects.toBeDefined();
  });
});
