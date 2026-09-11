import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL('../cli.ts', import.meta.url));
const tsx = pathToFileURL(require.resolve('tsx/esm')).href;
describe('CLI dispatch preserves unrelated settings', () => {
  it.each([
    ['not-a-command'],
    ['--port', '4899', 'not-a-command'],
    ['--version'],
    ['--port', '4899', 'capabilities'],
  ])('does not initialize storage for %j', (...args) => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'dorkos-dispatch-'));
    try {
      const config = path.join(home, 'config.json');
      const original =
        '{"__internal__":{"migrations":{"version":"99.0.0"}},"auth":{"enabled":true},"cloud":{"instanceToken":"synthetic"},"unknownFuture":{"keep":true}}';
      writeFileSync(config, original);
      const sourceRoot = new URL('../../../../apps/server/src/', import.meta.url).href;
      const code = `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier.includes('/server/')){const url=new URL(specifier,context.parentURL);const marker='/packages/cli/server/';if(url.pathname.includes(marker)){return next(new URL(url.pathname.split(marker)[1].replace(/\\.js$/,'.ts'),${JSON.stringify(sourceRoot)}).href,context);}}return next(specifier,context);}});globalThis.__CLI_VERSION__='0.74.0';process.argv=[process.execPath,${JSON.stringify(entry)},...${JSON.stringify(args)}];await import(${JSON.stringify(pathToFileURL(entry).href)});`;
      const runner = path.join(home, 'runner.mjs');
      writeFileSync(runner, code);
      const result = spawnSync(process.execPath, ['--import', tsx, runner], {
        encoding: 'utf8',
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          DORK_HOME: home,
          DORKOS_TELEMETRY_DISABLED: '1',
        },
      });
      rmSync(runner);
      expect(result.status).toBe(args[0] === '--version' ? 0 : 1);
      expect(result.stderr).not.toContain('Corrupt config');
      if (args.includes('capabilities'))
        expect(result.stderr).toContain('Place the command before global options');
      else if (args[0] !== '--version')
        expect(result.stderr).toContain('Unknown command: not-a-command');
      expect(readFileSync(config, 'utf8')).toBe(original);
      expect(readdirSync(home)).toEqual(['config.json']);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
