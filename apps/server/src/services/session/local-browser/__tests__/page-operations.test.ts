import { afterEach, expect, it, vi } from 'vitest';
import { heldProtocolCall, leaseFixture } from './page-leases-fixture.js';
const fixtures: Awaited<ReturnType<typeof leaseFixture>>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fixtures.splice(0).map((f) => f.cleanup()));
});
async function setup() {
  const f = await leaseFixture();
  fixtures.push(f);
  return f;
}

it('serializes reads on one page while another page continues', async () => {
  const f = await setup();
  await f.open('chat-a');
  await f.open('chat-b');
  const a = f.contexts[0].pages[0];
  const pixels = await a.page.screenshot();
  const gate = heldProtocolCall();
  vi.mocked(a.page.screenshot).mockImplementationOnce(async () => {
    await gate.run();
    return pixels;
  });
  const first = f.screenshot('chat-a').catch(() => undefined);
  await gate.started;
  vi.useFakeTimers();
  const second = f.observe('chat-a').catch(() => undefined);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(a.locator.ariaSnapshot).not.toHaveBeenCalled();
    await expect(f.observe('chat-b')).resolves.toBeDefined();
  } finally {
    gate.release();
    await Promise.all([first, second]);
  }
  expect(a.locator.ariaSnapshot).toHaveBeenCalledTimes(1);
});

it('bounds pending reads without dispatching or retrying the overflow', async () => {
  const f = await setup();
  await f.open('chat-a');
  const page = f.contexts[0].pages[0].page;
  const pixels = await page.screenshot();
  const gate = heldProtocolCall();
  vi.mocked(page.screenshot).mockImplementationOnce(async () => {
    await gate.run();
    return pixels;
  });
  const active = f.screenshot('chat-a').catch(() => undefined);
  await gate.started;
  const waiting = Array.from({ length: 32 }, () => f.state('chat-a').catch(() => undefined));
  try {
    await expect(f.state('chat-a')).rejects.toMatchObject({ payload: { code: 'busy' } });
  } finally {
    gate.release();
    await Promise.all([active, ...waiting]);
  }
});
