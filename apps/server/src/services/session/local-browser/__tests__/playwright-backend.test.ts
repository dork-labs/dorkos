import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { chromium, type BrowserContext } from 'playwright-core';
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  stdout: undefined as PassThrough | undefined,
  failure: undefined as undefined | { code?: string; stderr?: string },
  execFile: vi.fn((...args: unknown[]) => {
    const done = args.at(-1) as (error: unknown, stdout?: string, stderr?: string) => void;
    done(mocks.failure, '', '');
    return { stdout: mocks.stdout };
  }),
}));
vi.mock('node:fs/promises', () => ({ access: mocks.access }));
vi.mock('node:child_process', () => {
  // Match Node's custom promisify contract: its promise retains the observable child.
  const execFile = Object.assign(mocks.execFile, {
    [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => {
      let child: ReturnType<typeof mocks.execFile> | undefined;
      const result = new Promise((resolve, reject) => {
        child = mocks.execFile(...args, (error: unknown, stdout: string, stderr: string) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      });
      return Object.assign(result, { child });
    },
  });
  return { execFile };
});
import {
  acquireLocalChromium,
  LOCAL_MANAGED_CHROMIUM_VERSION,
  productionBackend,
} from '../playwright-backend.js';

beforeEach(() => {
  mocks.execFile.mockClear();
  mocks.stdout = new PassThrough();
  mocks.access.mockRejectedValue(Object.assign(new Error('Missing browser'), { code: 'ENOENT' }));
  mocks.failure = undefined;
});
describe('pinned managed browser preparation', () => {
  it('reuses the installed executable without an installer process', async () => {
    mocks.access.mockResolvedValue(undefined);
    await acquireLocalChromium();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
  it('streams only genuine sanitized downloader progress and removes the listener', async () => {
    const report = vi.fn();
    mocks.execFile.mockImplementationOnce((...args: unknown[]) => {
      const done = args.at(-1) as (error: unknown, stdout?: string, stderr?: string) => void;
      queueMicrotask(() => {
        mocks.stdout!.write(
          'Downloading Chrome for Testing 153 from https://private/token\n|■■|  40% of 100 MiB\n'
        );
        done(undefined, '', '');
      });
      return { stdout: mocks.stdout };
    });
    await acquireLocalChromium(undefined, report);
    expect(report.mock.calls.map(([state]) => state)).toEqual([
      { stage: 'checking', component: null, percent: null },
      { stage: 'downloading', component: null, percent: null },
      { stage: 'downloading', component: 'chromium', percent: null },
      { stage: 'downloading', component: 'chromium', percent: 40 },
    ]);
    expect(mocks.stdout!.listenerCount('data')).toBe(0);
    expect(JSON.stringify(report.mock.calls)).not.toContain('private');
  });
  it('reports launching only after the installed executable is checked', async () => {
    mocks.access.mockResolvedValue(undefined);
    const report = vi.fn();
    const launch = vi
      .spyOn(chromium, 'launchPersistentContext')
      .mockResolvedValue({} as BrowserContext);
    try {
      await productionBackend.launch('test-only-storage', undefined, report);
      expect(report.mock.calls.map(([state]) => state)).toEqual([
        { stage: 'checking', component: null, percent: null },
        { stage: 'launching', component: null, percent: null },
      ]);
      expect(launch).toHaveBeenCalledExactlyOnceWith('test-only-storage', {
        timeout: 15_000,
        headless: false,
        viewport: null,
        chromiumSandbox: true,
        ignoreDefaultArgs: ['--enable-automation'],
      });
      expect(mocks.execFile).not.toHaveBeenCalled();
    } finally {
      launch.mockRestore();
    }
  });
  it('returns a context that arrives after abort so the service can close its owned browser', async () => {
    mocks.access.mockResolvedValue(undefined);
    const controller = new AbortController();
    const context = {
      close: vi.fn(async (): Promise<void> => undefined),
    } as unknown as BrowserContext;
    let finish!: (context: BrowserContext) => void;
    const launch = vi.spyOn(chromium, 'launchPersistentContext').mockImplementationOnce(
      () =>
        new Promise<BrowserContext>((resolve) => {
          finish = resolve;
        })
    );
    try {
      const opening = productionBackend.launch('test-only-storage', controller.signal);
      await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
      controller.abort();
      finish(context);
      expect(await opening).toBe(context);
      expect(context.close).not.toHaveBeenCalled();
    } finally {
      launch.mockRestore();
    }
  });
  it('runs only the installed package installer with a bounded acquisition', async () => {
    await acquireLocalChromium();
    const [binary, args, options] = mocks.execFile.mock.calls[0];
    expect(binary).toBe(process.execPath);
    expect(args).toEqual([
      expect.stringMatching(/playwright-core[/\\]cli\.js$/),
      'install',
      'chromium',
    ]);
    expect(options).toMatchObject({ timeout: 180_000, env: { ELECTRON_RUN_AS_NODE: '1' } });
  });
  it.each([
    [{ code: 'ENOSPC' }, 'browser_storage', 'Free some space'],
    [{ stderr: 'EACCES confidential/path' }, 'browser_storage', 'Check folder permissions'],
    [{ stderr: 'proxy refused confidential/token' }, 'browser_download', 'Check your connection'],
  ])(
    'returns plain recovery guidance without exposing installer details',
    async (failure, code, guidance) => {
      mocks.failure = failure;
      await expect(acquireLocalChromium()).rejects.toMatchObject({
        code,
        message: expect.stringContaining(guidance),
      });
      try {
        await acquireLocalChromium();
      } catch (error) {
        expect((error as Error).message).not.toContain('confidential');
      }
    }
  );
  it('cancels an in-flight installer through its abort signal', async () => {
    const controller = new AbortController();
    const report = vi.fn();
    mocks.execFile.mockImplementationOnce((...args: unknown[]) => {
      const options = args[2] as { signal: AbortSignal };
      const done = args.at(-1) as (error: unknown) => void;
      options.signal.addEventListener(
        'abort',
        () => {
          mocks.stdout!.write(
            'Downloading Chromium from https://private/token\n|■■|  80% of 100 MiB\n'
          );
          done({ code: 'ABORT_ERR' });
        },
        { once: true }
      );
      return { stdout: mocks.stdout };
    });
    const preparing = acquireLocalChromium(controller.signal, report);
    const refused = expect(preparing).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledOnce());
    controller.abort();
    await refused;
    expect(report.mock.calls.map(([state]) => state)).toEqual([
      { stage: 'checking', component: null, percent: null },
      { stage: 'downloading', component: null, percent: null },
    ]);
    expect(mocks.stdout!.listenerCount('data')).toBe(0);
  });
  it('reports the browser revision actually paired with its packaged library', () => {
    const require = createRequire(import.meta.url);
    const { browsers } = require(
      path.join(path.dirname(require.resolve('playwright-core/package.json')), 'browsers.json')
    );
    expect(
      browsers.find((browser: { name: string }) => browser.name === 'chromium').browserVersion
    ).toBe(LOCAL_MANAGED_CHROMIUM_VERSION);
  });
});
