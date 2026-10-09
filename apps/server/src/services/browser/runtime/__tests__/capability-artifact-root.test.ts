import { it, expect, onTestFinished, vi } from 'vitest';
import { lstat, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const controls = vi.hoisted(() => ({
  failure: undefined as 'realpath' | 'lstat' | undefined,
  raw: undefined as string | undefined,
  holdRealpath: undefined as (() => Promise<void>) | undefined,
  captureRaw: undefined as ((raw: string) => void) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    mkdtemp: async (...args: Parameters<typeof original.mkdtemp>) => {
      const raw = await original.mkdtemp(...args);
      controls.raw = typeof raw === 'string' ? raw : undefined;
      if (typeof raw === 'string') controls.captureRaw?.(raw);
      return raw;
    },
    realpath: async (...args: Parameters<typeof original.realpath>) => {
      if (controls.failure === 'realpath') {
        controls.failure = undefined;
        throw undefined;
      }
      await controls.holdRealpath?.();
      return original.realpath(...args);
    },
    lstat: async (...args: Parameters<typeof original.lstat>) => {
      if (controls.failure === 'lstat') {
        controls.failure = undefined;
        throw undefined;
      }
      return original.lstat(...args);
    },
  };
});
import { createCapabilityArtifactRoot } from '../capability-artifact-root.js';

it('joins original artifact release before removing its genuine private root', async () => {
  const owner = createCapabilityArtifactRoot();
  const bank: { original?: Promise<void>; release?: () => void } = {};
  const release = () => {
    const original = bank.release;
    bank.release = undefined;
    original?.();
  };
  onTestFinished(async () => {
    release();
    await (bank.original ?? owner.close(async () => {}));
  });
  const acquiring = owner.acquire();
  const root = await acquiring;
  const held = new Promise<void>((done) => {
    bank.release = done;
  });
  const originalRelease = vi.fn(() => held);
  let closed = false;
  const original = (bank.original = owner.close(originalRelease));
  void original.then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(originalRelease).toHaveBeenCalledTimes(1);
  expect(closed).toBe(false);
  expect((await lstat(root.directory)).isDirectory()).toBe(true);
  release();
  await original;
  await expect(lstat(root.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('retains the original root and exact undefined when the original release fails', async () => {
  const owner = createCapabilityArtifactRoot();
  const bank: {
    acquiring?: ReturnType<typeof owner.acquire>;
    original?: Promise<void>;
  } = {};
  onTestFinished(async () => {
    await (bank.original ?? owner.close(async () => {})).catch((value) => {
      if (value !== undefined) throw value;
    });
    if (bank.acquiring && bank.original) {
      const root = await bank.acquiring;
      // Only this test's original root, after the exact failed close has joined.
      await rmdir(root.directory);
    }
  });
  bank.acquiring = owner.acquire();
  const root = await bank.acquiring;
  bank.original = owner.close(async () => {
    throw undefined;
  });
  await expect(bank.original).rejects.toBeUndefined();
  const retained = await lstat(root.directory);
  expect(retained.dev).toBe(root.dev);
  expect(retained.ino).toBe(root.ino);
});

it.each(['realpath', 'lstat'] as const)(
  'preserves unknown original %s acquisition and does not remove a later replacement',
  async (failure) => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const bank: {
      raw?: string;
      saved?: string;
      replacement?: string;
      linked: boolean;
      closed: boolean;
      acquisition?: ReturnType<ReturnType<typeof createCapabilityArtifactRoot>['acquire']>;
      closing?: Promise<void>;
    } = { linked: false, closed: false };
    const entered = new Set<Promise<unknown>>();
    const closedAdmission = Object.freeze({});
    const own = <T>(producer: () => Promise<T>): Promise<T> => {
      const original = Promise.resolve().then(() => {
        if (bank.closed) throw closedAdmission;
        return producer();
      });
      entered.add(original);
      void original.catch(() => {});
      return original;
    };
    const owner = createCapabilityArtifactRoot();
    onTestFinished(async () => {
      bank.closed = true;
      controls.failure = undefined;
      let first: Readonly<{ value: unknown }> | undefined;
      const expected = [
        ...(bank.acquisition ? [bank.acquisition] : []),
        bank.closing ?? owner.close(async () => {}),
      ];
      for (const result of await Promise.allSettled(expected))
        if (result.status === 'rejected' && result.reason !== undefined)
          first ??= { value: result.reason };
      for (const result of await Promise.allSettled([...entered]))
        if (result.status === 'rejected' && result.reason !== closedAdmission)
          first ??= { value: result.reason };
      controls.captureRaw = undefined;
      // All entered original filesystem returns are joined before removing test-owned paths.
      const cleanup = [
        Promise.resolve().then(async () => {
          if (bank.raw) {
            if (bank.linked) await fs.unlink(bank.raw);
            else if (!bank.saved) await fs.rmdir(bank.raw);
          }
        }),
        Promise.resolve().then(async () => {
          if (bank.saved) await fs.rmdir(bank.saved);
        }),
        Promise.resolve().then(async () => {
          if (bank.replacement) await fs.rmdir(bank.replacement);
        }),
      ];
      for (const result of await Promise.allSettled(cleanup))
        if (result.status === 'rejected') first ??= { value: result.reason };
      if (first) throw first.value;
    });
    controls.raw = undefined;
    controls.captureRaw = (raw) => {
      bank.raw = raw;
    };
    controls.failure = failure;
    bank.acquisition = owner.acquire();
    await expect(bank.acquisition).rejects.toBeUndefined();
    if (!bank.raw) throw new Error('ORIGINAL_ROOT_NOT_ENTERED');
    const raw = bank.raw,
      saved = raw + '-retained';
    await own(async () => {
      await fs.rename(raw, saved);
      bank.saved = saved;
    });
    const replacementRaw = await own(async () => {
      const original = await fs.mkdtemp(join(tmpdir(), 'artifact-root-replacement-'));
      bank.replacement = original;
      return original;
    });
    const replacement = await own(() => fs.realpath(replacementRaw));
    const identity = await own(() => fs.lstat(replacement));
    await own(async () => {
      await fs.symlink(replacement, raw);
      bank.linked = true;
    });
    if (bank.closed) throw closedAdmission;
    const release = vi.fn(async () => {});
    bank.closing = owner.close(release);
    await expect(bank.closing).rejects.toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
    const retained = await own(() => fs.lstat(replacement));
    expect({ dev: retained.dev, ino: retained.ino }).toEqual({
      dev: identity.dev,
      ino: identity.ino,
    });
    expect((await own(() => fs.lstat(saved))).isDirectory()).toBe(true);
  }
);

it('refuses a successful canonical lookup of a substituted foreign directory', async () => {
  const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  const owner = createCapabilityArtifactRoot();
  const bank: {
    raw?: string;
    saved?: string;
    foreign?: string;
    linked: boolean;
    closed: boolean;
    release?: () => void;
    acquiring?: ReturnType<typeof owner.acquire>;
    closing?: Promise<void>;
    expected?: unknown;
  } = { linked: false, closed: false };
  const entered = new Set<Promise<unknown>>();
  const closedAdmission = Object.freeze({});
  const release = () => {
    const original = bank.release;
    bank.release = undefined;
    original?.();
  };
  const own = <T>(producer: () => Promise<T>) => {
    const original = Promise.resolve().then(() => {
      if (bank.closed) throw closedAdmission;
      return producer();
    });
    entered.add(original);
    void original.catch(() => {});
    return original;
  };
  onTestFinished(async () => {
    bank.closed = true;
    release();
    controls.holdRealpath = undefined;
    controls.captureRaw = undefined;
    let first: Readonly<{ value: unknown }> | undefined;
    for (const result of await Promise.allSettled([
      ...(bank.acquiring ? [bank.acquiring] : []),
      bank.closing ?? owner.close(async () => {}),
    ]))
      if (result.status === 'rejected' && result.reason !== bank.expected)
        first ??= { value: result.reason };
    for (const result of await Promise.allSettled([...entered]))
      if (result.status === 'rejected' && result.reason !== closedAdmission)
        first ??= { value: result.reason };
    for (const result of await Promise.allSettled([
      Promise.resolve().then(async () => {
        if (bank.raw) {
          if (bank.linked) await fs.unlink(bank.raw);
          else if (!bank.saved) await fs.rmdir(bank.raw);
        }
      }),
      Promise.resolve().then(async () => {
        if (bank.saved) await fs.rmdir(bank.saved);
      }),
      Promise.resolve().then(async () => {
        if (bank.foreign) await fs.rmdir(bank.foreign);
      }),
    ]))
      if (result.status === 'rejected') first ??= { value: result.reason };
    if (first) throw first.value;
  });
  const held = new Promise<void>((resolve) => {
    bank.release = resolve;
  });
  let resolveArriving!: () => void;
  const arriving = {
    promise: new Promise<void>((resolve) => {
      resolveArriving = resolve;
    }),
    resolve: () => resolveArriving(),
  };
  controls.captureRaw = (raw) => {
    bank.raw = raw;
  };
  controls.holdRealpath = async () => {
    arriving.resolve();
    await held;
  };
  bank.acquiring = owner.acquire();
  void bank.acquiring.catch(() => {});
  await arriving.promise;
  if (!bank.raw) throw new Error('ORIGINAL_ROOT_NOT_ENTERED');
  const raw = bank.raw;
  await own(async () => {
    const saved = raw + '-original';
    await fs.rename(raw, saved);
    bank.saved = saved;
  });
  const foreign = await own(async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'artifact-root-foreign-'));
    bank.foreign = directory;
    return directory;
  });
  const originalForeign = await own(() => fs.lstat(foreign));
  await own(async () => {
    await fs.symlink(foreign, raw);
    bank.linked = true;
  });
  release();
  const outcome = await bank.acquiring.then(
    (value) => ({ ok: true as const, value }),
    (reason) => ({ ok: false as const, reason })
  );
  expect(outcome.ok).toBe(false);
  if (outcome.ok) throw new Error('SUBSTITUTED_ROOT_ACCEPTED');
  expect(outcome.reason).toBeInstanceOf(Error);
  expect((outcome.reason as Error).message).toBe('BROWSER_ARTIFACT_ROOT_REFUSED');
  bank.expected = outcome.reason;
  bank.closing = owner.close(async () => {});
  await expect(bank.closing).rejects.toBe(bank.expected);
  const retained = await own(() => fs.lstat(foreign));
  expect({ dev: retained.dev, ino: retained.ino }).toEqual({
    dev: originalForeign.dev,
    ino: originalForeign.ino,
  });
  expect((await own(() => fs.lstat(bank.saved!))).isDirectory()).toBe(true);
});
