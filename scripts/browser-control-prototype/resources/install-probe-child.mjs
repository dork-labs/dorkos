import { loadPlaywright } from '../runtime.mjs';
import { isEntrypoint } from '../entrypoint.mjs';
import { BrowserManager } from '../manager.mjs';

// A fresh process resolves the cache before Playwright module loading; no shared import cache.
if (isEntrypoint(import.meta.url)) {
  let manager;
  try {
    const runtime = await loadPlaywright({ repoRoot: process.argv[2] });
    if (process.argv[3] === 'launch') {
      manager = new BrowserManager({
        runtime,
        profilesDir: process.argv[4],
        fixtureOrigin: process.argv[5],
      });
      const start = performance.now();
      const browser = await manager.openPersistent('cold-install');
      const launchMs = performance.now() - start;
      await manager.shutdown();
      process.stdout.write(
        JSON.stringify({
          status: 'pass',
          receipt: runtime.receipt,
          launchMs,
          subjects: [browser.browserId],
        })
      );
    } else process.stdout.write(JSON.stringify({ status: 'pass', receipt: runtime.receipt }));
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        status: 'unverified',
        code: /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'PROBE_UNAVAILABLE',
      })
    );
    process.exitCode = 1;
  } finally {
    await manager?.shutdown().catch(() => {
      process.exitCode = 1;
    });
  }
}
