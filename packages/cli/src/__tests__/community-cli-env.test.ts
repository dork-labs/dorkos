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

/** Run the packaged entry with `extra` exported and return what it hands the dispatcher. */
function readForwardedEnvironment(extra: Record<string, string>): string {
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
        ...extra,
      },
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return readFileSync(output, 'utf8');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('community CLI environment boundary', () => {
  it('forwards only allowlisted platform and Fly/Neon credential environment to the dispatcher', () => {
    const forwardedEnvironment = readForwardedEnvironment({
      FLY_ACCESS_TOKEN: 'FlyV1 fm2_scoped-access',
      FLY_API_TOKEN: 'FlyV1 fm2_scoped-api',
      NEON_API_KEY: 'napi_scoped',
    });
    expect(JSON.parse(forwardedEnvironment)).toMatchObject({
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      XDG_RUNTIME_DIR: '/run/user/1000',
      WAYLAND_DISPLAY: 'wayland-1',
      // A scoped credential a person exported is what `fly` and `neonctl` must sign in with
      // (DOR-2602): dropping one silently falls back to their saved sign-in.
      FLY_ACCESS_TOKEN: 'FlyV1 fm2_scoped-access',
      FLY_API_TOKEN: 'FlyV1 fm2_scoped-api',
      NEON_API_KEY: 'napi_scoped',
    });
    expect(forwardedEnvironment).not.toContain('DO_NOT_FORWARD_SECRET');
    expect(forwardedEnvironment).not.toContain('private-value');
  });

  it('drops an empty credential variable, because an empty FLY_ACCESS_TOKEN makes fly use the saved sign-in', () => {
    const forwarded = JSON.parse(
      readForwardedEnvironment({
        FLY_ACCESS_TOKEN: '',
        FLY_API_TOKEN: 'fo1_scoped',
        NEON_API_KEY: '',
      })
    ) as Record<string, string>;
    expect(forwarded.FLY_API_TOKEN).toBe('fo1_scoped');
    expect('FLY_ACCESS_TOKEN' in forwarded).toBe(false);
    expect('NEON_API_KEY' in forwarded).toBe(false);
  });
});
