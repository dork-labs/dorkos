import './native-fixture-preflight.js';
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { access, cp, appendFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createBrowserEngine, type BrowserLifecycleEngine } from '../index.js';
import { fixture, configuration, requestId, profileId } from './lifecycle-fixture.js';

describe('actual fixture-only lifecycle', () => {
  it('captures an unattended retained Page and returns from independent unseeded clean mode with fresh live IDs', async () => {
    const owned = await fixture();
    let engine: BrowserLifecycleEngine | undefined;
    try {
      owned.configure({ seed: true });
      engine = createBrowserEngine(
        await configuration(join(owned.root, 'data'), owned.origin, true)
      );
      const retained = await engine.open({
        kind: 'open',
        requestId,
        mode: 'persistent',
        profileId,
      });
      await expect.poll(() => owned.reports.length).toBe(1);
      expect(owned.reports[0]!.seed).toBe('retained-A');
      await expect.poll(() => owned.counter).toBeGreaterThanOrEqual(3);
      const frame = await engine.capture({ kind: 'capture', requestId, binding: retained.tab });
      expect(frame.receipt.binding).toEqual(retained.tab);
      expect(frame.receipt).toMatchObject({
        format: 'jpeg',
        width: 1280,
        height: 720,
        byteLength: frame.bytes.length,
      });
      expect([...frame.bytes.slice(0, 2)]).toEqual([255, 216]);
      owned.configure({ seed: false });
      const clean = await engine.open({ kind: 'open', requestId, mode: 'ephemeral' });
      await expect.poll(() => owned.reports.length).toBe(2);
      expect(owned.reports[1]!.seed).toBe(null);
      expect(owned.reports[1]!.cookie).toBe('');
      expect(clean.browserId).not.toBe(retained.browserId);
      expect(clean.tab.tabId).not.toBe(retained.tab.tabId);
      expect(engine.listTabs(retained.browserId, retained.browserGeneration)).toEqual([
        retained.tab,
      ]);
      expect(
        await engine.close({
          kind: 'close',
          requestId,
          browserId: clean.browserId,
          browserGeneration: clean.browserGeneration,
        })
      ).toMatchObject({ cleanup: 'observed' });
      expect(
        await engine.close({
          kind: 'close',
          requestId,
          browserId: retained.browserId,
          browserGeneration: retained.browserGeneration,
        })
      ).toMatchObject({ cleanup: 'observed' });
      const reopened = await engine.open({
        kind: 'open',
        requestId,
        mode: 'persistent',
        profileId,
      });
      await expect.poll(() => owned.reports.length).toBe(3);
      expect(owned.reports[2]!.seed).toBe('retained-A');
      expect(owned.reports[2]!.cookie).toContain('seed=retained-A');
      expect(reopened.browserId).not.toBe(retained.browserId);
      expect(reopened.tab.tabId).not.toBe(retained.tab.tabId);
      const stopped = await engine.shutdown();
      expect(stopped).toHaveLength(3);
      expect(stopped.every((result) => result.cleanup === 'observed')).toBe(true);
      expect(await engine.shutdown()).toEqual(stopped);
      await expect(
        engine.capture({ kind: 'capture', requestId, binding: reopened.tab })
      ).rejects.toMatchObject({ code: 'STALE_BINDING' });
    } finally {
      const stopped = engine ? await engine.shutdown() : [];
      await owned.close(stopped.every((result) => result.cleanup === 'observed'));
      expect(stopped.every((result) => result.cleanup === 'observed')).toBe(true);
    }
  }, 30_000);

  it('refuses absent/corrupt executable and unsupported TLS before data mutation without installing', async () => {
    const owned = await fixture();
    try {
      const config = await configuration(join(owned.root, 'absent-data'), owned.origin, true);
      const absent = createBrowserEngine({
        ...config,
        runtime: {
          ...config.runtime,
          executable: { ...config.runtime.executable, path: join(owned.root, 'absent') },
        },
      });
      await expect(
        absent.open({ kind: 'open', requestId, mode: 'persistent', profileId })
      ).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE' });
      await expect(access(config.dataDir)).rejects.toThrow();
      const corrupt = createBrowserEngine({
        ...config,
        runtime: {
          ...config.runtime,
          executable: { ...config.runtime.executable, sha256: 'a'.repeat(64) },
        },
      });
      await expect(
        corrupt.open({ kind: 'open', requestId, mode: 'ephemeral' })
      ).rejects.toMatchObject({ code: 'EXECUTABLE_UNAVAILABLE' });
      await expect(access(config.dataDir)).rejects.toThrow();
      const tls = createBrowserEngine({
        ...config,
        network: { kind: 'fixture', origin: 'https://127.0.0.1:9001' },
      });
      await expect(tls.open({ kind: 'open', requestId, mode: 'ephemeral' })).rejects.toMatchObject({
        code: 'NETWORK_POLICY_UNSUPPORTED',
      });
      await expect(access(config.dataDir)).rejects.toThrow();
      expect(owned.reports).toHaveLength(0);
      await absent.shutdown();
      await corrupt.shutdown();
      await tls.shutdown();
    } finally {
      await owned.close();
    }
  });
  it('refuses entry bootstrap core extra missing and symlink private-copy mutations before execution or profile mutation', async () => {
    const owned = await fixture();
    try {
      const config = await configuration(
        join(owned.root, 'never-created-data'),
        owned.origin,
        true
      );
      for (const kind of ['entry', 'bootstrap', 'core', 'extra', 'missing', 'symlink']) {
        const copied = join(owned.root, kind);
        await cp(config.runtime.library.rootDir, copied, { recursive: true });
        const marker = join(owned.root, 'patch-executed');
        if (kind === 'entry')
          await appendFile(
            join(copied, 'index.js'),
            `\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'PATCH_EXECUTED');throw Error('PRIVATE-PATCH-SECRET');`
          );
        if (kind === 'bootstrap')
          await appendFile(
            join(copied, 'lib/bootstrap.js'),
            '\nthrow Error("PRIVATE-PATCH-SECRET");'
          );
        if (kind === 'core')
          await appendFile(
            join(copied, 'lib/coreBundle.js'),
            '\nthrow Error("PRIVATE-PATCH-SECRET");'
          );
        if (kind === 'extra') await writeFile(join(copied, 'extra.js'), '// extra');
        if (kind === 'missing') await rm(join(copied, 'NOTICE'));
        if (kind === 'symlink') {
          await rm(join(copied, 'NOTICE'));
          await symlink(join(config.runtime.library.rootDir, 'NOTICE'), join(copied, 'NOTICE'));
        }
        const engine = createBrowserEngine({
          ...config,
          runtime: { ...config.runtime, library: { ...config.runtime.library, rootDir: copied } },
        });
        const failure = await engine
          .open({ kind: 'open', requestId, mode: 'ephemeral' })
          .catch((error) => error);
        await expect(access(marker)).rejects.toThrow();
        expect(failure).toMatchObject({ code: 'LIBRARY_UNAVAILABLE' });
        await expect(access(config.dataDir)).rejects.toThrow();
        expect(owned.reports).toHaveLength(0);
        await engine.shutdown();
      }
    } finally {
      await owned.close();
    }
  });
});
