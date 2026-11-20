import { afterEach, expect, it, vi } from 'vitest';
import { heldProtocolCall, leaseFixture } from './page-leases-fixture.js';
import { prepareAgentLaunch } from '../connection/agent-launch.js';

const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function setup(writer?: (record: unknown) => Promise<void>) {
  const f = await leaseFixture(writer);
  fixtures.push(f);
  return f;
}
function allowSignIn(f: Awaited<ReturnType<typeof setup>>) {
  f.signIn.mockImplementation(async (_folder, profileId, url) => ({
    profileId,
    site: new URL(url).host,
    status: 'open',
    startedAt: '2026-11-19T18:00:00.000Z',
  }));
}

it.each([false, true])(
  'admits a single chat handoff after opening with startup page %s',
  async (withStartupPage) => {
    const f = await setup();
    if (withStartupPage) {
      const launch = vi.mocked(f.backend.launch).getMockImplementation()!;
      vi.mocked(f.backend.launch).mockImplementation(async (...args) => {
        const context = await launch(...args);
        const startup = await context.newPage();
        await startup.goto('about:blank');
        await prepareAgentLaunch(context, args[4]!);
        return context;
      });
    }
    await f.open('chat-a');
    const context = f.contexts[0];
    const owned = f.service.personSession('chat-a').pageConnection()?.pages()[0];
    expect(owned).toBe(context.pages.at(-1)?.page);
    if (withStartupPage) expect(owned).not.toBe(context.pages[0].page);
    expect(context.context.pages()).toEqual([owned]);
    allowSignIn(f);
    await expect(f.ask('chat-a')).resolves.toMatchObject({ handoffId: expect.any(String) });
    expect(f.signIn).toHaveBeenCalledTimes(1);
  }
);

it('opening a sibling on a running profile never closes an unowned blank page', async () => {
  const f = await setup();
  await f.open('chat-a');
  const unowned = await f.contexts[0].context.newPage();
  await unowned.goto('about:blank');
  await f.open('chat-b');
  expect(f.backend.launch).toHaveBeenCalledTimes(1);
  expect(unowned.close).not.toHaveBeenCalled();
  expect(f.contexts[0].context.pages()).toHaveLength(3);
  await expect(f.ask('chat-a')).rejects.toMatchObject({ payload: { code: 'profile_busy' } });
});

it('a launch admission callback refuses after its physical generation is retired', async () => {
  const f = await setup();
  await f.open('chat-a');
  const admit = vi.mocked(f.backend.launch).mock.calls[0][4]!;
  await f.service.personSession('chat-a').disconnect();
  await f.open('chat-b');
  expect(() => admit()).toThrow();
});

it('releases unowned popups with the last chat page so a person can sign in', async () => {
  const f = await setup();
  await f.open('chat-a');
  const root = f.contexts[0].pages[0];
  const observation = await f.observe('chat-a');
  const gate = heldProtocolCall();
  root.wheel.mockImplementationOnce(gate.run);
  const action = f.act('chat-a', {
    kind: 'scroll',
    revision: observation.revision,
    deltaX: 0,
    deltaY: 10,
  });
  await gate.started;
  const child = await f.contexts[0].context.newPage();
  vi.mocked(child.opener).mockResolvedValue(root.page);
  root.events.emit('popup', child);
  gate.release();
  await action;
  await f.service.personSession('chat-a').handover.disconnect();
  allowSignIn(f);
  await expect(
    f.service.personSession(null).handover.signIn({
      url: 'https://accounts.example.test/',
      profileId: 'agent-atlas',
    })
  ).resolves.toBeDefined();
  expect(f.signIn).toHaveBeenCalledTimes(1);
  expect(child.isClosed()).toBe(true);
});

it('checks for a missing lease neither create sessions nor reach another chat', async () => {
  const f = await setup();
  await f.open('chat-b');
  const count = f.service.pageSessions().length;
  const b = f.contexts[0].pages[0].page;
  vi.mocked(b.title).mockClear();
  f.service.handover.refuseStopped('missing');
  expect(f.service.handover.isOpenFor('missing')).toBe(false);
  await f.service.handover.outsideTurnReason('missing');
  await Promise.resolve()
    .then(() => f.service.handover.requireAgentMayUse('missing'))
    .catch(() => undefined);
  for (const read of [f.state, f.observe, f.screenshot, f.ask]) {
    await expect(read('missing')).rejects.toMatchObject({ payload: { code: 'not_opened' } });
    await expect(read('')).rejects.toMatchObject({ payload: { code: 'session_required' } });
  }
  await Promise.resolve()
    .then(() => f.service.personSession('missing').state())
    .catch(() => undefined);
  await expect(f.service.personState('missing')).resolves.toMatchObject({
    sessionId: null,
    tabs: [],
  });
  expect(f.service.pageSessions()).toHaveLength(count);
  expect(b.title).not.toHaveBeenCalled();
  expect(b.evaluateHandle).not.toHaveBeenCalled();
});

