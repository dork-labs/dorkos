import { execFileSync } from 'node:child_process';
import { constants, openSync, writeSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  cp,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  symlink,
  appendFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import * as fsPromises from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifiedLibrary } from '../runtime/public-library.js';
import { acquireBrowser, nativeRuntimeForAcquisition } from '../lifecycle/acquisition.js';
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

import type { BrowserRuntimeDescriptor } from '../runtime-descriptor.js';

describe.skipIf(process.platform === 'win32')(
  'genuine public Playwright distribution boundary',
  () => {
    let directory: string, libraryRoot: string, runtime: BrowserRuntimeDescriptor;
    beforeEach(async () => {
      directory = await mkdtemp(join(await realpath(tmpdir()), 'public-library-'));
      libraryRoot = join(directory, 'playwright-core');
      const require = createRequire(import.meta.url);
      const source = await realpath(dirname(require.resolve('playwright-core/package.json')));
      // This allocation's OWN genuine source, not a donor or fabricated114-file fixture.
      await cp(source, libraryRoot, {
        recursive: true,
        filter: (entry) => !relative(source, entry).split(sep).includes('node_modules'),
      });
      const executable = await realpath(process.execPath);
      // Node supplies a genuine readable/executable artifact for this library-only
      // control. No claim of Chromium readiness, version execution or browser launch.
      runtime = {
        library: {
          package: 'playwright-core',
          version: '1.63.0',
          rootDir: libraryRoot,
          assets: { cli: 'cli.js', manifest: 'browsers.json' },
        },
        executable: {
          path: executable,
          sha256: createHash('sha256')
            .update(await readFile(executable))
            .digest('hex'),
          revision: '1243',
          version: '153.0.8010.12',
          platform: process.platform as 'darwin' | 'linux',
          arch: process.arch as 'arm64' | 'x64',
        },
        identity: { mode: 'native', policyRevision: 0 },
      };
    });
    afterEach(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    const shim = async () => {
      const bins = join(libraryRoot, 'node_modules', '.bin');
      await mkdir(bins, { recursive: true });
      return join(bins, 'playwright-core');
    };
    it('strictly refuses a Chrome candidate and verifies its exact acquisition native baseline', async () => {
      const candidate: BrowserRuntimeDescriptor = {
        ...runtime,
        identity: { ...runtime.identity, mode: 'chrome-compatible' },
      };
      await expect(verifiedLibrary(candidate)).rejects.toMatchObject({
        code: 'IDENTITY_MODE_UNAVAILABLE',
      });
      const baseline = nativeRuntimeForAcquisition(candidate);
      expect(baseline.library).toBe(candidate.library);
      expect(baseline.executable).toBe(candidate.executable);
      expect(baseline.identity).toEqual({ ...candidate.identity, mode: 'native' });
      expect(candidate.identity.mode).toBe('chrome-compatible');
      expect((await verifiedLibrary(baseline)).name()).toBe('chromium');
      expect(nativeRuntimeForAcquisition(runtime)).toBe(runtime);
    });
    it.each([undefined, { browserWorkerPath: undefined }])(
      'refuses Chrome acquisition without an original supervised worker before verification or profile mutation',
      async (nativeJournal) => {
        const effects = vi.fn(() => {
          throw new Error('ACQUISITION_EFFECT_ENTERED');
        });
        // Deliberately expose only the entry boundary: any clock or profile read is a failure.
        const config = {
          network: { kind: 'fixture', origin: 'http://127.0.0.1:4242' },
          runtime: { ...runtime, identity: { ...runtime.identity, mode: 'chrome-compatible' } },
          nativeJournal,
          get clock() {
            return effects();
          },
          get dataDir() {
            return effects();
          },
        } as unknown as Parameters<typeof acquireBrowser>[0];
        const record = { diagnosticsBudget: {} } as Parameters<typeof acquireBrowser>[1];
        vi.mocked(fsPromises.open).mockClear();
        await expect(acquireBrowser(config, record, () => false)).rejects.toMatchObject({
          code: 'IDENTITY_MODE_UNAVAILABLE',
        });
        expect(effects).not.toHaveBeenCalled();
        expect(fsPromises.open).not.toHaveBeenCalled();
      }
    );
    it('loads the unchanged official package without generated metadata', async () => {
      expect((await verifiedLibrary(runtime)).name()).toBe('chromium');
    });
    it('accepts only the bounded generated regular self-bin without executing it', async () => {
      await writeFile(await shim(), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      expect((await verifiedLibrary(runtime)).name()).toBe('chromium');
    });
    it('accepts a self-bin symlink only to the exact canonical official cli.js', async () => {
      await symlink('../../cli.js', await shim());
      expect((await verifiedLibrary(runtime)).name()).toBe('chromium');
    });
    it('refuses any extra module-resolvable source under generated node_modules', async () => {
      await writeFile(await shim(), '#!/bin/sh\nexit 99\n');
      await writeFile(
        join(libraryRoot, 'node_modules', 'shadow.js'),
        'throw new Error("must not load")'
      );
      await expect(verifiedLibrary(runtime)).rejects.toMatchObject({ code: 'LIBRARY_UNAVAILABLE' });
    });
    it('refuses extra executables in the generated bin directory', async () => {
      const file = await shim();
      await writeFile(file, '#!/bin/sh\nexit 99\n');
      await writeFile(join(dirname(file), 'node'), 'untrusted');
      await expect(verifiedLibrary(runtime)).rejects.toMatchObject({ code: 'LIBRARY_UNAVAILABLE' });
    });
    it('refuses malformed metadata types and arbitrary confined symlink targets', async () => {
      const file = await shim();
      await mkdir(file);
      await expect(verifiedLibrary(runtime)).rejects.toMatchObject({ code: 'LIBRARY_UNAVAILABLE' });
      await rm(file, { recursive: true });
      await symlink('../../package.json', file);
      await expect(verifiedLibrary(runtime)).rejects.toMatchObject({ code: 'LIBRARY_UNAVAILABLE' });
    });
    it('refuses oversized shims and still hashes every official source byte', async () => {
      const file = await shim();
      await writeFile(file, Buffer.alloc(65537));
      await expect(verifiedLibrary(runtime)).rejects.toMatchObject({ code: 'LIBRARY_UNAVAILABLE' });
      await writeFile(file, '#!/bin/sh\nexit 99\n');
      await appendFile(join(libraryRoot, 'cli.js'), '\n// changed official source\n');
      await expect(verifiedLibrary(runtime)).rejects.toMatchObject({ code: 'LIBRARY_UNAVAILABLE' });
    });
    it.each(['package.json', 'browsers.json'])(
      'refuses a genuine %s FIFO before a delayed writer can unblock it',
      async (name) => {
        const file = join(libraryRoot, name);
        await rm(file);
        execFileSync('/usr/bin/mkfifo', [file], { timeout: 1000 });
        let writerUsed = false;
        const writer = setTimeout(() => {
          let descriptor: number | undefined;
          try {
            descriptor = openSync(file, constants.O_WRONLY | constants.O_NONBLOCK);
            writerUsed = true;
            writeSync(descriptor, '{}');
          } catch {
            // ENXIO means no reader entered the FIFO; do not leave a blocked writer.
          } finally {
            if (descriptor !== undefined) closeSync(descriptor);
          }
        }, 150);
        try {
          await expect(verifiedLibrary(runtime)).rejects.toMatchObject({
            code: 'LIBRARY_UNAVAILABLE',
          });
          expect(writerUsed).toBe(false);
        } finally {
          clearTimeout(writer);
        }
      }
    );
    it.each(['package.json', 'browsers.json'])(
      'refuses oversized %s metadata without acquiring its original handle',
      async (name) => {
        const file = join(libraryRoot, name);
        await writeFile(file, Buffer.alloc(65537, 32));
        const mockedOpen = vi.mocked(fsPromises.open);
        const before = mockedOpen.mock.calls.length;
        await expect(verifiedLibrary(runtime)).rejects.toMatchObject({
          code: 'LIBRARY_UNAVAILABLE',
        });
        expect(mockedOpen.mock.calls.slice(before).some((args) => String(args[0]) === file)).toBe(
          false
        );
      }
    );
    it.each(['directory', 'file', 'metadata', 'operation-and-close'] as const)(
      'retains the actual %s close fault and blocks subsequent admission without retry',
      async (kind) => {
        vi.resetModules();
        const { verifiedLibrary: isolatedVerify } = await import('../runtime/public-library.js');
        const mockedOpen = vi.mocked(fsPromises.open);
        const actualOpen = mockedOpen.getMockImplementation()!;
        let injected = false;
        let original: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
        let closeCalls = 0;
        const primary = new (await import('../lifecycle/errors.js')).BrowserLifecycleError(
          'LIBRARY_UNAVAILABLE'
        );
        mockedOpen.mockImplementation(async (...args) => {
          const handle = await actualOpen(...args);
          if (
            !injected &&
            String(args[0]) ===
              (kind === 'file'
                ? join(libraryRoot, 'cli.js')
                : kind === 'metadata'
                  ? join(libraryRoot, 'package.json')
                  : libraryRoot)
          ) {
            injected = true;
            original = handle;
            const actualClose = handle.close.bind(handle);
            vi.spyOn(handle, 'close').mockImplementation(async () => {
              closeCalls++;
              // The original really closes, but the consumer receives rejection:
              // it cannot infer that resolution or retry this original handle.
              await actualClose();
              throw new Error('injected ambiguous close');
            });
            if (kind === 'operation-and-close') vi.spyOn(handle, 'stat').mockRejectedValue(primary);
          }
          return handle;
        });
        try {
          const first = isolatedVerify(runtime);
          if (kind === 'operation-and-close') await expect(first).rejects.toBe(primary);
          else await expect(first).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
          expect(original).toBeDefined();
          expect(closeCalls).toBe(1);
          const opens = mockedOpen.mock.calls.length;
          await expect(isolatedVerify(runtime)).rejects.toMatchObject({
            code: 'LIBRARY_UNAVAILABLE',
          });
          expect(mockedOpen.mock.calls.length).toBe(opens);
          expect(closeCalls).toBe(1);
        } finally {
          mockedOpen.mockImplementation(actualOpen);
          vi.restoreAllMocks();
        }
      }
    );
  }
);
