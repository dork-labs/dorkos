import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** cli.ts is a top-level executable; pair this ordering guard with real-reader and lease tests. */
describe('database preflight on every boot entry', () => {
  it('CLI claims/checks before initConfigManager and releases only at server handoff', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../cli.ts', import.meta.url)), 'utf8');
    const opening = source.slice(
      source.indexOf('async function openConfigStore()'),
      source.indexOf("if (subcommand === 'config')")
    );
    expect(opening.indexOf('claimSupportedDataDirectory({')).toBeGreaterThan(0);
    expect(opening.indexOf('claimSupportedDataDirectory({')).toBeLessThan(
      opening.indexOf('return initConfigManager(DORK_HOME)')
    );
    expect(opening).toContain("process.once('exit', releaseBootstrapLock)");
    const handoff = source.slice(source.indexOf('// The server takes its own lock'));
    expect(handoff.indexOf('releaseBootstrapLock()')).toBeLessThan(
      handoff.indexOf("await import('../server/index.js')")
    );
  });
  it('harness claims/checks before Conf, keeps the lease through boot and releases at disposal/failure', () => {
    const source = fs.readFileSync(
      fileURLToPath(new URL('../../../../apps/server/src/harness-boot.ts', import.meta.url)),
      'utf8'
    );
    expect(source.indexOf('claimSupportedDataDirectory({')).toBeLessThan(
      source.indexOf('initConfigManager(dorkHome)')
    );
    expect(source).toContain('bootClaimedTestServer(dorkHome, lock.release)');
    expect(source).toContain('lock.release()');
    expect(source).toContain('finally {');
    expect(source).toContain('release()');
  });
});
