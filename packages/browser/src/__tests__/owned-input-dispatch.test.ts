import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import {
  constructOwnedBrowserEngine,
  type PrivateBrowserInputDispatcher,
  type PrivateBrowserCaptureDispatcher,
} from '../engine.js';
import type { OwnedInputAuthorization } from '../input/owned-work.js';
import { configuration, fakePage, requestId, root, deferred, tick } from './parent-fixture.js';
const source = vi.hoisted(() => ({ launch: vi.fn(), directory: vi.fn(), removed: vi.fn() }));
vi.mock('../runtime/public-library.js', () => ({
  verifiedLibrary: async () => ({ launchPersistentContext: source.launch }),
}));
vi.mock('../runtime/host-identity.js', () => ({
  hostIdentity: () => root,
  nativeHolder: async () => root,
}));
vi.mock('../profiles/owned-directory.js', () => ({
  ownDirectory: source.directory,
  assertDirectory: vi.fn(),
}));
vi.mock('../profiles/paths.js', () => ({ prepareDataRoot: async () => '/fixture/data' }));
vi.mock('../network/fixture-proxy.js', () => ({
  startFixtureProxy: async () => ({ url: 'http://127.0.0.1:9002', close: async () => {} }),
}));
vi.mock('node:fs/promises', () => ({
  mkdtemp: async () => '/fixture/data/ephemeral/input-owned',
  rm: source.removed,
}));
afterEach(() => vi.resetAllMocks());
function fixture() {
  let closed = false;
  const page = fakePage();
  const callbacks = new Map<string, (...values: unknown[]) => void>();
  source.directory.mockImplementation((path: string) => ({ path, dev: 1, ino: 1 }));
  source.launch.mockResolvedValue({
    pages: () => [page.page],
    newPage: async () => page.page,
    on: (name: string, callback: (...values: unknown[]) => void) => callbacks.set(name, callback),
    close: async () => {
      closed = true;
      callbacks.get('close')?.();
    },
  });
  const config = configuration();
  config.processes.observe = async () => ({
    status: closed ? ('dead' as const) : ('alive' as const),
  });
  let dispatcher: PrivateBrowserInputDispatcher | undefined = undefined;
  let captureDispatcher: PrivateBrowserCaptureDispatcher | undefined;
  let engine: ReturnType<typeof constructOwnedBrowserEngine> | undefined = undefined;
  // Original shutdown retention is installed before construction or first fallible acquisition.
  onTestFinished(async () => {
    await engine?.shutdown();
  });
  const inputOwner = {
    registerDispatcher: vi.fn((value: PrivateBrowserInputDispatcher) => {
      dispatcher = value;
    }),
  };
  engine = constructOwnedBrowserEngine(config, {
    registerBirth() {},
    refuseBirth() {},
    input: inputOwner,
    capture: {
      registerDispatcher(value) {
        captureDispatcher = value;
      },
    },
  });
  return {
    ...page,
    config,
    engine,
    inputOwner,
    dispatcher: () => dispatcher!,
    captureDispatcher: () => captureDispatcher!,
  };
}
const authority = () => ({
  authorize: vi.fn<OwnedInputAuthorization['authorize']>(async () => 'allowed'),
  isCurrent: vi.fn(() => true),
});

it('only the constructor-captured dispatcher enters original input; public same-binding work cannot borrow it', async () => {
  const f = fixture();
  expect(f.inputOwner.registerDispatcher).toHaveBeenCalledOnce();
  expect(Object.isFrozen(f.dispatcher())).toBe(true);
  const opened = await f.engine.open({ kind: 'open', requestId, mode: 'ephemeral' });
  const command = {
    kind: 'input',
    requestId,
    binding: opened.tab,
    steps: [{ kind: 'text', text: 'owned' }],
  };
  const auth = authority();
  expect(await f.engine.input(command)).toMatchObject({
    outcome: 'rejected',
    reason: 'policyRefused',
  });
  expect(f.raw.keyboard.insertText).not.toHaveBeenCalled();
  const dispatch = f.dispatcher();
  f.inputOwner.registerDispatcher = vi.fn(() => {
    throw new Error('replacement callback');
  });
  expect(await dispatch.input(command, auth)).toMatchObject({ outcome: 'completed' });
  expect(auth.authorize).toHaveBeenCalled();
  expect(f.raw.keyboard.insertText).toHaveBeenCalledExactlyOnceWith('owned');
  expect(await f.engine.input(command)).toMatchObject({
    outcome: 'rejected',
    reason: 'policyRefused',
  });
});

