import { afterEach, describe, expect, it, vi } from 'vitest';
import { heldProtocolCall, leaseFixture } from './page-leases-fixture.js';

const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});
async function setup() {
  const fixture = await leaseFixture();
  fixtures.push(fixture);
  return fixture;
}
const owner = {
  ownerId: 'owner',
  appSessionId: 'app',
  clientInstanceId: 'client',
  viewerId: 'view',
};

describe('the existing page broker', () => {
  it('binds one existing page without exposing browser enumeration or another chat', async () => {
    const f = await setup();
    const a = await f.open('chat-a');
    await f.open('chat-b');
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', owner);
    expect(viewer.binding).toMatchObject({ sessionId: 'chat-a', tabId: a.selectedTabId });
    expect(viewer.isCurrent()).toBe(true);
    expect(viewer).not.toHaveProperty('page');
    expect(viewer).not.toHaveProperty('browser');
    expect(viewer).not.toHaveProperty('send');
    expect(f.backend.launch).toHaveBeenCalledTimes(1);
  });

  it('grants person input only after the exact page’s physical read drains', async () => {
    const f = await setup();
    await f.open('chat-a');
    await f.open('chat-b');
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', owner);
    const gate = heldProtocolCall();
    vi.mocked(f.contexts[0].pages[0].page.screenshot).mockImplementationOnce(async () => {
      await gate.run();
      return Buffer.from('late pixels');
    });
    const read = f.screenshot('chat-a').then(
      () => 'published',
      () => 'refused'
    );
    await gate.started;
    vi.useFakeTimers();
    let granted = false;
    const taking = f.service.pageBroker.takePersonControl(viewer).then((lease) => {
      granted = true;
      return lease;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(granted).toBe(false);
      await expect(f.observe('chat-a')).rejects.toBeDefined();
      await expect(f.observe('chat-b')).resolves.toBeDefined();
    } finally {
      gate.release();
    }
    const person = await taking;
    expect(granted).toBe(true);
    expect(await read).toBe('refused');
    expect(person.isCurrent()).toBe(true);
  });

  it('abandonment revokes input without resuming the agent, and stale hand-back cannot release a newer controller', async () => {
    const f = await setup();
    await f.open('chat-a');
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', owner);
    const first = await f.service.pageBroker.takePersonControl(viewer);
    await f.service.pageBroker.abandon(first);
    expect(first.isCurrent()).toBe(false);
    await expect(f.observe('chat-a')).rejects.toBeDefined();
    const second = await f.service.pageBroker.takePersonControl(viewer);
    await expect(f.service.pageBroker.handBack(first)).rejects.toMatchObject({
      code: 'stale_page',
    });
    expect(second.isCurrent()).toBe(true);
    await f.service.pageBroker.handBack(second);
    await expect(f.observe('chat-a')).resolves.toBeDefined();
  });

  it('exposes only this page’s navigation revision and custody epoch to its viewer', async () => {
    const f = await setup();
    await f.open('chat-a');
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', owner);
    const facts = () => viewer.facts();
    const before = facts();
    const changed = vi.fn();
    const off = viewer.onPageChange(changed);
    f.contexts[0].pages[0].navigate('https://next.example.test/private?token=made-up');
    const next = facts();
    expect(next.navigationGeneration).toBe(before.navigationGeneration + 1);
    expect(next.revision).toBeGreaterThan(before.revision);
    expect(changed).toHaveBeenCalled();
    changed.mockClear();
    f.contexts[0].pages[0].events.emit('frameattached', {});
    expect(facts().navigationGeneration).toBe(next.navigationGeneration + 1);
    expect(changed).toHaveBeenCalled();
    const control = await f.service.pageBroker.takePersonControl(viewer);
    expect(facts().controlEpoch).toBe(control.epoch);
    expect(JSON.stringify(facts())).not.toContain('private');
    off();
    await viewer.close();
    expect(() => facts()).toThrow();
  });
});
