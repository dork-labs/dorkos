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

it('keeps a person-held page in front when another page opens on that browser', async () => {
  const f = await setup();
  await f.open('chat-c', 'agent-beacon');
  const [a, b] = f.contexts[0].pages;
  const c = f.contexts[1].pages[0];
  await f.service.personSession('chat-a').handover.takeOver();
  await f.service.personSession('chat-c').handover.takeOver();
  for (const { page } of [a, b, c]) vi.mocked(page.bringToFront).mockClear();
  let front = b.page;
  vi.mocked(a.page.bringToFront).mockImplementation(async () => {
    front = a.page;
  });
  const child = await f.contexts[0].context.newPage();
  expect(a.page.bringToFront).toHaveBeenCalledExactlyOnceWith();
  expect(front).toBe(a.page);
  expect(b.page.bringToFront).not.toHaveBeenCalled();
  expect(c.page.bringToFront).not.toHaveBeenCalled();
  await f.service.personSession('chat-a').handover.resume();
  const state = await f.state('chat-a');
  expect(state.tabs).toHaveLength(1);
  expect(state.tabs[0].url).toBe(a.page.url());
  expect((await f.observe('chat-b')).url).toBe(b.page.url());
  expect(child.title).not.toHaveBeenCalled();
  expect(child.screenshot).not.toHaveBeenCalled();
});

it('hand-back waits for the held page’s pending front request', async () => {
  const f = await setup();
  const a = f.contexts[0].pages[0];
  await f.service.personSession('chat-a').handover.takeOver();
  const gate = heldProtocolCall();
  vi.mocked(a.page.bringToFront).mockClear().mockImplementationOnce(gate.run);
  let resume: Promise<unknown> | undefined;
  let resumed = false;
  try {
    await f.contexts[0].context.newPage();
    expect(a.page.bringToFront).toHaveBeenCalledOnce();
    vi.useFakeTimers();
    resume = f.service
      .personSession('chat-a')
      .handover.resume()
      .then(() => {
        resumed = true;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(resumed).toBe(false);
  } finally {
    gate.release();
    await resume;
  }
  expect(resumed).toBe(true);
});

it('opening a page after hand-back does not re-front an agent page', async () => {
  const f = await setup();
  const [a, b] = f.contexts[0].pages;
  await f.service.personSession('chat-a').handover.takeOver();
  await f.service.personSession('chat-a').handover.resume();
  for (const { page } of [a, b]) vi.mocked(page.bringToFront).mockClear();
  await f.contexts[0].context.newPage();
  expect(a.page.bringToFront).not.toHaveBeenCalled();
  expect(b.page.bringToFront).not.toHaveBeenCalled();
});
