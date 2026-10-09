import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOriginalOwnerStorage } from '../../../../../../e2e/fixtures/managed-owned-frontend.js';

const frontendRequire = createRequire(
  new URL('../../../../../../e2e/package.json', import.meta.url)
);
// Resolve the exact package used by the external e2e helper, not a server-project mock alias.
const originalChromium = frontendRequire('@playwright/test').chromium;
const ports = { connect: vi.fn() };
beforeEach(() => {
  ports.connect.mockReset();
  vi.spyOn(originalChromium, 'connect').mockImplementation(ports.connect);
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
});
const credentials = { email: 'fixture@dork.test', password: 'fixture-only' };

async function setup() {
  const home = await mkdtemp(join(tmpdir(), 'original-owner-storage-'));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const storagePath = join(home, 'storage.json');
  const context = {
    request: { post: vi.fn().mockResolvedValue({ status: () => 200 }) },
    storageState: vi.fn(async (options: { path: string }) => {
      await writeFile(options.path, '{}', { flag: 'wx' });
    }),
    cookies: vi.fn().mockResolvedValue([{ name: 'original-cookie' }]),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  ports.connect.mockResolvedValue(browser);
  return { context, browser, storagePath };
}

it('actual storage producer finishes held context close before connected browser disconnect', async () => {
  const { context, browser, storagePath } = await setup();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const enteredContext = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const originalClosedTarget = new Error(
    'browserContext.close: Target page, context or browser has been closed'
  );
  let disconnected = false;
  const events: string[] = [];
  context.close.mockImplementation(async () => {
    events.push('context-enter');
    entered();
    await held;
    if (disconnected) throw originalClosedTarget;
    events.push('context-return');
  });
  browser.close.mockImplementation(async () => {
    disconnected = true;
    events.push('browser-disconnect');
  });
  const original = createOriginalOwnerStorage(
    'ws://original',
    'http://original',
    credentials,
    storagePath
  );
  // Consume rejection before any held assertion; old racing body produces the exact closed-target cause.
  const outcome = original.then(
    () => ({ completed: true as const }),
    (cause: unknown) => ({ completed: false as const, cause })
  );
  onTestFinished(async () => {
    release();
    await outcome;
  });
  expect(ports.connect).toHaveBeenCalledWith('ws://original');
  await Promise.race([
    enteredContext,
    outcome.then((result) => {
      if (!result.completed) throw result.cause;
      throw Error('CONTEXT_CLOSE_NOT_ENTERED');
    }),
  ]);
  await Promise.resolve();
  const disconnectsDuringHeldContext = browser.close.mock.calls.length;
  release();
  expect(await outcome).toEqual({ completed: true });
  expect(disconnectsDuringHeldContext).toBe(0);
  expect(events).toEqual(['context-enter', 'context-return', 'browser-disconnect']);
  expect(context.storageState).toHaveBeenCalledWith({ path: storagePath });
  expect((await stat(storagePath)).mode & 0o777).toBe(0o600);
  expect(browser.close).toHaveBeenCalledTimes(1);
});

it.each([false, undefined, new Error('original context close')])(
  'actual context close failure %s still attempts browser close and preserves original cause',
  async (cause) => {
    const { context, browser, storagePath } = await setup();
    context.close.mockRejectedValue(cause);
    browser.close.mockRejectedValue(Error('LATER_BROWSER_CLOSE'));
    await expect(
      createOriginalOwnerStorage('ws://original', 'http://original', credentials, storagePath)
    ).rejects.toBe(cause);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  }
);

it.each([false, undefined])(
  'actual sign-in failure %s survives both original close failures',
  async (cause) => {
    const { context, browser, storagePath } = await setup();
    context.request.post.mockRejectedValue(cause);
    context.close.mockRejectedValue(Error('LATER_CONTEXT_CLOSE'));
    browser.close.mockRejectedValue(Error('LATER_BROWSER_CLOSE'));
    await expect(
      createOriginalOwnerStorage('ws://original', 'http://original', credentials, storagePath)
    ).rejects.toBe(cause);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  }
);

it('failed actual context acquisition still disconnects the already connected original browser', async () => {
  const { browser, storagePath } = await setup();
  const cause = new Error('ORIGINAL_CONTEXT_ACQUISITION_FAILED');
  browser.newContext.mockRejectedValue(cause);
  await expect(
    createOriginalOwnerStorage('ws://original', 'http://original', credentials, storagePath)
  ).rejects.toBe(cause);
  expect(browser.close).toHaveBeenCalledTimes(1);
});