it('removal drops the chat lookup while captured person-held pages remain revoked', async () => {
  const f = await setup();
  await f.open('chat-a');
  const session = f.service.personSession('chat-a');
  await session.handover.takeOver();
  await f.service.sessionRemoved('chat-a');
  expect(() => f.service.personSession('chat-a')).toThrow();
  await expect(session.resume()).rejects.toMatchObject({ code: 'profile_not_allowed' });
  await expect(session.observe()).rejects.toMatchObject({ code: 'profile_not_allowed' });
  await expect(f.state('chat-a')).rejects.toMatchObject({ payload: { code: 'not_opened' } });
});

it('a failed journal does not turn a completed disconnect into a failed close', async () => {
  let fail = false;
  const f = await setup(async () => {
    if (fail) throw new Error('Transient fake write failure');
  });
  await f.open('chat-a');
  const session = f.service.personSession('chat-a');
  fail = true;
  await expect(session.pause()).rejects.toMatchObject({ code: 'audit_unavailable' });
  await expect(session.disconnect()).resolves.toMatchObject({ status: 'disconnected' });
});

it('a fresh reopen recovers a transient journal failure before granting reads', async () => {
  let fail = false;
  const f = await setup(async () => {
    if (fail) throw new Error('Transient fake write failure');
  });
  await f.open('chat-a');
  const session = f.service.personSession('chat-a');
  fail = true;
  await expect(session.pause()).rejects.toMatchObject({ code: 'audit_unavailable' });
  await session.disconnect().catch(() => undefined);
  fail = false;
  await expect(f.open('chat-a')).resolves.toMatchObject({ status: 'connected' });
  await expect(f.observe('chat-a')).resolves.toBeDefined();
});

it('concurrent person opens reserve the sixth slot before handoff preparation awaits', async () => {
  const f = await setup();
  await f.open('chat-six');
  const sixth = f.service.personSession('chat-six');
  await sixth.disconnect();
  for (let index = 0; index < 5; index++) await f.open(`chat-${index}`);
  const gate = heldProtocolCall();
  const original = sixth.handover.open.bind(sixth.handover);
  vi.spyOn(sixth.handover, 'open').mockImplementationOnce(async (input) => {
    await gate.run();
    return original(input);
  });
  const first = f.service.openForPerson({
    mode: 'new-window',
    sessionId: 'chat-six',
    profileId: 'agent-atlas',
  });
  await gate.started;
  const second = await f.service
    .openForPerson({
      mode: 'new-window',
      sessionId: 'chat-seven',
      profileId: 'agent-atlas',
    })
    .then(
      () => ({ status: 'fulfilled' }),
      (reason: unknown) => ({ status: 'rejected', reason })
    );
  gate.release();
  const results = [await first.then(() => ({ status: 'fulfilled' })), second];
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((result) => result.status === 'rejected')).toMatchObject({
    reason: { code: 'tab_limit' },
  });
  expect(
    f.contexts.flatMap(({ pages }) => pages).filter(({ page }) => !page.isClosed())
  ).toHaveLength(6);
});

it('global handoff state contains no last-changed chat when no handoff is open', async () => {
  const f = await setup();
  await f.open('chat-a');
  await expect(f.service.handover.state()).resolves.toMatchObject({
    sessionId: null,
    tabs: [],
    handoff: null,
    signIn: null,
  });
  allowSignIn(f);
  const handoff = (await f.ask('chat-a')) as { handoffId: string };
  await f.service.handover.stop(handoff.handoffId);
  await expect(f.service.handover.state()).resolves.toMatchObject({
    sessionId: null,
    tabs: [],
    handoff: null,
    signIn: null,
  });
});

it('person resume uses person-facing words after access is revoked', async () => {
  const f = await setup();
  await f.open('chat-a');
  const session = f.service.personSession('chat-a');
  await session.handover.takeOver();
  await f.service.revokeProfileAccess('agent-atlas');
  const error = await session.resume().catch((error: unknown) => error);
  expect(error).toMatchObject({ code: 'profile_not_allowed' });
  expect((error as Error).message).not.toContain('Ask the person');
});
