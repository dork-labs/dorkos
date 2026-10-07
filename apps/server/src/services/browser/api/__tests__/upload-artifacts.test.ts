import { expect, it, onTestFinished, afterEach, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  rm,
  rename,
  symlink,
  readFile,
  writeFile,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readdirSync, existsSync, statSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BrowserBinding } from '@dorkos/shared/browser-schemas';
import { BrowserUploadArtifacts } from '../files/upload-artifacts.js';
import { browserFileRefusal } from '../files/file-refusal.js';

const initialization = vi.hoisted(() => ({
  observe: undefined as ((path: string) => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async realpath(...args: Parameters<typeof actual.realpath>) {
      const result = await actual.realpath(...args);
      await initialization.observe?.(String(args[0]));
      return result;
    },
  };
});
afterEach(() => {
  initialization.observe = undefined;
});

const binding: BrowserBinding = {
  browserId: 'browser_upload_fixture_0001',
  browserGeneration: 1,
  tabId: 'tab_upload_fixture_00000001',
  navigationGeneration: 1,
  viewportVersion: 1,
  inputGeneration: 1,
  epoch: 1,
};
async function fixture(release?: () => void) {
  const originals: {
    bank?: BrowserUploadArtifacts;
    home?: string;
    accepted?: Readonly<{ value: unknown }>;
  } = {};
  let closed = false;
  const work = new Set<Promise<unknown>>();
  const own = <T>(original: Promise<T>) => {
    work.add(original);
    void original.then(
      () => work.delete(original),
      () => work.delete(original)
    );
    return original;
  };
  const acquiring = own(
    Promise.resolve().then(() => mkdtemp(join(tmpdir(), 'browser-upload-artifacts-')))
  );
  onTestFinished(async () => {
    closed = true;
    release?.();
    const home = await acquiring;
    await Promise.allSettled([...work]);
    let failure: Readonly<{ value: unknown }> | undefined;
    try {
      await originals.bank?.close();
    } catch (value) {
      failure = { value };
    }
    if (failure) {
      if (!originals.accepted || failure.value !== originals.accepted.value) throw failure.value;
      // Exact negative original cleanup remains uncertain; its private home is deliberately retained.
      return;
    }
    await rm(home, { recursive: true, force: false });
  });
  const rawHome = await acquiring;
  originals.home = rawHome;
  if (closed) throw new Error('UPLOAD_TEST_CLOSED');
  const home = await own(realpath(rawHome));
  if (closed) throw new Error('UPLOAD_TEST_CLOSED');
  const root = join(home, 'stage'),
    protectedRoot = join(home, 'profile');
  await Promise.all([
    own(mkdir(root, { mode: 0o700 })),
    own(mkdir(protectedRoot, { mode: 0o700 })),
  ]);
  if (closed) throw new Error('UPLOAD_TEST_CLOSED');
  const bank = new BrowserUploadArtifacts(root, [protectedRoot]);
  originals.bank = bank;
  const actor = Object.freeze({
      owner: 'fixture_owner',
      credential: Object.freeze({}),
    }),
    current = () => true;
  return {
    bank,
    actor,
    current,
    root,
    protectedRoot,
    own,
    accept: (value: unknown) => {
      originals.accepted = { value };
    },
  };
}
it('copies bytes into exclusive staging and consumes only the exact original actor and binding once', async () => {
  const f = await fixture();
  const source = Buffer.from('private staged content');
  const staged = f.bank.stage(f.actor, binding, 'file.txt', 'text/plain', source, f.current);
  source.fill(0);
  const receipt = await staged;
  expect(() =>
    f.bank.claim(
      { owner: 'different_owner', credential: Object.freeze({}) },
      binding,
      receipt.artifactId,
      f.current
    )
  ).toThrow();
  expect(() =>
    f.bank.claim(f.actor, { ...binding, epoch: 2 }, receipt.artifactId, f.current)
  ).toThrow();
  const lease = f.bank.claim(f.actor, binding, receipt.artifactId, f.current);
  expect(() => f.bank.claim(f.actor, binding, receipt.artifactId, f.current)).toThrow();
  const payload = await lease.consume(new AbortController().signal);
  expect(basename(payload.path)).toBe('file.txt');
  expect(payload.byteLength).toBe(Buffer.byteLength('private staged content'));
  expect((await f.own(readFile(payload.path))).toString()).toBe('private staged content');
  expect(() => lease.consume(new AbortController().signal)).toThrow();
  await lease.close();
});
it('rejects caller paths, unsupported types, oversized bytes and per-browser slot overflow', async () => {
  const f = await fixture();
  for (const name of ['/profile/cookies', '../cookies', 'a/b', 'a\\b', '..'])
    expect(() =>
      f.bank.stage(f.actor, binding, name, 'text/plain', Buffer.from('x'), f.current)
    ).toThrow();
  expect(() =>
    f.bank.stage(f.actor, binding, 'file', 'application/x-executable', Buffer.from('x'), f.current)
  ).toThrow();
  expect(() =>
    f.bank.stage(
      f.actor,
      binding,
      'file',
      'text/plain',
      Buffer.alloc(2 * 1024 * 1024 + 1),
      f.current
    )
  ).toThrow();
  for (let i = 0; i < 8; i++)
    await f.bank.stage(f.actor, binding, 'file.txt', 'text/plain', Buffer.from('x'), f.current);
  expect(() =>
    f.bank.stage(f.actor, binding, 'ninth.txt', 'text/plain', Buffer.from('x'), f.current)
  ).toThrow();
});
it('refuses a changed symlink without reading protected bytes and retains exact failed cleanup', async () => {
  const f = await fixture();
  const receipt = await f.bank.stage(
    f.actor,
    binding,
    'file.txt',
    'text/plain',
    Buffer.from('original'),
    f.current
  );
  const path = join(f.root, receipt.artifactId, 'file.txt');
  await f.own(rename(path, join(f.root, receipt.artifactId, 'retained-original')));
  await f.own(symlink(f.protectedRoot, path));
  const lease = f.bank.claim(f.actor, binding, receipt.artifactId, f.current);
  let reason: Readonly<{ value: unknown }> | undefined;
  try {
    await lease.consume(new AbortController().signal);
  } catch (value) {
    reason = { value };
  }
  expect(reason).toBeDefined();
  // Original consume denial is the bank's first retained cause, not an inferred safe filesystem state.
  f.accept(reason?.value);
  await expect(f.bank.close()).rejects.toBe(reason?.value);
});
it('bank close retains the original entered native file operation before deleting its exclusive staging file', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(() => release());
  const receipt = await f.bank.stage(
    f.actor,
    binding,
    'file.txt',
    'text/plain',
    Buffer.from('original'),
    f.current
  );
  const lease = f.bank.claim(f.actor, binding, receipt.artifactId, f.current);
  const payload = await lease.consume(new AbortController().signal);
  let entered = false;
  const native = lease.enter(async () => {
    entered = true;
    await held;
  });
  await vi.waitFor(() => expect(entered).toBe(true));
  let closed = false;
  const closing = f.bank.close();
  void closing.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect((await f.own(readFile(payload.path))).toString()).toBe('original');
  release();
  await native;
  await closing;
  await expect(f.own(readFile(payload.path))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('refuses same-inode same-length staged content mutation before entering a native file command', async () => {
  const f = await fixture();
  const receipt = await f.bank.stage(
    f.actor,
    binding,
    'file.txt',
    'text/plain',
    Buffer.from('original'),
    f.current
  );
  const lease = f.bank.claim(f.actor, binding, receipt.artifactId, f.current);
  const payload = await lease.consume(new AbortController().signal);
  await f.own(writeFile(payload.path, 'modified'));
  let entered = false,
    reason: Readonly<{ value: unknown }> | undefined;
  try {
    await lease.enter(async () => {
      entered = true;
    });
  } catch (value) {
    reason = { value };
  }
  expect(reason).toBeDefined();
  expect(entered).toBe(false);
  f.accept(reason?.value);
  await expect(f.bank.close()).rejects.toBe(reason?.value);
});

it('retains the original falsy stage failure before independently failed exact-file cleanup', async () => {
  const f = await fixture();
  let changed = false;
  const current = () => {
    if (!changed) {
      const directories = readdirSync(f.root);
      if (directories.length === 1) {
        const path = join(f.root, directories[0], 'file.txt');
        if (existsSync(path) && statSync(path).size > 0) {
          changed = true;
          renameSync(path, join(f.root, directories[0], 'retained-original'));
          writeFileSync(path, 'replacement');
          throw undefined;
        }
      }
    }
    return true;
  };
  const original = f.bank.stage(
    f.actor,
    binding,
    'file.txt',
    'text/plain',
    Buffer.from('original'),
    current
  );
  await expect(original).rejects.toBeUndefined();
  expect(changed).toBe(true);
  f.accept(undefined);
  // The inode mismatch makes independent cleanup fail; its Error cannot replace the original undefined.
  await expect(f.bank.close()).rejects.toBeUndefined();
});

it('closes immediately after construction without entering initialization filesystem producers', async () => {
  const f = await fixture();
  // An entered read of this absent root would genuinely reject; local close must stop before that producer.
  const original = new BrowserUploadArtifacts(join(f.root, 'unstarted'), [f.protectedRoot]);
  onTestFinished(async () => {
    await original.close();
  });
  await expect(original.close()).resolves.toBeUndefined();
  expect(readdirSync(f.root)).toEqual([]);
});
it('joins the exact held initialization read then stops further initialization on local close', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  initialization.observe = async (path) => {
    if (basename(path) === 'stage') {
      entered = true;
      await held;
    }
  };
  const f = await fixture(() => release());
  await vi.waitFor(() => expect(entered).toBe(true));
  const closed = { returned: false };
  const original = f.bank.close();
  void original.then(() => {
    closed.returned = true;
  });
  await Promise.resolve();
  expect(closed.returned).toBe(false);
  release();
  await expect(original).resolves.toBeUndefined();
  expect(readdirSync(f.root)).toEqual([]);
});
it.each([undefined, new Error('original initialization read refused')])(
  'retains original initialization rejection %s after close fences new stages',
  async (reason) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    initialization.observe = async (path) => {
      if (basename(path) === 'stage') {
        entered = true;
        await held;
        throw reason;
      }
    };
    const f = await fixture(() => release());
    await vi.waitFor(() => expect(entered).toBe(true));
    f.accept(reason);
    const original = f.bank.close();
    void original.catch(() => {});
    release();
    await expect(original).rejects.toBe(reason);
    expect(readdirSync(f.root)).toEqual([]);
    await expect(f.bank.close()).rejects.toBe(reason);
  }
);

it('human read copies original bytes without a path and refuses an actor/binding substitution', async () => {
  const f = await fixture();
  const staged = await f.bank.stage(
    f.actor,
    binding,
    'file.txt',
    'text/plain',
    Buffer.from('owned bytes'),
    f.current
  );
  const result = await f.bank.read(
    f.actor,
    binding,
    staged.artifactId,
    f.current,
    new AbortController().signal
  );
  expect(result.bytes.toString()).toBe('owned bytes');
  expect(result).not.toHaveProperty('path');
  result.bytes.fill(0);
  expect(() =>
    f.bank.read(
      { ...f.actor, credential: {} },
      binding,
      staged.artifactId,
      f.current,
      new AbortController().signal
    )
  ).toThrow('inaccessible');
  expect(() =>
    f.bank.read(
      f.actor,
      { ...binding, epoch: 2 },
      staged.artifactId,
      f.current,
      new AbortController().signal
    )
  ).toThrow('inaccessible');
});
it('human read detects a changed staged inode and retains the original failure for cleanup', async () => {
  const f = await fixture();
  const staged = await f.bank.stage(
    f.actor,
    binding,
    'file.txt',
    'text/plain',
    Buffer.from('owned bytes'),
    f.current
  );
  const directories = readdirSync(f.root);
  const directory = join(f.root, directories[0]);
  const original = join(directory, 'file.txt');
  renameSync(original, original + '.retained');
  writeFileSync(original, 'replacement');
  let failure: unknown;
  try {
    await f.bank.read(f.actor, binding, staged.artifactId, f.current, new AbortController().signal);
  } catch (value) {
    failure = value;
    f.accept(value);
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('inaccessible');
  let later: unknown;
  try {
    f.bank.read(f.actor, binding, staged.artifactId, f.current, new AbortController().signal);
  } catch (value) {
    later = value;
  }
  expect(later).toBe(failure);
});

it('losing current authority during staging does not poison a later authorized stage and read', async () => {
  const f = await fixture();
  const denied = f.bank.stage(
    f.actor,
    binding,
    'denied.txt',
    'text/plain',
    Buffer.from('denied'),
    () => false
  );
  await expect(denied).rejects.toThrow('inaccessible');
  const next = await f.bank.stage(
    f.actor,
    binding,
    'next.txt',
    'text/plain',
    Buffer.from('next'),
    f.current
  );
  const read = await f.bank.read(
    f.actor,
    binding,
    next.artifactId,
    f.current,
    new AbortController().signal
  );
  expect(read.bytes.toString()).toBe('next');
  read.bytes.fill(0);
});
it.each([false, undefined])(
  'an arbitrary original read producer failure %s remains sticky across another authorized artifact',
  async (value) => {
    const f = await fixture();
    const first = await f.bank.stage(
      f.actor,
      binding,
      'first.txt',
      'text/plain',
      Buffer.from('first'),
      f.current
    );
    const second = await f.bank.stage(
      f.actor,
      binding,
      'second.txt',
      'text/plain',
      Buffer.from('second'),
      f.current
    );
    initialization.observe = async (path) => {
      if (path === join(f.root, first.artifactId)) throw value;
    };
    f.accept(value);
    await expect(
      f.bank.read(f.actor, binding, first.artifactId, f.current, new AbortController().signal)
    ).rejects.toBe(value);
    initialization.observe = undefined;
    let retained: Readonly<{ value: unknown }> | undefined;
    try {
      f.bank.read(f.actor, binding, second.artifactId, f.current, new AbortController().signal);
    } catch (reason) {
      retained = { value: reason };
    }
    expect(retained).toEqual({ value });
    await expect(f.bank.close()).rejects.toBe(value);
  }
);

it('original private cancellation refuses a held read only; IO throwing the same token later remains sticky', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(() => release());
  const first = await f.bank.stage(
    f.actor,
    binding,
    'first.txt',
    'text/plain',
    Buffer.from('first'),
    f.current
  );
  const second = await f.bank.stage(
    f.actor,
    binding,
    'second.txt',
    'text/plain',
    Buffer.from('second'),
    f.current
  );
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  initialization.observe = async (path) => {
    if (path === join(f.root, first.artifactId)) {
      entered();
      await held;
    }
  };
  const controller = new AbortController(),
    reason = browserFileRefusal('inaccessible');
  const read = f.bank.read(f.actor, binding, first.artifactId, f.current, controller.signal);
  void read.catch(() => {});
  await started;
  controller.abort(reason);
  release();
  await expect(read).rejects.toBe(reason);
  initialization.observe = undefined;
  const authorized = await f.bank.read(
    f.actor,
    binding,
    second.artifactId,
    f.current,
    new AbortController().signal
  );
  expect(authorized.bytes.toString()).toBe('second');
  authorized.bytes.fill(0);
  initialization.observe = async (path) => {
    if (path === join(f.root, second.artifactId)) throw reason;
  };
  f.accept(reason);
  await expect(
    f.bank.read(f.actor, binding, second.artifactId, f.current, new AbortController().signal)
  ).rejects.toBe(reason);
  initialization.observe = undefined;
  await expect(f.bank.close()).rejects.toBe(reason);
});
it('a one-use upload consume cancellation preserves independent other-artifact access', async () => {
  const f = await fixture();
  const first = await f.bank.stage(
    f.actor,
    binding,
    'first.txt',
    'text/plain',
    Buffer.from('first'),
    f.current
  );
  const second = await f.bank.stage(
    f.actor,
    binding,
    'second.txt',
    'text/plain',
    Buffer.from('second'),
    f.current
  );
  const lease = f.bank.claim(f.actor, binding, first.artifactId, f.current);
  const signal = new AbortController(),
    reason = browserFileRefusal('inaccessible');
  signal.abort(reason);
  await expect(lease.consume(signal.signal)).rejects.toBe(reason);
  await lease.close();
  const authorized = await f.bank.read(
    f.actor,
    binding,
    second.artifactId,
    f.current,
    new AbortController().signal
  );
  expect(authorized.bytes.toString()).toBe('second');
  authorized.bytes.fill(0);
});
