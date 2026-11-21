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
  return fixture;
}
const owner = {
  ownerId: 'owner',
  appSessionId: 'app',
  clientInstanceId: 'client',
  viewerId: 'view',
};

describe('the existing page broker', () => {
  it('viewer custody never proves a physical close or admits a sibling hand-off launch', async () => {
    const f = await setup();
    await f.open('chat-a');
    await f.open('chat-b');
    const a = f.service.personSession('chat-a');
    const b = f.service.personSession('chat-b');
    const proof = a.captureHandoffClose(await a.state(), 'agent-atlas');
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', owner);
    const lease = await f.service.pageBroker.takePersonControl(viewer);
    expect(proof.completed()).toBe(false);
    expect(() => proof.assertClosed()).toThrow(expect.objectContaining({ code: 'site_changed' }));
    expect(() => b.requireHandoffCustody('agent-atlas')).toThrow(
      expect.objectContaining({ code: 'profile_held' })
    );
    expect(f.signIn).not.toHaveBeenCalled();
    await f.service.pageBroker.handBack(lease);
    expect(proof.completed()).toBe(false);
    expect(() => proof.assertClosed()).toThrow(expect.objectContaining({ code: 'site_changed' }));
    expect(f.contexts[0].pages[0].page.close).not.toHaveBeenCalled();
  });

  it('viewer takeover blocks sibling effects at the front door and at delayed dispatch', async () => {
    const f = await setup();
    await f.open('chat-a');
    await f.open('chat-b');
    const b = f.contexts[0].pages[1];
    const observed = await f.observe('chat-b');
    const element = await b.locator.elementHandle();
    const gate = heldProtocolCall();
    b.locator.elementHandle.mockImplementationOnce(async () => {
      await gate.run();
      return element;
    });
    const action = f
      .act('chat-b', { kind: 'scroll', revision: observed.revision, deltaX: 0, deltaY: 1 })
      .catch((error: unknown) => error);
    await gate.started;
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', owner);
    const taking = f.service.pageBroker.takePersonControl(viewer);
    gate.release();
    expect(await action).toMatchObject({ payload: { code: 'profile_held' } });
    const lease = await taking;
    // A stale revision would fail before dispatch if the front-door custody fence vanished.
    await expect(
      f.act('chat-b', {
        kind: 'scroll',
        revision: observed.revision + 999,
        deltaX: 0,
        deltaY: 1,
      })
    ).rejects.toMatchObject({ payload: { code: 'profile_held' } });
    expect(b.wheel).not.toHaveBeenCalled();
    expect(b.page.goto).not.toHaveBeenCalled();
    await f.service.pageBroker.handBack(lease);
  });

  it('input stays on its captured page and profile, and a forged or stale viewer cannot retarget it', async () => {
    const f = await setup();
    await f.open('chat-a');
    await f.open('chat-b');
    await f.open('chat-c', 'another-agent');
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', owner);
    const lease = await f.service.pageBroker.takePersonControl(viewer);
    confirmPersonPaint(lease, viewer);
    await lease.runPerson({ kind: 'text', text: 'ONLY_A' });
    expect(f.contexts[0].pages[0].page.keyboard.insertText).toHaveBeenCalledExactlyOnceWith(
      'ONLY_A'
    );
    expect(f.contexts[0].pages[1].page.keyboard.insertText).not.toHaveBeenCalled();
    expect(f.contexts[1].pages[0].page.keyboard.insertText).not.toHaveBeenCalled();
    const foreign = await f.service.pageBroker.captureViewerLease('chat-c', {
      ...owner,
      viewerId: 'other-profile',
    });
    await expect(
      f.service.pageBroker.takePersonControl({ ...viewer, binding: foreign.binding })
    ).rejects.toMatchObject({ code: 'stale_page' });
    await f.service.pageBroker.abandon(lease);
    const replacement = await f.service.pageBroker.takePersonControl(viewer);
    confirmPersonPaint(replacement, viewer);
    await expect(lease.runPerson({ kind: 'text', text: 'OLD_EPOCH' })).rejects.toMatchObject({
      code: 'stale_page',
    });
    expect(f.contexts[0].pages[0].page.keyboard.insertText).toHaveBeenCalledTimes(1);
    await f.service.pageBroker.handBack(replacement);
  });

  it('a popup created by person input remains unowned and the viewer stays on its original page', async () => {
    const f = await setup();
    await f.open('chat-a');
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', owner);
    const binding = viewer.binding;
    const lease = await f.service.pageBroker.takePersonControl(viewer);
    confirmPersonPaint(lease, viewer);
    const protocol = f.protocolSessions.at(-1)!;
    const original = protocol.send.getMockImplementation()!;
    protocol.send.mockImplementationOnce(
      async (command: string, params?: { expression?: string }) => {
        if (command === 'Input.dispatchMouseEvent') await f.contexts[0].context.newPage();
        return original(command, params);
      }
    );
    await lease.runPerson({
      kind: 'pointer',
      type: 'mousePressed',
      x: 2,
      y: 3,
      button: 'left',
      clickCount: 1,
    });
    expect(f.contexts[0].pages).toHaveLength(2);
    const popup = f.contexts[0].pages[1].page;
    expect(viewer.binding).toEqual(binding);
    const state = await f.service.personSession('chat-a').state();
    expect(state.tabs.map((tab) => tab.id)).toEqual([binding.tabId]);
    expect(state.selectedTabId).toBe(binding.tabId);
    const stream = await viewer.openScreencast();
    expect(f.protocolSessions.at(-1)!.page).toBe(f.contexts[0].pages[0].page);
    await stream.close();
    await lease.runPerson({ kind: 'text', text: 'ORIGINAL_PAGE' });
    expect(popup.keyboard.insertText).not.toHaveBeenCalled();
    expect(f.contexts[0].pages[0].page.keyboard.insertText).toHaveBeenCalledExactlyOnceWith(
      'ORIGINAL_PAGE'
    );
    await f.service.pageBroker.handBack(lease);
  });

  it.each(['about:blank', 'chrome://settings/', 'file:///tmp/viewer-fixture.html'])(
    'refuses takeover and input on a non-web URL: %s',
    async (url) => {
      const f = await setup();
      await f.open('chat-a');
      const page = f.contexts[0].pages[0];
      const viewer = await f.service.pageBroker.captureViewerLease('chat-a', owner);
      page.navigate(url);
      const before = f.protocolSessions.length;
      await expect(f.service.pageBroker.takePersonControl(viewer)).rejects.toMatchObject({
        code: 'stale_page',
      });
      expect(f.protocolSessions).toHaveLength(before);
      expect(page.page.keyboard.insertText).not.toHaveBeenCalled();
      page.navigate('https://example.com/');
      const lease = await f.service.pageBroker.takePersonControl(viewer);
      confirmPersonPaint(lease, viewer);
      const protocol = f.protocolSessions.at(-1)!;
      protocol.send.mockClear();
      page.navigate(url);
      await expect(lease.runPerson({ kind: 'text', text: 'NON_WEB_CANARY' })).rejects.toMatchObject(
        { code: 'stale_page' }
      );
      expect(page.page.keyboard.insertText).not.toHaveBeenCalled();
      expect(protocol.send.mock.calls.some(([method]) => method.startsWith('Input.'))).toBe(false);
    }
  );

  it('blocks agent admission before an awaited takeover authorization', async () => {
    const f = await setup();
    await f.open('chat-a');
    const viewer = await f.service.pageBroker.captureViewerLease('chat-a', owner);
    const gate = heldProtocolCall();
    f.service.useProfileAccess(gate.run, () => true);
    const taking = f.service.pageBroker.takePersonControl(viewer);
    await gate.started;
    try {
      expect(f.service.findSession('chat-a')!.personHeld()).toBe(true);
    } finally {
      gate.release();
      await taking.catch(() => undefined);
    }
  });
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
