import { afterEach, expect, it, vi } from 'vitest';
import { heldProtocolCall, leaseFixture } from './page-leases-fixture.js';

const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function setup() {
  const f = await leaseFixture();
  fixtures.push(f);
  await f.open('chat-a');
  return f;
}
async function popup(f: Awaited<ReturnType<typeof setup>>, opener = true) {
  const context = f.contexts[0];
  const page = await context.context.newPage();
  if (opener) vi.mocked(page.opener).mockResolvedValue(context.pages[0].page);
  context.pages[0].events.emit('popup', page);
  return page;
}
async function assertUnowned(
  f: Awaited<ReturnType<typeof setup>>,
  child: Awaited<ReturnType<typeof popup>>
) {
  const state = await f.state('chat-a');
  expect(state.tabs).toHaveLength(1);
  expect(state.tabs[0].url).toBe(f.contexts[0].pages[0].page.url());
  expect((await f.observe('chat-a')).url).not.toBe(child.url());
  await f.screenshot('chat-a');
  expect(child.title).not.toHaveBeenCalled();
  expect(child.screenshot).not.toHaveBeenCalled();
  expect(child.keyboard.press).not.toHaveBeenCalled();
}

it('a person popup coincident with an agent action remains unowned', async () => {
  const f = await setup();
  const root = f.contexts[0].pages[0];
  const read = await f.observe('chat-a');
  const gate = heldProtocolCall();
  root.wheel.mockImplementationOnce(gate.run);
  const action = f.act('chat-a', {
    kind: 'scroll',
    revision: read.revision,
    deltaX: 0,
    deltaY: 10,
  });
  await gate.started;
  const child = await popup(f);
  gate.release();
  await action;
  await assertUnowned(f, child);
});

it('a popup opened while held remains unowned after hand-back', async () => {
  const f = await setup();
  await f.service.personSession('chat-a').handover.takeOver();
  const child = await popup(f);
  await f.service.personSession('chat-a').handover.resume();
  await assertUnowned(f, child);
});

it('a no-opener popup remains unowned', async () => {
  const f = await setup();
  await assertUnowned(f, await popup(f, false));
});
