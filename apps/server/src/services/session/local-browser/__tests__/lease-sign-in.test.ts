import { afterEach, expect, it, vi } from 'vitest';
import { heldProtocolCall, leaseFixture } from './page-leases-fixture.js';

const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});

async function setup() {
  const f = await leaseFixture();
  fixtures.push(f);
  await f.open('chat-a');
  await f.open('chat-b');
  await f.open('chat-c', 'agent-beacon');
  let active = false;
  vi.spyOn(f.service.personSession(null).handover, 'signInHoldsProfile').mockImplementation(
    (profile) => active && profile === 'agent-atlas'
  );
  const begin = async () => {
    active = true;
  };
  return { f, begin };
}

it('a sign-in makes only agents on that browser wait, including reads', async () => {
  const { f, begin } = await setup();
  await begin();
  for (const chat of ['chat-a', 'chat-b']) {
    await expect(f.ask(chat)).rejects.toMatchObject({ payload: { code: 'signing_in' } });
    for (const read of [f.state, f.observe, f.screenshot])
      await expect(read(chat)).rejects.toMatchObject({ payload: { code: 'signing_in' } });
    await expect(
      f.act(chat, { kind: 'navigate', revision: 0, url: 'https://next.example.test/' })
    ).rejects.toMatchObject({ payload: { code: 'signing_in' } });
  }
  await expect(f.observe('chat-c')).resolves.toBeDefined();
  expect(f.contexts[0].pages[1].page.goto).not.toHaveBeenCalled();
  f.signIn.mockImplementation(async (_folder, profileId, url) => ({
    profileId,
    site: new URL(url).host,
    status: 'open',
    startedAt: new Date().toISOString(),
  }));
  await expect(f.ask('chat-c')).resolves.toMatchObject({ handoffId: expect.any(String) });
});

it('an agent waiting before dispatch rechecks sign-in on its browser', async () => {
  const { f, begin } = await setup();
  const b = f.contexts[0].pages[1];
  const observation = await f.observe('chat-b');
  const element = await b.locator.elementHandle();
  const gate = heldProtocolCall();
  b.locator.elementHandle.mockImplementationOnce(async () => {
    await gate.run();
    return element;
  });
  const action = f
    .act('chat-b', { kind: 'scroll', revision: observation.revision, deltaX: 0, deltaY: 1 })
    .catch((error: unknown) => error);
  await gate.started;
  await begin();
  gate.release();
  expect(await action).toMatchObject({ payload: { code: 'signing_in' } });
  expect(b.wheel).not.toHaveBeenCalled();
});
