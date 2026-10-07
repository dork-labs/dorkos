import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DesktopQualificationHelloSchema,
  DesktopQualificationGrantSchema,
  readOriginalDesktopFrame,
  writeOriginalDesktopFrame,
} from '@dorkos/shared/browser-desktop-qualification';

describe('original Desktop qualification transfer', () => {
  for (const cause of [false, undefined])
    it(`retains original transfer ${String(cause)} after receiver entry and independent local closes`, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'desktop-original-qualification-')));
      const appPath = join(root, 'Owned.app'),
        home = join(root, '.dork');
      const executable = join(appPath, 'Contents/MacOS/Owned');
      const resources = join(appPath, 'Contents/Resources');
      const entry = join(resources, 'app.asar.unpacked/dist/server/server-entry.mjs');
      await mkdir(home, { mode: 0o700 });
      await mkdir(join(appPath, 'Contents/MacOS'), { recursive: true });
      await mkdir(join(resources, 'app.asar.unpacked/dist/server'), { recursive: true });
      await writeFile(executable, 'original executable');
      await writeFile(entry, 'original utility entry');
      const input = new PassThrough(),
        output = new PassThrough();
      const lifetime = new AbortController();
      const app = Object.assign(new EventEmitter(), {
        isPackaged: true,
        getPath: (name: string) => (name === 'exe' ? executable : root),
      });
      let transferred: unknown;
      let localCloses = 0,
        untransferredCloses = 0;
      class Channel {
        port1 = Object.assign(new EventEmitter(), {
          start() {},
          postMessage() {},
          close() {
            localCloses++;
          },
        });
        port2 = Object.assign(new EventEmitter(), {
          close() {
            untransferredCloses++;
          },
        });
      }
      const originalProcess = process;
      vi.stubGlobal(
        'process',
        new Proxy(originalProcess, {
          get(target, key, receiver) {
            if (key === 'stdin') return input;
            if (key === 'stdout') return output;
            if (key === 'resourcesPath') return resources;
            if (key === 'env') return { ...target.env, DORKOS_PRIVATE_DESKTOP_QUALIFICATION: '1' };
            if (key === 'platform') return 'darwin';
            if (key === 'arch') return 'arm64';
            return Reflect.get(target, key, receiver);
          },
        })
      );
      vi.doMock('electron', () => ({ app, MessageChannelMain: Channel }));
      vi.resetModules();
      let preparing: Promise<void> | undefined, originalHello: Promise<unknown> | undefined;
      try {
        const owner = await import('../bootstrap.js');
        originalHello = readOriginalDesktopFrame(
          output,
          lifetime.signal,
          'DORKOS_PRIVATE_DESKTOP_QUALIFICATION '
        );
        preparing = owner.prepareOriginalDesktopQualification();
        void preparing.catch(() => {});
        await writeOriginalDesktopFrame(input, { type: 'browser-desktop-qualification-request' });
        const hello = DesktopQualificationHelloSchema.parse(await originalHello);
        const digest = 'a'.repeat(64);
        await writeOriginalDesktopFrame(input, {
          type: 'browser-desktop-qualification-grant',
          nonce: hello.nonce,
          grant: {
            home,
            appPath,
            signedArtifactSHA256: digest,
            desktopExecutableSHA256: hello.desktopExecutableSHA256,
            serverEntrySHA256: hello.serverEntrySHA256,
            subject: {
              runtimeClass: {
                kind: 'electron',
                nodeVersion: '24.14.1',
                modulesABI: '137',
                v8Version: '13.6.233.10',
                opensslVersion: '3.5.2',
                uvVersion: '1.51.0',
                electronVersion: '40.0.0',
                platform: 'darwin',
                arch: 'arm64',
                featureContract: 'browser-owner-runtime-v1',
                surface: {
                  abortSignalAny: true,
                  abortSignalTimeout: true,
                  workerThreads: true,
                  callbackDnsCancel: true,
                  bigint: true,
                },
              },
              executableSHA256: digest,
              version: '153',
              revision: '1243',
              libraryVersion: '1.63.0',
              platform: 'darwin',
              arch: 'arm64',
              channel: 'desktop',
              sourceManifestSHA256: digest,
              controllerSHA256: digest,
              verifierSHA256: digest,
              nativeJournalSHA256: digest,
              productionSubjectSHA256: digest,
              mode: 'chrome-compatible',
              identityPolicyRevision: 1,
              networkPolicyRevision: 1,
            },
          },
        });
        await preparing;
        let transfers = 0;
        const child = Object.assign(new EventEmitter(), {
          postMessage(value: unknown) {
            transferred = value;
            transfers++;
            throw cause;
          },
        });
        const observedErrors: unknown[] = [];
        child.on('error', (value) => observedErrors.push(value));
        owner.transferOriginalDesktopQualification(child as unknown as Electron.UtilityProcess);
        expect(transfers).toBe(0);
        child.emit('message', { type: 'browser-desktop-qualification-receiver-ready' });
        expect(transfers).toBe(1);
        const transferredGrant = DesktopQualificationGrantSchema.parse(
          (transferred as { grant: unknown }).grant
        );
        // The wire parser copies data; inspect the actual retained transfer object separately.
        const originalGrant = (transferred as { grant: typeof transferredGrant }).grant;
        expect(Object.isFrozen(originalGrant.subject)).toBe(true);
        expect(Object.isFrozen(originalGrant.subject.runtimeClass)).toBe(true);
        expect(Object.isFrozen(originalGrant.subject.runtimeClass.surface)).toBe(true);
        expect(Reflect.set(originalGrant.subject.runtimeClass, 'nodeVersion', '99.0.0')).toBe(
          false
        );
        expect(Reflect.set(originalGrant.subject.runtimeClass.surface, 'bigint', false)).toBe(
          false
        );
        expect(originalGrant.subject.runtimeClass.nodeVersion).toBe('24.14.1');
        expect(originalGrant.subject.runtimeClass.surface.bigint).toBe(true);
        expect(observedErrors).toHaveLength(1);
        await expect(owner.closeOriginalDesktopQualification()).rejects.toBe(cause);
        expect(localCloses).toBe(1);
        expect(untransferredCloses).toBe(1);
        child.emit('message', { type: 'browser-desktop-qualification-receiver-ready' });
        expect(transfers).toBe(1);
      } finally {
        lifetime.abort();
        input.destroy();
        output.destroy();
        app.emit('before-quit');
        await Promise.allSettled([
          ...(preparing ? [preparing] : []),
          ...(originalHello ? [originalHello] : []),
        ]);
        vi.unstubAllGlobals();
        vi.doUnmock('electron');
        vi.resetModules();
        await rm(root, { recursive: true, force: true });
      }
    });
});
