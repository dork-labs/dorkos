import { afterEach, describe, expect, it, vi } from 'vitest';
import { confirmPersonPaint, heldProtocolCall, leaseFixture } from './page-leases-fixture.js';

const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});
async function setup() {
  const fixture = await leaseFixture();
  fixtures.push(fixture);
  await fixture.open('chat-a');
  return fixture;
}
const owner = {
  ownerId: 'owner',
  appSessionId: 'app',
  clientInstanceId: 'client',
  viewerId: 'view',
};

describe('page broker input and cleanup', () => {
  it('closing the controlling viewer releases its held keys and leaves agents blocked', async () => {
    const f = await setup();
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', owner);
    const person = await f.service.pageBroker.takePersonControl(viewer);
    confirmPersonPaint(person, viewer);
    const page = f.contexts[0].pages[0].page;
    await person.runPerson({ kind: 'keyDown', key: 'Shift' });
    expect(page.keyboard.down).toHaveBeenCalledExactlyOnceWith('Shift');
    await viewer.close();
    expect(page.keyboard.up).toHaveBeenCalledExactlyOnceWith('Shift');
    expect(person.isCurrent()).toBe(false);
    await expect(f.observe('chat-a')).rejects.toBeDefined();
  });

  it('one viewer cannot type while another controls, and stale cleanup cannot release new input', async () => {
    const f = await setup();
    const firstView = await f.service.pageBroker.captureViewerLease('chat-a', owner);
    const secondView = await f.service.pageBroker.captureViewerLease('chat-a', {
      ...owner,
      viewerId: 'second',
    });
    const first = await f.service.pageBroker.takePersonControl(firstView);
    confirmPersonPaint(first, firstView);
    await expect(f.service.pageBroker.takePersonControl(secondView)).rejects.toMatchObject({
      code: 'busy',
    });
    await firstView.close();
    const second = await f.service.pageBroker.takePersonControl(secondView);
    confirmPersonPaint(second, secondView);
    const page = f.contexts[0].pages[0].page;
    await second.runPerson({ kind: 'keyDown', key: 'Control' });
    await expect(first.runPerson({ kind: 'text', text: 'stale' })).rejects.toMatchObject({
      code: 'stale_page',
    });
    await firstView.close();
    expect(page.keyboard.up).not.toHaveBeenCalledWith('Control');
    expect(page.keyboard.insertText).not.toHaveBeenCalled();
    await f.service.pageBroker.handBack(second);
    expect(page.keyboard.up).toHaveBeenCalledExactlyOnceWith('Control');
    await expect(f.observe('chat-a')).resolves.toBeDefined();
  });

  it('a timed-out barrier never grants input and stays held until physical work settles', async () => {
    const f = await setup();
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', owner);
    const gate = heldProtocolCall();
    vi.mocked(f.contexts[0].pages[0].page.screenshot).mockImplementationOnce(async () => {
      await gate.run();
      return Buffer.from('late pixels');
    });
    const read = f.screenshot('chat-a').catch(() => undefined);
    await gate.started;
    vi.useFakeTimers();
    const taking = f.service.pageBroker
      .takePersonControl(viewer)
      .catch((error: { code: string }) => error.code);
    await vi.advanceTimersByTimeAsync(3_001);
    expect(await taking).toBe('busy');
    await expect(f.observe('chat-a')).rejects.toBeDefined();
    await expect(f.service.pageBroker.takePersonControl(viewer)).rejects.toMatchObject({
      code: 'busy',
    });
    gate.release();
    await read;
  });

  it('closing or replacing the page revokes the old handle before any new protocol attach', async () => {
    const f = await setup();
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', owner);
    const revoked = vi.fn();
    viewer.onRevoked(revoked);
    await f.service.personSession('chat-a').disconnect();
    await f.open('chat-a');
    const count = f.protocolSessions.length;
    expect(viewer.isCurrent()).toBe(false);
    expect(revoked).toHaveBeenCalledTimes(1);
    await expect(viewer.openScreencast()).rejects.toMatchObject({ code: 'stale_page' });
    expect(f.protocolSessions).toHaveLength(count);
  });

  it('owns only its screencast session and stops it before detaching', async () => {
    const f = await setup();
    await f.open('chat-b');
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', owner);
    const stream = await viewer.openScreencast();
    const protocol = f.protocolSessions.at(-1)!;
    expect(protocol.page).toBe(f.contexts[0].pages[0].page);
    expect(stream).not.toHaveProperty('send');
    await stream.start({ quality: 70, maxWidth: 1280, maxHeight: 960 });
    await stream.close();
    expect(protocol.send).toHaveBeenCalledWith('Page.stopScreencast');
    expect(protocol.detach).toHaveBeenCalledTimes(1);
    expect(f.contexts[0].context.close).not.toHaveBeenCalled();
    expect(f.contexts[0].pages[1].page.close).not.toHaveBeenCalled();
  });
});
