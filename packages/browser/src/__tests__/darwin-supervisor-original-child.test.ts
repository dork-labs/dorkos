import type { SupervisorOriginalChild } from '../runtime/darwin-supervisor-protocol.js';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { configuration } from './parent-fixture.js';
import { launchDarwinSupervisorBrowser } from '../runtime/darwin-supervisor-browser.js';

const original = vi.hoisted(() => ({
  connect: vi.fn(),
  identity: vi.fn(),
  cohort: vi.fn(),
  completion: vi.fn(),
  kill: vi.fn(),
  child: undefined as unknown as EventEmitter,
}));
vi.mock('../runtime/public-library.js', () => ({
  verifiedLibrary: async () => ({ connectOverCDP: original.connect }),
}));
vi.mock('../profiles/owned-directory.js', () => ({
  ownDirectory: (path: string) => Object.freeze({ path, dev: 1, ino: path }),
  assertDirectory: () => {},
}));
vi.mock('node:fs/promises', async (load) => ({
  ...(await load<typeof import('node:fs/promises')>()),
  lstat: async () => {
    throw Object.assign(new Error('absent'), { code: 'ENOENT' });
  },
}));
vi.mock('../runtime/darwin-engine-processes.js', () => ({
  createDarwinEngineProcesses: () => ({
    identity: original.identity,
    processes: { descendants: original.cohort },
  }),
}));
vi.mock('../runtime/darwin-owned-child.js', () => ({
  createDarwinOwnedChildLauncher: () => ({
    launch: async () => ({
      child: Object.assign(original.child, { kill: original.kill }),
      identity: async () => ({ pid: 123, birth: 'original-root' }),
      completion: original.completion,
    }),
  }),
  acceptsDarwinOwnedChildReturn: () => false,
}));

it.each([undefined, false])(
  'captures actual launcher child before CDP and joins cleanup after original observer rejects %s',
  async (failure) => {
    let release!: () => void,
      entered!: () => void,
      returned!: () => void,
      completionEntered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entering = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const returnHeld = new Promise<void>((resolve) => {
      returned = resolve;
    });
    const returning = new Promise<void>((resolve) => {
      completionEntered = resolve;
    });
    original.child = new EventEmitter();
    original.connect.mockClear();
    original.kill.mockClear();
    original.identity.mockResolvedValue({
      pid: process.pid,
      birth: 'original-supervisor',
    });
    original.cohort.mockResolvedValue({
      status: 'complete',
      identities: [
        { pid: 123, birth: 'original-root' },
        { pid: 124, birth: 'original-descendant' },
      ],
    });
    original.completion.mockImplementation(async () => {
      completionEntered();
      await returnHeld;
    });
    const observe = vi.fn(async (value: SupervisorOriginalChild) => {
      expect(value.complete).toBe(true);
      expect(value.identities).toEqual([
        { pid: 123, birth: 'original-root' },
        { pid: 124, birth: 'original-descendant' },
      ]);
      expect(value.manager).toEqual({ pid: 12, birth: 'original-manager' });
      expect(Object.isFrozen(value.identities)).toBe(true);
      entered();
      await held;
      throw failure;
    });
    const starting = launchDarwinSupervisorBrowser(
      {
        manager: { pid: 12, birth: 'original-manager' },
        runtime: configuration().runtime,
        artifact: { path: '/private/not-executed', sha256: 'a'.repeat(64) },
        profileDir: '/private/original-child-' + String(failure),
        origin: 'about:blank',
        ownedProxy: {
          url: 'http://127.0.0.1:1234',
          credentials: { username: 'dorkos', password: 'fixture' },
        },
      },
      () => {},
      undefined,
      observe
    );
    const outcome = starting.then(
      () => ({ rejected: false, value: undefined }),
      (value) => ({ rejected: true, value })
    );
    try {
      await entering;
      expect(original.connect).not.toHaveBeenCalled();
      release();
      await returning;
      expect(original.kill).toHaveBeenCalledWith('SIGTERM');
      let settled = false;
      void outcome.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      returned();
      expect(await outcome).toEqual({ rejected: true, value: failure });
      expect(original.connect).not.toHaveBeenCalled();
    } finally {
      release();
      returned();
      await outcome;
      original.child.removeAllListeners();
    }
  }
);
