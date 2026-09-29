import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL('../cli.ts', import.meta.url));
const tsx = pathToFileURL(require.resolve('tsx/esm')).href;

/** Run the real CLI entry with these arguments in a throwaway home; no server is started. */
function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dorkos-shorthand-'));
  try {
    const sourceRoot = new URL('../../../../apps/server/src/', import.meta.url).href;
    // Same loader as unknown-command.test.ts: resolve the bundled server paths
    // to their sources, pin the build-time version, then import the entry.
    const code = `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier.includes('/server/')){const url=new URL(specifier,context.parentURL);const marker='/packages/cli/server/';if(url.pathname.includes(marker)){return next(new URL(url.pathname.split(marker)[1].replace(/\\.js$/,'.ts'),${JSON.stringify(sourceRoot)}).href,context);}}return next(specifier,context);}});globalThis.__CLI_VERSION__='0.74.0';process.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify(args)}];await import(${JSON.stringify(pathToFileURL(entry).href)});`;
    const runner = path.join(home, 'runner.mjs');
    writeFileSync(runner, code);
    const result = spawnSync(process.execPath, ['--import', tsx, runner], {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        // eslint-disable-next-line no-restricted-syntax -- the child needs the real PATH to find node
        PATH: process.env.PATH,
        HOME: home,
        DORK_HOME: home,
        DORKOS_TELEMETRY_DISABLED: '1',
      },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('top-level package verbs are shorthand for `dorkos marketplace <verb>`', () => {
  it.each(['install', 'update', 'uninstall'])(
    '`dorkos %s --help` prints exactly what the marketplace form prints',
    (verb) => {
      // Purpose: one handler, one help text. If the shorthand ever grows its
      // own implementation again, the two outputs drift and this fails.
      const shorthand = runCli([verb, '--help']);
      const canonical = runCli(['marketplace', verb, '--help']);

      expect(shorthand.status).toBe(0);
      expect(canonical.status).toBe(0);
      expect(shorthand.stdout).toContain(`Usage: dorkos marketplace ${verb}`);
      expect(shorthand.stdout).toBe(canonical.stdout);
    }
  );
});
