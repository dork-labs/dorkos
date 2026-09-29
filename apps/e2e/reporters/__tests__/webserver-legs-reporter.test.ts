import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { legName } from '../webserver-legs-reporter';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const cli = require.resolve('@playwright/test/cli');

/** A port nothing is listening on right now, so the fixture never meets a real server. */
async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

describe('legName', () => {
  it("reads the leg from Playwright's prefix, dimmed or not", () => {
    expect(legName('[Marketing Site] ▲ Next.js 16')).toBe('Marketing Site');
    expect(legName('\x1b[2m[Express API] \x1b[22mlistening')).toBe('Express API');
  });

  it('groups unprefixed runner output on its own', () => {
    expect(legName('Error: connect ECONNREFUSED')).toBe('runner');
  });
});

describe('the reporter inside a real Playwright run', () => {
  it("puts a leg's output in a CI-shaped log, including a leg that never answers", async () => {
    const fixture = mkdtempSync(resolve(here, '../../.legs-proof-'));
    try {
      const port = await freePort();
      writeFileSync(
        join(fixture, 'a.spec.ts'),
        `import { test, expect } from '@playwright/test';
         test('a', () => expect(true).toBe(true));`
      );
      // CI's reporter set minus the file writers: `github` prints no leg output,
      // and `quiet.ts` stands in for manifest-reporter.ts, a reporter that never
      // says it does not print — which is what stops Playwright falling back to
      // its `dot` reporter (the one default that would print leg output). That
      // pair is the bug. LEGS toggles this reporter on.
      writeFileSync(join(fixture, 'quiet.ts'), 'export default class Quiet { onBegin() {} }');
      writeFileSync(
        join(fixture, 'playwright.config.ts'),
        `const serve = "console.log('hello from the leg'); require('http').createServer((q, r) => r.end('ok')).listen(${port})";
         const stall = "console.log('stalling on purpose'); setInterval(() => {}, 1000)";
         export default {
           testDir: '.', workers: 1, retries: 0,
           webServer: [
             { command: 'node -e "' + serve + '"', url: 'http://127.0.0.1:${port}', name: 'Leg A', stdout: 'pipe', timeout: 20000 },
             ...(process.env.STALL ? [{ command: 'node -e "' + stall + '"', url: 'http://127.0.0.1:1', name: 'Stall', stdout: 'pipe', timeout: 3000 }] : []),
           ],
           reporter: [
             ['github'],
             ['./quiet.ts'],
             ...(process.env.LEGS ? [[${JSON.stringify(resolve(here, '../webserver-legs-reporter.ts'))}]] : []),
           ],
         };`
      );
      const run = (env: Record<string, string>) =>
        spawnSync(process.execPath, [cli, 'test', '--config', 'playwright.config.ts'], {
          cwd: fixture,
          encoding: 'utf8',
          timeout: 60_000,
          env: {
            // eslint-disable-next-line no-restricted-syntax -- the child needs this process's PATH
            PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
            HOME: fixture,
            USERPROFILE: fixture,
            // eslint-disable-next-line no-restricted-syntax -- Windows needs it to spawn node
            SystemRoot: process.env.SystemRoot,
            CI: '1',
            ...env,
          },
        });

      // The control: CI's reporters alone drop the leg's output. If this ever
      // starts passing, Playwright fixed it upstream and this reporter can go.
      const silent = run({});
      expect(silent.status, silent.stdout + silent.stderr).toBe(0);
      expect(silent.stdout).not.toContain('hello from the leg');

      const healthy = run({ LEGS: '1' });
      expect(healthy.status, healthy.stdout + healthy.stderr).toBe(0);
      expect(healthy.stdout).toContain('[Leg A] hello from the leg');
      expect(healthy.stdout).toMatch(
        /webServer legs, every webServer leg answered; tests begin at \+\d+s: Leg A first \+\d+s/
      );

      // The DOR-2360 shape: a leg that never answers. Its output and the summary
      // must reach the log before the timeout error does.
      const stalled = run({ LEGS: '1', STALL: '1' });
      expect(stalled.status).not.toBe(0);
      const log = stalled.stdout + stalled.stderr;
      expect(log).toContain('Timed out waiting 3000ms from config.webServer');
      expect(log).toContain('[Stall] stalling on purpose');
      expect(log).toMatch(/webServer legs, the boot failed at \+\d+s: .*Stall first \+\d+s/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 120_000);
});
