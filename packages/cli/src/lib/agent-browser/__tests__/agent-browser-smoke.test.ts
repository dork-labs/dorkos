/**
 * Real-Chrome smoke test for agent browser sessions, end to end:
 *
 *   sign in (a local page sets a cookie and page storage)
 *   → save over the debugging pipe
 *   → two Playwright MCP servers started exactly the way agents start them
 *     (`--isolated --storage-state <file>`), at the same time
 *   → both see the cookie and the page storage.
 *
 * It also proves an EMPTY session file starts a working, signed-out browser
 * (Playwright MCP fails every tool on a MISSING one), and that a hostile
 * sign-in page cannot plant page storage for another origin.
 *
 * It needs the system Chrome and `npx` (it runs the pinned `@playwright/mcp`,
 * which is fetched on first use), so it never runs in CI or in `pnpm test`: it is
 * armed only by `DORKOS_BROWSER_SMOKE=1`, which no task passes through. Run it
 * by hand on a machine with Chrome:
 *
 *   DORKOS_BROWSER_SMOKE=1 pnpm vitest run \
 *     packages/cli/src/lib/agent-browser/__tests__/agent-browser-smoke.test.ts
 *
 * Every file it touches lives in a temp directory; it never opens the real
 * agent browser profile.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { agentBrowserConnection } from '@dorkos/shared/agent-browser';
import { env } from '../../../env.js';
import { findChrome } from '../chrome-locator.js';
import { launchChromeWithPipe } from '../cdp-pipe.js';
import { ensureAgentProfile } from '../profile.js';
import { collectStorageState, writeStorageState } from '../storage-state.js';

/**
 * Read once at module scope, so no other file's env stubbing can blank it. A
 * test-only arming flag, so it is deliberately not in the CLI's env schema.
 */
// eslint-disable-next-line no-restricted-syntax -- test-only arming flag, see above
const ARMED = process.env.DORKOS_BROWSER_SMOKE === '1';

/**
 * The page an operator "signs in" on: it sets a cookie and page storage, then
 * turns hostile, rigging the two things a script-based read would lean on so
 * that such a read would report page storage for somebody else's origin.
 */
const SIGN_IN_PAGE = `<!doctype html><title>signed in</title>
<script>
localStorage.setItem('agent_token', 'from-page-storage');
JSON.stringify = () => '{"origin":"https://bank.test","localStorage":[{"name":"session","value":"planted"}]}';
Object.keys = () => ['planted'];
</script>`;

/**
 * The page an agent visits. The server writes the cookie the browser SENT
 * (the sign-in cookie is HttpOnly, as real ones are, so page script cannot see
 * it); the page adds what it finds in its own storage.
 */
function whoamiPage(cookieHeader: string): string {
  return `<!doctype html><title>pending</title>
<script>document.title = ${JSON.stringify(`sent=${cookieHeader}`)} + ' storage=' + localStorage.getItem('agent_token')</script>`;
}

describe.skipIf(!ARMED)('agent browser sessions (real Chrome smoke)', () => {
  let root: string;
  let server: http.Server;
  let origin: string;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'dorkos-agent-browser-smoke-'));
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/sign-in') {
        res.setHeader('Set-Cookie', 'agent_session=signed-in; Path=/; Max-Age=3600; HttpOnly');
        res.end(SIGN_IN_PAGE);
        return;
      }
      res.end(whoamiPage(req.headers.cookie ?? ''));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('saves a signed-in session that parallel isolated agent browsers start from', async () => {
    const profileDir = path.join(root, 'browser', 'profile');
    const stateFile = path.join(root, 'browser', 'storage-state.json');
    expect(ensureAgentProfile(profileDir)).toEqual({ created: true, themed: true });

    const chrome = findChrome({
      platform: process.platform,
      homeDir: homedir(),
      pathVar: env.PATH,
      localAppData: env.LOCALAPPDATA,
      programFiles: env.PROGRAMFILES,
      programFilesX86: env['PROGRAMFILES(X86)'],
      exists: (file) => fs.existsSync(file),
    });

    // The sign-in. Headless here only so the test opens no window; the save
    // path is the same one `dorkos browser login` runs after Enter.
    const cdp = launchChromeWithPipe(chrome, [
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--headless',
      `${origin}/sign-in`,
    ]);
    try {
      await cdp.send('Browser.getVersion');
      await expect
        .poll(
          async () => {
            const { targetInfos } = await cdp.send<{
              targetInfos: Array<{ type: string; title: string }>;
            }>('Target.getTargets');
            return targetInfos.some((t) => t.type === 'page' && t.title === 'signed in');
          },
          { timeout: 15_000 }
        )
        .toBe(true);
      const state = await collectStorageState(cdp);
      // Only what Chrome holds for the page's own origin, whatever the page says.
      expect(state.origins).toEqual([
        { origin, localStorage: [{ name: 'agent_token', value: 'from-page-storage' }] },
      ]);
      await writeStorageState(stateFile, state);
    } finally {
      await cdp.close();
    }

    expect(fs.statSync(stateFile).mode & 0o777).toBe(0o600);

    // Two agents, two isolated browsers, started at the same time.
    const connection = agentBrowserConnection(stateFile);
    const agents = await Promise.all(
      [1, 2].map(async () => {
        const client = new Client({ name: 'agent-browser-smoke', version: '1.0.0' });
        await client.connect(
          new StdioClientTransport({
            command: connection.command,
            args: connection.args,
            stderr: 'ignore',
          })
        );
        return client;
      })
    );
    try {
      const pages = await Promise.all(
        agents.map((client) =>
          client.callTool({ name: 'browser_navigate', arguments: { url: `${origin}/whoami` } })
        )
      );
      for (const page of pages) {
        const text = JSON.stringify(page.content);
        expect(text).toContain('sent=agent_session=signed-in');
        expect(text).toContain('storage=from-page-storage');
      }
    } finally {
      await Promise.all(agents.map((client) => client.close()));
    }
  }, 180_000);

  it('starts a working, signed-out browser from an empty session file', async () => {
    const stateFile = path.join(root, 'empty', 'storage-state.json');
    await writeStorageState(stateFile, { cookies: [], origins: [] });
    const connection = agentBrowserConnection(stateFile);
    const client = new Client({ name: 'agent-browser-smoke', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: connection.command,
        args: connection.args,
        stderr: 'ignore',
      })
    );
    try {
      const page = await client.callTool({
        name: 'browser_navigate',
        arguments: { url: `${origin}/whoami` },
      });
      expect(page.isError).not.toBe(true);
      const text = JSON.stringify(page.content);
      expect(text).toContain('sent= storage=null');
    } finally {
      await client.close();
    }
  }, 120_000);
});
