import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extensionDecisions } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { createDataProviderContext } from '../extension-server-api-factory.js';
import { RegistrationCustody } from '../server-lifecycle/registration-custody.js';
import { KnownProjectsStore } from '../../projects/known-projects-store.js';
import { ProjectRegistry, projectRegistry } from '../../projects/project-registry.js';
import { projectSettingsStore } from '../inbox/extension-project-settings.js';
import { ExtensionInboxService, setExtensionInbox } from '../inbox/extension-inbox.js';
import { setContinuationRecorder } from '../../core/usage/session-continuation.js';
import { ExtensionSettingsStore } from '@dorkos/shared/extension-settings';
import { withFileLock } from '@dorkos/shared/atomic-write';
import * as atomicWrite from '@dorkos/shared/atomic-write';
import { eventFanOut } from '../../core/event-fan-out.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/event-fan-out.js', () => ({ eventFanOut: { broadcast: vi.fn() } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  setContinuationRecorder(undefined);
  setExtensionInbox(null);
});

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'context-occurrence-'));
  const bank = new RegistrationCustody();
  const occurrence = bank.begin('owned');
  const built = createDataProviderContext({
    extensionId: 'owned',
    extensionDir: home,
    dorkHome: home,
    requireCurrent: () => occurrence.requireCurrent(),
    ownOriginal: (enter) => occurrence.runOriginal(enter),
  });
  return {
    ...built,
    home,
    occurrence,
    bank,
    async close() {
      try {
        await occurrence.retire([built.dispose]);
      } finally {
        await fs.rm(home, { recursive: true, force: true });
      }
    },
  };
}

function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const original = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { original, resolve, reject };
}

