import { afterEach, expect, it, vi } from 'vitest';
import { heldProtocolCall, leaseFixture } from './page-leases-fixture.js';

const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function setup() {
  const f = await leaseFixture(async () => undefined);
  fixtures.push(f);
  await f.open('chat-a');
  await f.open('chat-b');
  return f;
}

it('while a person holds a page, sibling agents on that browser wait', async () => {
  const f = await setup();
  await f.open('chat-c', 'another-agent');
  const [a, b] = f.contexts[0].pages;
  const observation = await f.observe('chat-b');
  let focused = a.page;
  b.wheel.mockImplementation(async () => {
    focused = await f.contexts[0].context.newPage();
  });
  await f.service.personSession('chat-a').handover.takeOver();
  await expect(
    f.act('chat-b', {
      kind: 'scroll',
      revision: observation.revision,
      deltaX: 0,
      deltaY: 1,
    })
  ).rejects.toMatchObject({ payload: { code: 'profile_held' } });
  await expect(
    f.act('chat-b', {
      kind: 'navigate',
      revision: observation.revision,
      url: 'https://next.example.test/',
    })
  ).rejects.toMatchObject({ payload: { code: 'profile_held' } });
  expect(b.wheel).not.toHaveBeenCalled();
  expect(b.page.goto).not.toHaveBeenCalled();
  expect(f.contexts[0].context.newPage).toHaveBeenCalledTimes(2);
  expect(focused).toBe(a.page);
  await expect(
    f.act('chat-c', {
      kind: 'navigate',
      revision: (await f.observe('chat-c')).revision,
      url: 'https://independent.example.test/',
    })
  ).resolves.toBeDefined();
  await f.service.personSession('chat-a').handover.resume();
  await expect(
    f.act('chat-b', {
      kind: 'scroll',
      revision: (await f.observe('chat-b')).revision,
      deltaX: 0,
      deltaY: 1,
    })
  ).resolves.toBeDefined();
  expect(b.wheel).toHaveBeenCalledTimes(1);
});

it('an open handoff also makes sibling agent actions wait', async () => {
  const f = await setup();
  const observation = await f.observe('chat-b');
  vi.spyOn(f.service.personSession('chat-a').handover, 'hasActiveHandoff').mockReturnValue(true);
  await expect(
    f.act('chat-b', {
      kind: 'scroll',
      revision: observation.revision,
      deltaX: 0,
      deltaY: 1,
    })
  ).rejects.toMatchObject({ payload: { code: 'profile_held' } });
  expect(f.contexts[0].pages[1].wheel).not.toHaveBeenCalled();
});

it('taking a page waits for sibling physical actions before granting control', async () => {
  const f = await setup();
  const b = f.contexts[0].pages[1];
  const gate = heldProtocolCall();
  b.wheel.mockImplementationOnce(gate.run);
  const action = f.act('chat-b', {
    kind: 'scroll',
    revision: (await f.observe('chat-b')).revision,
    deltaX: 0,
    deltaY: 1,
  });
  await gate.started;
  vi.useFakeTimers();
  let granted = false;
  const take = f.service
    .personSession('chat-a')
    .handover.takeOver()
    .then(() => {
      granted = true;
    });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(granted).toBe(false);
  } finally {
    gate.release();
    await action;
    await take;
  }
  expect(granted).toBe(true);
});

it('a sibling waiting before dispatch rechecks the person hold', async () => {
  const f = await setup();
  const b = f.contexts[0].pages[1];
  const observation = await f.observe('chat-b');
  const element = await b.locator.elementHandle();
  const gate = heldProtocolCall();
  b.locator.elementHandle.mockImplementationOnce(async () => {
    await gate.run();
    return element;
  });
  const action = f
    .act('chat-b', {
      kind: 'scroll',
      revision: observation.revision,
      deltaX: 0,
      deltaY: 1,
    })
    .catch((error: unknown) => error);
  await gate.started;
  const take = f.service.personSession('chat-a').handToPerson();
  gate.release();
  expect(await action).toMatchObject({ payload: { code: 'profile_held' } });
  await take;
  expect(b.wheel).not.toHaveBeenCalled();
});
