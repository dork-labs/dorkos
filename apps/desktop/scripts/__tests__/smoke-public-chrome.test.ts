import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * The public Chrome proof's child script, loaded the way `smoke-public-chrome.ts` loads it
 * (DOR-4178). It uses top-level await, which tsx can't compile as CommonJS, and this package
 * isn't `"type": "module"`. On CI that failed in under a second with nothing in the log.
 *
 * Run here without `CI`, the child stops at its first check, before any browser code, so this
 * never starts Chrome: what it proves is that the script loads.
 */
describe('the public Chrome proof’s child script', () => {
  const require = createRequire(import.meta.url);
  const runner = fileURLToPath(new URL('../smoke-public-chrome.ts', import.meta.url));
  const child = fileURLToPath(new URL('../local-browser-ci/public-chrome.mts', import.meta.url));

  it('is the file the runner starts', () => {
    expect(readFileSync(runner, 'utf8')).toContain("'./local-browser-ci/public-chrome.mts'");
  });

  it('loads, and stops at its CI check before any browser starts', async () => {
    const env = { PATH: process.env.PATH };
    const failure = await promisify(execFile)(
      process.execPath,
      ['--import', require.resolve('tsx'), child],
      { env, timeout: 60_000 }
    ).then(
      () => undefined,
      (error: { stderr?: string }) => error.stderr ?? ''
    );
    expect(failure).toBeDefined();
    expect(failure).not.toContain('Transform failed');
    expect(failure).toContain('ERR_ASSERTION');
  }, 90_000);
});
