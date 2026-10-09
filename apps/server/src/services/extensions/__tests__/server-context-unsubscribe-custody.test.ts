import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { createDataProviderContext } from '../extension-server-api-factory.js';
import { projectRegistry } from '../../projects/project-registry.js';
import { projectSettingsStore } from '../inbox/extension-project-settings.js';
import { ExtensionInboxService, setExtensionInbox } from '../inbox/extension-inbox.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/event-fan-out.js', () => ({ eventFanOut: { broadcast: vi.fn() } }));

function failureOf(enter: () => void): { value: unknown } | undefined {
  try {
    enter();
  } catch (value) {
    return { value };
  }
  return undefined;
}

describe('original leaf unsubscribe custody', () => {
  it.each([false, undefined])(
    'retains manual project unsubscribe failure %s through dispose',
    async (value) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'project-unsubscribe-'));
      const failed = vi.fn(() => {
        throw value;
      });
      const other = vi.fn();
      vi.spyOn(projectRegistry, 'onChange').mockReturnValueOnce(failed).mockReturnValueOnce(other);
      const f = createDataProviderContext({
        extensionId: 'owned',
        extensionDir: home,
        dorkHome: home,
      });
      try {
        const unsubscribe = f.ctx.projects.onChange(() => {});
        f.ctx.projects.onChange(() => {});
        expect(failureOf(unsubscribe)).toEqual({ value });
        expect(failureOf(f.dispose)).toEqual({ value });
        expect(failed).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
        expect(failureOf(f.dispose)).toEqual({ value });
        expect(failed).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
      } finally {
        failureOf(f.dispose);
        vi.restoreAllMocks();
        await fs.rm(home, { recursive: true, force: true });
      }
    }
  );

  it.each([false, undefined])(
    'retains manual settings unsubscribe failure %s through dispose',
    async (value) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-unsubscribe-'));
      const failed = vi.fn(() => {
        throw value;
      });
      const other = vi.fn();
      vi.spyOn(projectSettingsStore(home), 'onChange')
        .mockReturnValueOnce(failed)
        .mockReturnValueOnce(other);
      const f = createDataProviderContext({
        extensionId: 'owned',
        extensionDir: home,
        dorkHome: home,
      });
      try {
        const unsubscribe = f.ctx.projectSettings.onChange(() => {});
        f.ctx.projectSettings.onChange(() => {});
        expect(failureOf(unsubscribe)).toEqual({ value });
        expect(failureOf(f.dispose)).toEqual({ value });
        expect(failed).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
        expect(failureOf(f.dispose)).toEqual({ value });
        expect(failed).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
      } finally {
        failureOf(f.dispose);
        vi.restoreAllMocks();
        await fs.rm(home, { recursive: true, force: true });
      }
    }
  );

  it.each([false, undefined])(
    'retains manual inbox unsubscribe failure %s and joins independent settings cleanup',
    async (value) => {
      const home = await fs.mkdtemp(path.join(os.tmpdir(), 'inbox-unsubscribe-'));
      const db = createTestDb();
      const service = new ExtensionInboxService({ db, projects: projectRegistry, dorkHome: home });
      setExtensionInbox(service);
      const failed = vi.fn(() => {
        throw value;
      });
      const other = vi.fn();
      const register = vi.spyOn(service, 'setHandler').mockReturnValue(failed);
      vi.spyOn(projectSettingsStore(home), 'onChange').mockReturnValue(other);
      const f = createDataProviderContext({
        extensionId: 'owned',
        extensionDir: home,
        dorkHome: home,
      });
      try {
        const unsubscribe = f.ctx.inbox.onAction(async () => ({ resolve: 'answered' }));
        f.ctx.projectSettings.onChange(() => {});
        expect(failureOf(unsubscribe)).toEqual({ value });
        // A failed original remover cannot be healed by replacement registration.
        expect(
          failureOf(() => {
            f.ctx.inbox.onAction(async () => ({ resolve: 'answered' }));
          })
        ).toEqual({ value });
        expect(register).toHaveBeenCalledTimes(1);
        expect(failureOf(f.dispose)).toEqual({ value });
        expect(failed).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
        expect(failureOf(f.dispose)).toEqual({ value });
        expect(failed).toHaveBeenCalledTimes(1);
        expect(other).toHaveBeenCalledTimes(1);
      } finally {
        failureOf(f.dispose);
        service.stop();
        setExtensionInbox(null);
        db.$client.close();
        vi.restoreAllMocks();
        await fs.rm(home, { recursive: true, force: true });
      }
    }
  );
});