it('revocation between actual select-all key operations and insertion refuses the unstarted insertion', async () => {
  const f = fixture(),
    auth = authority();
  const opened = await f.engine.open({ kind: 'open', requestId, mode: 'ephemeral' });
  let current = true;
  auth.isCurrent.mockImplementation(() => current);
  f.raw.keyboard.up.mockImplementation(async (...keys: unknown[]) => {
    if (keys[0] === 'Control') current = false;
  });
  const result = await f.dispatcher().input(
    {
      kind: 'input',
      requestId,
      binding: opened.tab,
      steps: [
        { kind: 'keyDown', key: 'Control' },
        { kind: 'keyDown', key: 'Home' },
        { kind: 'keyUp', key: 'Home' },
        { kind: 'keyDown', key: 'Shift' },
        { kind: 'keyDown', key: 'End' },
        { kind: 'keyUp', key: 'End' },
        { kind: 'keyUp', key: 'Shift' },
        { kind: 'keyUp', key: 'Control' },
        { kind: 'text', text: 'must not insert' },
      ],
    },
    auth
  );
  expect(result).toMatchObject({ outcome: 'aborted', reason: 'policyRefused' });
  expect(f.raw.keyboard.down).toHaveBeenCalledWith('Control');
  expect(f.raw.keyboard.down).toHaveBeenCalledWith('End');
  expect(f.raw.keyboard.insertText).not.toHaveBeenCalled();
});

it('queued work keeps its exact original authorization, never borrowing another dispatcher call', async () => {
  const held = deferred<'allowed'>();
  onTestFinished(() => {
    held.resolve('allowed');
  });
  const f = fixture(),
    first = authority(),
    second = authority();
  const opened = await f.engine.open({ kind: 'open', requestId, mode: 'ephemeral' });
  const command = (text: string) => ({
    kind: 'input',
    requestId,
    binding: opened.tab,
    steps: [{ kind: 'text', text }],
  });
  first.authorize.mockReturnValueOnce(held.promise);
  const original = f.dispatcher().input(command('first'), first);
  await tick();
  const competing = f.dispatcher().input(command('second'), second);
  second.isCurrent.mockReturnValue(false);
  held.resolve('allowed');
  expect(await original).toMatchObject({ outcome: 'completed' });
  expect(await competing).toMatchObject({ outcome: 'rejected', reason: 'policyRefused' });
  expect(f.raw.keyboard.insertText).toHaveBeenCalledExactlyOnceWith('first');
  expect(second.authorize).not.toHaveBeenCalled();
});

it('private input preserves the original ordinary engine policy and shutdown fences retained dispatcher', async () => {
  const f = fixture();
  const opened = await f.engine.open({ kind: 'open', requestId, mode: 'ephemeral' });
  const command = {
    kind: 'input',
    requestId,
    binding: opened.tab,
    steps: [{ kind: 'text', text: 'denied' }],
  };
  const ordinary = vi.mocked(f.config.policy.authorizeAction);
  ordinary.mockResolvedValue('refused');
  const auth = authority();
  expect(await f.dispatcher().input(command, auth)).toMatchObject({
    outcome: 'rejected',
    reason: 'policyRefused',
  });
  expect(ordinary).toHaveBeenCalled();
  expect(auth.authorize).not.toHaveBeenCalled();
  expect(f.raw.keyboard.insertText).not.toHaveBeenCalled();
  await f.engine.shutdown();
  expect(() => f.dispatcher().input(command, authority())).toThrow('ENGINE_STOPPED');
});

it('public capture cannot borrow a constructor-owned capture dispatcher with the same binding', async () => {
  const f = fixture();
  const opened = await f.engine.open({ kind: 'open', requestId, mode: 'ephemeral' });
  const command = { kind: 'capture', requestId, binding: opened.tab };
  await expect(f.engine.capture(command)).rejects.toMatchObject({ code: 'POLICY_REFUSED' });
  expect(f.raw.screenshot).not.toHaveBeenCalled();
  await f
    .captureDispatcher()
    .capture(command, { isCurrent: () => true, authorize: async () => 'allowed' });
  expect(f.raw.screenshot).toHaveBeenCalledTimes(1);
  f.raw.screenshot.mockClear();
  await expect(
    f
      .captureDispatcher()
      .capture(command, { isCurrent: () => false, authorize: async () => 'allowed' })
  ).rejects.toMatchObject({ code: 'STALE_BINDING' });
  expect(f.raw.screenshot).not.toHaveBeenCalled();
});
it('an original keyboard method getter can revoke only this Work before any native insertion', async () => {
  const f = fixture();
  const opened = await f.engine.open({ kind: 'open', requestId, mode: 'ephemeral' });
  let admitted = true;
  const insert = f.raw.keyboard.insertText;
  Object.defineProperty(f.raw.keyboard, 'insertText', {
    configurable: true,
    get() {
      admitted = false;
      return insert;
    },
  });
  const result = await f
    .dispatcher()
    .input(
      { kind: 'input', requestId, binding: opened.tab, steps: [{ kind: 'text', text: 'revoked' }] },
      { isCurrent: () => admitted, authorize: async () => 'allowed' }
    );
  expect(result.outcome).not.toBe('completed');
  expect(insert).not.toHaveBeenCalled();
});