describe('originating server context', () => {
  it.each(['accounts', 'projects', 'inbox', 'settings', 'project-settings'] as const)(
    'joins held original %s but refuses its result after retirement',
    async (kind) => {
      const gate = held<void>();
      let entered = false;
      const enter = async () => {
        entered = true;
        await gate.original;
      };
      vi.spyOn(ExtensionSettingsStore.prototype, 'getAll').mockImplementation(async () => {
        await enter();
        return {};
      });
      const f = await fixture();
      const db = createTestDb();
      const inbox = new ExtensionInboxService({ db, projects: projectRegistry, dorkHome: f.home });
      setExtensionInbox(inbox);
      setContinuationRecorder(enter);
      vi.spyOn(projectRegistry, 'listForExtension').mockImplementation(async () => {
        await enter();
        return [];
      });
      vi.spyOn(projectRegistry, 'resolveWithin').mockResolvedValue({ root: '/repo', name: 'repo' });
      vi.spyOn(projectSettingsStore(f.home), 'read').mockImplementation(async () => {
        await enter();
        return null;
      });
      vi.spyOn(inbox, 'record').mockImplementation(enter);
      const original =
        kind === 'accounts'
          ? f.ctx.accounts.markContinued('old', {
              sessionId: 'new',
              runtime: 'claude-code',
              accountId: 'default',
            })
          : kind === 'projects'
            ? f.ctx.projects.list()
            : kind === 'settings'
              ? f.ctx.settings.getAll()
              : kind === 'project-settings'
                ? f.ctx.projectSettings.get('/repo')
                : f.ctx.inbox.record({
                    key: 'done',
                    title: 'Done',
                    why: 'The work finished.',
                    outcome: 'approved',
                    by: { kind: 'rule', label: 'Test' },
                  });
      let settled = false;
      const observed = original.then(
        () => {
          settled = true;
          return { ok: true };
        },
        (value) => {
          settled = true;
          return { value };
        }
      );
      try {
        // Settings first traverses the genuine project-resolution facade.
        for (let i = 0; i < 8 && !entered; i++) await Promise.resolve();
        expect(entered).toBe(true);
        const closing = f.occurrence.retire([f.dispose]);
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(f.bank.permits('owned')).toBe(false);
        expect(settled).toBe(false);
        gate.resolve();
        await closing;
        expect(await observed).toEqual({
          value: expect.objectContaining({ message: expect.stringContaining('retired') }),
        });
      } finally {
        gate.resolve();
        await Promise.allSettled([original]);
        inbox.stop();
        db.$client.close();
        await f.close();
      }
    }
  );

  it.each(['raise', 'record'] as const)(
    'refuses the real inbox %s tail after held project resolution',
    async (kind) => {
      const f = await fixture();
      const db = createTestDb();
      const gate = held<{ root: string; name: string } | null>();
      let entered = false;
      const projects = {
        report: async () => {
          entered = true;
          return gate.original;
        },
        get: projectRegistry.get.bind(projectRegistry),
        resolveWithin: projectRegistry.resolveWithin.bind(projectRegistry),
        listForExtension: projectRegistry.listForExtension.bind(projectRegistry),
      };
      const inbox = new ExtensionInboxService({ db, projects, dorkHome: f.home });
      setExtensionInbox(inbox);
      const input = { key: 'held', project: '/repo', title: 'Finished', why: 'The work finished.' };
      const original =
        kind === 'raise'
          ? f.ctx.inbox.raise({
              ...input,
              actions: { kind: 'yes-no', approveLabel: 'Yes', rejectLabel: 'No' },
            })
          : f.ctx.inbox.record({
              ...input,
              outcome: 'approved',
              by: { kind: 'rule', label: 'Test' },
            });
      const observed = original.then(
        () => ({ ok: true }),
        (value) => ({ value })
      );
      try {
        expect(entered).toBe(true);
        const closing = f.occurrence.retire([f.dispose]);
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(f.bank.permits('owned')).toBe(false);
        expect(db.select().from(extensionDecisions).all()).toEqual([]);
        gate.resolve({ root: '/repo', name: 'repo' });
        await closing;
        expect(await observed).toEqual({
          value: expect.objectContaining({ message: expect.stringContaining('retired') }),
        });
        expect(db.select().from(extensionDecisions).all()).toEqual([]);
        expect(eventFanOut.broadcast).not.toHaveBeenCalled();
      } finally {
        gate.resolve(null);
        await Promise.allSettled([original]);
        inbox.stop();
        db.$client.close();
        await f.close();
      }
    }
  );

  it('does not write settings after waiting for an original file lock during retirement', async () => {
    const f = await fixture();
    const gate = held<void>();
    const entered = held<void>();
    const file = path.join(f.home, 'extension-settings/owned.json');
    const holder = withFileLock(file, async (write) => {
      entered.resolve();
      await gate.original;
      await write(JSON.stringify({ original: true }));
    });
    let original: Promise<void> | undefined;
    try {
      await entered.original;
      original = f.ctx.settings.set('late', true);
      const observed = original.then(
        () => ({ ok: true }),
        (value) => ({ value })
      );
      const closing = f.occurrence.retire([f.dispose]);
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(f.bank.permits('owned')).toBe(false);
      gate.resolve();
      await holder;
      await closing;
      expect(await observed).toEqual({
        value: expect.objectContaining({ message: expect.stringContaining('retired') }),
      });
      expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ original: true });
    } finally {
      gate.resolve();
      await Promise.allSettled([holder, ...(original ? [original] : [])]);
      await f.close();
    }
  });

  it.each(['resolve', 'report'] as const)(
    'refuses the real project %s write after the original origin read',
    async (kind) => {
      const f = await fixture();
      const db = createTestDb();
      const store = new KnownProjectsStore(db);
      const gate = held<string | null>();
      const entered = held<void>();
      const registry = new ProjectRegistry({
        checkBoundary: async (dir) => dir,
        resolveRoot: async (dir) => dir,
        readOriginRepo: () => {
          entered.resolve();
          return gate.original;
        },
      });
      registry.attachStore(store);
      const original = f.occurrence.runOriginal(() =>
        kind === 'report'
          ? registry.report('/repo', 'owned', () => f.occurrence.requireCurrent())
          : registry.resolveWithin('/repo', 'owned', () => f.occurrence.requireCurrent())
      );
      const observed = original.then(
        () => ({ ok: true }),
        (value) => ({ value })
      );
      try {
        await entered.original;
        const closing = f.occurrence.retire([f.dispose]);
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(f.bank.permits('owned')).toBe(false);
        gate.resolve(null);
        await closing;
        expect(await observed).toEqual({
          value: expect.objectContaining({ message: expect.stringContaining('retired') }),
        });
        expect(store.all()).toEqual([]);
        expect(store.reporters()).toEqual([]);
      } finally {
        gate.resolve(null);
        await Promise.allSettled([original]);
        db.$client.close();
        await f.close();
      }
    }
  );

  it('refuses new agent and session producers as soon as original retirement enters', async () => {
    const f = await fixture();
    try {
      await f.occurrence.retire([]);
      await expect(f.ctx.agent.send({ to: 's', text: 't', idempotencyKey: 'k' })).rejects.toThrow(
        'retired'
      );
      await expect(
        f.ctx.sessions.start({ project: '/repo', prompt: 'p', title: 't', reason: 'r' })
      ).rejects.toThrow('retired');
    } finally {
      f.dispose();
      await f.close();
    }
  });

  it('publishes a held current facade result and preserves ordinary storage and emit', async () => {
    const f = await fixture();
    const gate = held<void>();
    const list = vi.spyOn(projectRegistry, 'listForExtension').mockImplementation(async () => {
      await gate.original;
      return [];
    });
    const original = f.ctx.projects.list();
    const observed = original.then((value) => ({ value }));
    try {
      gate.resolve();
      expect(await observed).toEqual({ value: [] });
      expect(list).toHaveBeenCalledWith('owned');
      await f.ctx.storage.saveData({ current: true });
      expect(await f.ctx.storage.loadData()).toEqual({ current: true });
      f.ctx.emit('current', { ok: true });
      expect(eventFanOut.broadcast).toHaveBeenCalledWith('ext:owned:current', { ok: true });
    } finally {
      gate.resolve();
      await Promise.allSettled([original]);
      await f.close();
    }
  });

  it.each([false, undefined])('does not replace an original held failure %s', async (value) => {
    const f = await fixture();
    const gate = held<void>();
    setContinuationRecorder(() => gate.original);
    const original = f.ctx.accounts.markContinued('old', {
      sessionId: 'new',
      runtime: 'claude-code',
      accountId: 'default',
    });
    const observed = original.then(
      () => ({ ok: true }),
      (cause) => ({ value: cause })
    );
    try {
      const closing = f.occurrence.retire([f.dispose]);
      gate.reject(value);
      await closing;
      expect(await observed).toEqual({ value });
    } finally {
      gate.resolve();
      await Promise.allSettled([original]);
      await f.close();
    }
  });

  it('refuses retired emit, storage and later scheduled entry without claiming cancellation', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const task = vi.fn(async () => undefined);
    try {
      await f.ctx.storage.saveData({ original: true });
      f.ctx.schedule(5, task);
      // Retirement need not have completed disposer execution to fence callbacks.
      await f.occurrence.retire([]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(task).not.toHaveBeenCalled();
      expect(() => f.ctx.emit('late', { secret: true })).toThrow('retired');
      expect(eventFanOut.broadcast).not.toHaveBeenCalled();
      await expect(f.ctx.storage.saveData({ late: true })).rejects.toThrow('retired');
      await expect(f.ctx.storage.loadData()).rejects.toThrow('retired');
      expect(
        JSON.parse(await fs.readFile(path.join(f.home, 'extension-data/owned/data.json'), 'utf8'))
      ).toEqual({ original: true });
    } finally {
      f.dispose();
      await f.close();
    }
  });

  it.each(['load', 'save'] as const)(
    'joins an entered storage %s before refusing its retired result',
    async (kind) => {
      const f = await fixture();
      const gate = held<void>();
      await f.ctx.storage.saveData({ original: true });
      const read = fs.readFile.bind(fs);
      const write = atomicWrite.writeFileAtomic;
      if (kind === 'load')
        vi.spyOn(fs, 'readFile').mockImplementationOnce(async (...args) => {
          await gate.original;
          return read(...args);
        });
      else
        vi.spyOn(atomicWrite, 'writeFileAtomic').mockImplementationOnce(async (...args) => {
          await gate.original;
          await write(...args);
        });
      const original =
        kind === 'load' ? f.ctx.storage.loadData() : f.ctx.storage.saveData({ entered: true });
      let settled = false;
      const observed = original.then(
        () => {
          settled = true;
          return { ok: true };
        },
        (value) => {
          settled = true;
          return { value };
        }
      );
      try {
        const closing = f.occurrence.retire([f.dispose]);
        for (let i = 0; i < 8; i++) await Promise.resolve();
        expect(f.bank.permits('owned')).toBe(false);
        expect(settled).toBe(false);
        gate.resolve();
        await closing;
        expect(await observed).toEqual({
          value: expect.objectContaining({ message: expect.stringContaining('retired') }),
        });
        // The entered write completed; refusal never claims it was cancelled.
        if (kind === 'save')
          expect(
            JSON.parse(await read(path.join(f.home, 'extension-data/owned/data.json'), 'utf8'))
          ).toEqual({ entered: true });
      } finally {
        gate.resolve();
        await Promise.allSettled([original]);
        await f.close();
      }
    }
  );

  it('joins a held scheduled callback and fences its continuation', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const gate = held<void>();
    let returned = false;
    let original: Promise<void> | undefined;
    try {
      f.ctx.schedule(5, () => {
        original = (async () => {
          await gate.original;
          returned = true;
          f.ctx.emit('late', {});
        })();
        return original;
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(original).toBeDefined();
      const closing = f.occurrence.retire([f.dispose]);
      expect(returned).toBe(false);
      gate.resolve();
      await closing;
      if (original) await Promise.allSettled([original]);
      expect(returned).toBe(true);
      expect(eventFanOut.broadcast).not.toHaveBeenCalled();
    } finally {
      gate.resolve();
      if (original) await Promise.allSettled([original]);
      await f.close();
    }
  });

  it('checks storage after serialization reenters retirement', async () => {
    const f = await fixture();
    let closing: Promise<void> | undefined;
    try {
      await expect(
        f.ctx.storage.saveData({
          toJSON() {
            closing = f.occurrence.retire([]);
            return { late: true };
          },
        })
      ).rejects.toThrow('retired');
      await expect(
        fs.stat(path.join(f.home, 'extension-data/owned/data.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (closing) await closing;
      f.dispose();
      await f.close();
    }
  });
});
