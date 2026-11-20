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

describe('page custody transitions', () => {
  it('stopping the host closes every owned profile rather than only the last person view', async () => {
    const f = await setup();
    await f.open('chat-a', 'agent-atlas');
    await f.open('chat-b', 'agent-beacon');
    await f.service.closeAll();
    for (const { context } of f.contexts) expect(context.close).toHaveBeenCalledTimes(1);
  });
  it('shutdown fences new opens while all profiles are being closed', async () => {
    const f = await setup();
    await f.open('chat-a', 'agent-atlas');
    await f.open('chat-b', 'agent-beacon');
    const gate = heldProtocolCall();
    vi.mocked(f.contexts[0].context.close).mockImplementationOnce(gate.run);
    const closing = f.service.closeAll();
    await gate.started;
    try {
      await expect(f.open('chat-new', 'agent-coral')).rejects.toMatchObject({ code: 'closing' });
      expect(f.backend.launch).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(f.contexts[1].context.close).toHaveBeenCalledTimes(1));
    } finally {
      gate.release();
      await closing;
    }
  });

  it('reopening a live chat reuses its page without closing the profile', async () => {
    const f = await setup();
    const before = await f.open('chat-a');
    const after = await f.open('chat-a');
    expect(after.selectedTabId).toBe(before.selectedTabId);
    expect(f.backend.launch).toHaveBeenCalledTimes(1);
    expect(f.contexts[0].context.close).not.toHaveBeenCalled();
  });

  it('takeover waits for the pending page read and never returns its pixels to the agent', async () => {
    const f = await setup();
    await f.open('chat-a');
    const page = f.contexts[0].pages[0].page;
    const gate = heldProtocolCall();
    vi.mocked(page.screenshot).mockImplementationOnce(async () => {
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
    const takeover = f.service
      .personSession('chat-a')
      .handover.takeOver()
      .then(() => {
        granted = true;
      });
    try {
      await vi.advanceTimersByTimeAsync(0);
      await expect(f.observe('chat-a')).rejects.toMatchObject({
        payload: { code: 'taken_by_person' },
      });
      expect(granted).toBe(false);
    } finally {
      gate.release();
    }
    await takeover;
    expect(granted).toBe(true);
    expect(await read).toBe('refused');
  });

  it('holding one page refuses its reads while a sibling continues', async () => {
    const f = await setup();
    await f.open('chat-a');
    const b = await f.open('chat-b');
    await f.service.personSession('chat-a').handover.takeOver();
    for (const operation of [f.state, f.observe, f.screenshot])
      await expect(operation('chat-a')).rejects.toMatchObject({
        payload: { code: 'taken_by_person' },
      });
    await expect(f.observe('chat-b')).resolves.toMatchObject({ tabId: b.selectedTabId });
  });

  it('a held page’s navigation cannot start background title reads', async () => {
    const f = await setup();
    await f.open('chat-a');
    const page = f.contexts[0].pages[0];
    await f.service.personSession('chat-a').handover.takeOver();
    vi.mocked(page.page.title).mockClear();
    page.navigate('https://accounts.example.test/private-step');
    page.events.emit('domcontentloaded');
    expect(page.page.title).not.toHaveBeenCalled();
  });

  it('a response captured before replacing a chat page cannot publish from the new page', async () => {
    const f = await setup();
    await f.open('chat-a');
    const page = f.contexts[0].pages[0].page;
    const gate = heldProtocolCall();
    vi.mocked(page.screenshot).mockImplementationOnce(async () => {
      await gate.run();
      return Buffer.from('old page pixels');
    });
    const read = f.screenshot('chat-a').then(
      () => 'published',
      () => 'refused'
    );
    await gate.started;
    await f.service.personSession('chat-a').disconnect();
    await f.open('chat-a');
    gate.release();
    expect(await read).toBe('refused');
  });
});
