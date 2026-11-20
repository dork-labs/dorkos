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

describe('profile operations across page leases', () => {
  it('a person sign-in cannot replace another chat’s profile from an unrelated view', async () => {
    const f = await setup();
    const a = await f.open('chat-a');
    await expect(
      f.service.personSession(null).handover.signIn({
        url: 'https://accounts.example.test/',
        profileId: 'agent-atlas',
      })
    ).rejects.toMatchObject({ code: 'profile_busy' });
    expect(f.signIn).not.toHaveBeenCalled();
    expect(f.contexts[0].context.close).not.toHaveBeenCalled();
    await expect(f.observe('chat-a')).resolves.toMatchObject({ tabId: a.selectedTabId });
  });

  it('reserves the profile before draining a plain-window handoff', async () => {
    const f = await setup();
    await f.open('chat-a');
    const gate = heldProtocolCall();
    vi.mocked(f.contexts[0].pages[0].page.screenshot).mockImplementationOnce(async () => {
      await gate.run();
      return Buffer.from('late pixels');
    });
    const read = f.screenshot('chat-a').catch(() => undefined);
    await gate.started;
    vi.useFakeTimers();
    const ask = f.ask('chat-a').catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(0);
      await expect(f.open('chat-b')).rejects.toMatchObject({ code: 'profile_busy' });
      expect(f.contexts[0].context.newPage).toHaveBeenCalledTimes(1);
    } finally {
      gate.release();
      await Promise.all([read, ask]);
    }
  });

  it('answers a handoff by its own identity after the person opens another chat', async () => {
    const f = await setup();
    f.signIn.mockImplementation(async (_folder, profileId, url) => ({
      profileId,
      site: new URL(url).host,
      status: 'open',
      startedAt: '2026-11-19T18:00:00.000Z',
    }));
    await f.open('chat-a');
    const handoff = await f.service.personSession('chat-a').handover.ask('chat-a', 'wall');
    await f.open('chat-b', 'agent-beacon');
    await expect(f.service.handover.stop(handoff.handoffId)).resolves.toMatchObject({
      handoff: { id: handoff.handoffId, sessionId: 'chat-a', outcome: 'stopped' },
    });
    await expect(f.observe('chat-b')).resolves.toBeDefined();
  });

  it('keeps the active person handoff visible after another chat opens', async () => {
    const f = await setup();
    f.signIn.mockImplementation(async (_folder, profileId, url) => ({
      profileId,
      site: new URL(url).host,
      status: 'open',
      startedAt: '2026-11-19T18:00:00.000Z',
    }));
    await f.open('chat-a');
    const handoff = await f.service.personSession('chat-a').handover.ask('chat-a', 'wall');
    await f.open('chat-b', 'agent-beacon');
    await expect(f.service.handover.state()).resolves.toMatchObject({
      handoff: { id: handoff.handoffId, sessionId: 'chat-a', outcome: null },
    });
  });

  it('returns the chat’s successful handoff after its automation page disconnects', async () => {
    const f = await setup();
    f.signIn.mockImplementation(async (_folder, profileId, url) => ({
      profileId,
      site: new URL(url).host,
      status: 'open',
      startedAt: '2026-11-19T18:00:00.000Z',
    }));
    await f.open('chat-a');
    const result = await f.ask('chat-a').catch((error: { payload?: unknown }) => error.payload);
    expect(result).toMatchObject({ handoffId: expect.any(String) });
  });

  it('keeps this chat’s ongoing handoff authoritative after its automation page disconnects', async () => {
    const f = await setup();
    f.signIn.mockImplementation(async (_folder, profileId, url) => ({
      profileId,
      site: new URL(url).host,
      status: 'open',
      startedAt: '2026-11-19T18:00:00.000Z',
    }));
    await f.open('chat-a');
    const handed = await f.ask('chat-a');
    for (const read of [f.state, f.observe, f.screenshot])
      await expect(read('chat-a')).rejects.toMatchObject({ payload: { code: 'handed_to_person' } });
    await expect(
      f.act('chat-a', { kind: 'navigate', revision: 0, url: 'https://example.test/' })
    ).rejects.toMatchObject({ payload: { code: 'handed_to_person' } });
    await expect(f.ask('chat-a')).resolves.toEqual(handed);
  });
});
