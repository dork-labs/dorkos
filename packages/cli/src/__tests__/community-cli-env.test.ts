import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL('../cli.ts', import.meta.url));
const tsx = pathToFileURL(require.resolve('tsx/esm')).href;

describe('community CLI environment boundary', () => {
  it('forwards only allowlisted platform environment to the dispatcher', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'dorkos-community-env-'));
    try {
      const output = path.join(home, 'child-env.json');
      const dispatcher = path.join(home, 'dispatcher.mjs');
      writeFileSync(
        dispatcher,
        `import { writeFileSync } from 'node:fs';
export async function runCommunityDispatcher(_args, context) {
  writeFileSync(process.env.TEST_OUTPUT, JSON.stringify(context.processEnv));
  return 0;
}
`
      );

      const sourceRoot = new URL('../../../../apps/server/src/', import.meta.url).href;
      const entryUrl = pathToFileURL(entry).href;
      const dispatcherUrl = pathToFileURL(dispatcher).href;
      const code = `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){if(specifier==='./commands/community-deploy/community-dispatcher.js'&&context.parentURL===${JSON.stringify(entryUrl)})return{url:${JSON.stringify(dispatcherUrl)},shortCircuit:true};if(specifier.includes('/server/')){const url=new URL(specifier,context.parentURL);const marker='/packages/cli/server/';if(url.pathname.includes(marker)){return next(new URL(url.pathname.split(marker)[1].replace(/\\.js$/,'.ts'),${JSON.stringify(sourceRoot)}).href,context);}}return next(specifier,context);}});globalThis.__CLI_VERSION__='0.75.1';globalThis.__COMMUNITY_MIGRATION_COMPATIBILITY_ID__='sha256:${'0'.repeat(64)}';process.argv=[process.execPath,${JSON.stringify(entry)},'community','deploy','--help'];await import(${JSON.stringify(entryUrl)});`;
      const runner = path.join(home, 'runner.mjs');
      writeFileSync(runner, code);

      const result = spawnSync(process.execPath, ['--import', tsx, runner], {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: home,
          DORK_HOME: home,
          TEST_OUTPUT: output,
          SystemRoot: 'C:\\Windows',
          WINDIR: 'C:\\Windows',
          XDG_RUNTIME_DIR: '/run/user/1000',
          WAYLAND_DISPLAY: 'wayland-1',
          DO_NOT_FORWARD_SECRET: 'private-value',
        },
      });

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      const forwardedEnvironment = readFileSync(output, 'utf8');
      expect(JSON.parse(forwardedEnvironment)).toMatchObject({
        SystemRoot: 'C:\\Windows',
        WINDIR: 'C:\\Windows',
        XDG_RUNTIME_DIR: '/run/user/1000',
        WAYLAND_DISPLAY: 'wayland-1',
      });
      expect(forwardedEnvironment).not.toContain('DO_NOT_FORWARD_SECRET');
      expect(forwardedEnvironment).not.toContain('private-value');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
