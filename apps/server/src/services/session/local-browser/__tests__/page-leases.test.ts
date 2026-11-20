import { afterEach, describe, expect, it, vi } from 'vitest';
import { heldProtocolCall, leaseFixture } from './page-leases-fixture.js';

const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});
async function setup() {
  const fixture = await leaseFixture();
  fixtures.push(fixture);
  return fixture;
}

describe('chat page leases', () => {
  it('reserves six agent pages without charging the person’s own browser or evicting a chat', async () => {
    const f = await setup();
    await f.service.open({ mode: 'new-window' });
    for (let index = 0; index < 6; index++) await f.open(`chat-${index}`);
    await expect(f.open('chat-seventh')).rejects.toMatchObject({ code: 'tab_limit' });
    for (const { context } of f.contexts) expect(context.close).not.toHaveBeenCalled();
    await expect(f.observe('chat-0')).resolves.toBeDefined();
  });
  it('explicitly closing a person-held page releases its agent slot', async () => {
    const f = await setup();
    for (let index = 0; index < 6; index++) await f.open(`chat-${index}`);
    await f.service.personSession('chat-0').handover.takeOver();
    await f.service.personSession('chat-0').handover.disconnect();
    await expect(f.open('chat-new')).resolves.toMatchObject({ sessionId: 'chat-new' });
    await expect(f.observe('chat-1')).resolves.toBeDefined();
  });

  it('adds a page to the same profile without closing or moving the first chat', async () => {
    const f = await setup();
    const first = await f.open('chat-a');
    const second = await f.open('chat-b');
    expect(f.backend.launch).toHaveBeenCalledTimes(1);
    expect(f.contexts[0].context.close).not.toHaveBeenCalled();
    expect(second.selectedTabId).not.toBe(first.selectedTabId);
    await expect(f.state('chat-a')).resolves.toMatchObject({
      sessionId: 'chat-a',
      selectedTabId: first.selectedTabId,
      tabs: [{ id: first.selectedTabId }],
    });
    await expect(f.state('chat-b')).resolves.toMatchObject({
      sessionId: 'chat-b',
      selectedTabId: second.selectedTabId,
      tabs: [{ id: second.selectedTabId }],
    });
  });

  it('runs actions on separate pages at the same time', async () => {
    const f = await setup();
    await f.open('chat-a');
    await f.open('chat-b');
    const [a, b] = await Promise.all([f.observe('chat-a'), f.observe('chat-b')]);
    const first = f.contexts[0].pages[0];
    const second = f.contexts[0].pages[1];
    const gateA = heldProtocolCall();
    const gateB = heldProtocolCall();
    first.wheel.mockImplementationOnce(gateA.run);
    second.wheel.mockImplementationOnce(gateB.run);
    const actions = Promise.allSettled([
      f.act('chat-a', { kind: 'scroll', revision: a.revision, deltaX: 0, deltaY: 10 }),
      f.act('chat-b', { kind: 'scroll', revision: b.revision, deltaX: 0, deltaY: 20 }),
    ]);
    try {
      await vi.waitFor(() => {
        expect(first.wheel).toHaveBeenCalledExactlyOnceWith(0, 10);
        expect(second.wheel).toHaveBeenCalledExactlyOnceWith(0, 20);
      });
    } finally {
      gateA.release();
      gateB.release();
    }
    expect((await actions).map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  });

  it('keeps a second profile live when a different agent opens', async () => {
    const f = await setup();
    await f.open('chat-a', 'agent-atlas');
    await f.open('chat-b', 'agent-beacon');
    expect(f.backend.launch).toHaveBeenCalledTimes(2);
    expect(f.contexts[0].context.close).not.toHaveBeenCalled();
    await expect(f.observe('chat-a')).resolves.toMatchObject({
      url: 'https://page-1-0.example.test/',
    });
    await expect(f.observe('chat-b')).resolves.toMatchObject({
      url: 'https://page-2-0.example.test/',
    });
  });

  it('a closed tab ends only its lease and never adopts a sibling page', async () => {
    const f = await setup();
    await f.open('chat-a');
    const second = await f.open('chat-b');
    await f.contexts[0].pages[0].page.close();
    await expect(f.state('chat-a')).rejects.toMatchObject({ payload: { code: 'tab_gone' } });
    await expect(f.state('chat-b')).resolves.toMatchObject({ selectedTabId: second.selectedTabId });
    await expect(f.observe('chat-b')).resolves.toMatchObject({ tabId: second.selectedTabId });
  });

  it('a protected-page refusal pauses only the offending page', async () => {
    const f = await setup();
    await f.open('chat-a');
    const second = await f.open('chat-b');
    f.contexts[0].pages[0].navigate('https://dorkos.ai/account');
    await expect(f.observe('chat-a')).rejects.toMatchObject({ payload: { code: 'cloud_origin' } });
    await expect(f.observe('chat-b')).resolves.toMatchObject({ tabId: second.selectedTabId });
  });

  it('refusals for an unopened chat contain no sibling identity or page details', async () => {
    const f = await setup();
    await f.open('chat-secret');
    vi.mocked(f.contexts[0].pages[0].page.title).mockClear();
    const failure = await f.state('chat-missing').then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toMatchObject({ payload: { code: 'not_opened' } });
    const serialized = JSON.stringify(failure);
    for (const foreign of [
      'chat-secret',
      'Title chat-secret',
      'example.test',
      'chatTitle',
      'chatId',
    ])
      expect(serialized).not.toContain(foreign);
    expect(f.contexts[0].pages[0].page.title).not.toHaveBeenCalled();
    expect(f.contexts[0].pages[0].page.evaluateHandle).not.toHaveBeenCalled();
  });

  it('a marked chat never uses a clean sibling refusal to request a handoff', async () => {
    const f = await setup();
    f.service.handover.useOutsideTurnCheck(async (sessionId) =>
      sessionId === 'chat-a' ? 'read_outside_text' : null
    );
    await f.open('chat-a');
    await f.open('chat-b');
    f.contexts[0].pages[0].navigate('https://shared.example.test/');
    f.contexts[0].pages[1].navigate('https://shared.example.test/');
    vi.mocked(f.contexts[0].pages[1].page.title).mockResolvedValue('Access Denied');
    f.contexts[0].pages[1].outline(
      'Access Denied. Reference #18.example. https://errors.edgesuite.net/18.example'
    );
    await expect(f.observe('chat-b')).resolves.toMatchObject({
      refusal: { host: 'shared.example.test' },
    });
    await expect(f.ask('chat-a')).rejects.toMatchObject({ payload: { code: 'outside_turn' } });
    expect(f.signIn).not.toHaveBeenCalled();
    await expect(f.state('chat-b')).resolves.toMatchObject({ paused: false });
  });

  it('plain sign-in refuses while a sibling lease uses the same profile', async () => {
    const f = await setup();
    await f.open('chat-a');
    const second = await f.open('chat-b');
    await expect(f.ask('chat-a')).rejects.toMatchObject({ payload: { code: 'profile_busy' } });
    expect(f.signIn).not.toHaveBeenCalled();
    expect(f.contexts[0].context.close).not.toHaveBeenCalled();
    await expect(f.observe('chat-b')).resolves.toMatchObject({ tabId: second.selectedTabId });
  });
});
