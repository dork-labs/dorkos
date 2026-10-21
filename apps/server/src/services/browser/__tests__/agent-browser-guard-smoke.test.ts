/**
 * Real-Chrome smoke test for the agent browser's Cloud block (DOR-3196): the
 * exact connection `guardAgentBrowsers` hands a runtime, run through the
 * pinned `@playwright/mcp`, never reaches the Cloud origin by any path.
 *
 * A local server plays both an ordinary site and "Cloud": a Chrome host rule
 * sends the Cloud hosts to it, so a request that got through would be
 * counted. A first, unguarded browser proves that mapping works (it reaches
 * fake Cloud through a redirect). The guarded browser gets the same mapping
 * added AFTER DorkOS's own rules (Chrome takes the first rule that matches),
 * then tries a direct visit to the root and to a path, a subdomain, the
 * website, a redirect, a redirect to a subdomain, an iframe, a popup and a
 * page fetch. Fake Cloud must see none of them, while the ordinary site still
 * loads with its saved cookie.
 *
 * It needs the system Chrome and `npx`, so it never runs in CI or in
 * `pnpm test`: it is armed only by `DORKOS_BROWSER_SMOKE=1`, which no task
 * passes through. Run it by hand:
 *
 *   DORKOS_BROWSER_SMOKE=1 pnpm vitest run \
 *     apps/server/src/services/browser/__tests__/agent-browser-guard-smoke.test.ts
 *
 * Every file it touches lives in a temp directory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { agentBrowserConnection } from '@dorkos/shared/agent-browser';
import { cloudOriginEntries } from '@dorkos/shared/cloud-origin';
import { guardAgentBrowsers } from '../agent-browser-guard.js';

/**
 * Read once at module scope, so no other file's env stubbing can blank it. A
 * test-only arming flag, so it is deliberately not in the server's env schema.
 */
const ARMED = process.env.DORKOS_BROWSER_SMOKE === '1';

type Browser = {
  call: (name: string, args: Record<string, unknown>) => Promise<string>;
  close: () => Promise<void>;
};

async function startBrowser(args: string[], cwd: string): Promise<Browser> {
  const client = new Client({ name: 'dor-3196-smoke', version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: 'npx',
      args,
      cwd,
      env: { ...process.env } as Record<string, string>,
    })
  );
  return {
    call: async (name, input) => {
      const result = await client.callTool({ name, arguments: input });
      const content = (result.content ?? []) as Array<{ text?: string }>;
      return content.map((part) => part.text ?? '').join('\n');
    },
    close: () => client.close(),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));

describe.skipIf(!ARMED)('agent browser Cloud block (real Chrome smoke)', () => {
  let root: string;
  let server: http.Server;
  let site: string;
  const cloudHits: string[] = [];
  const siteCookies: string[] = [];

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(tmpdir(), 'dorkos-cloud-block-smoke-'));
    server = http.createServer((req, res) => {
      const host = req.headers.host ?? '';
      if (host.includes('dorkos.ai')) {
        cloudHits.push(`${host}${req.url}`);
        res.end('fake cloud');
        return;
      }
      siteCookies.push(req.headers.cookie ?? '');
      res.setHeader('Content-Type', 'text/html');
      const redirect = (to: string) => {
        res.writeHead(302, { Location: to });
        res.end();
      };
      if (req.url === '/to-cloud') return redirect('http://cloud.dorkos.ai/any/path');
      if (req.url === '/to-cloud-sub') return redirect('http://app.cloud.dorkos.ai/');
      if (req.url === '/framed')
        return res.end('<iframe src="http://cloud.dorkos.ai/frame"></iframe>');
      res.end('<title>ordinary site</title>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    site = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('never lets the guarded agent browser reach the Cloud origin, and leaves other sites alone', async () => {
    const dorkHome = path.join(root, 'dork');
    const stateFile = path.join(dorkHome, 'browser', 'storage-state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const cookie = (domain: string, name: string) => ({
      name,
      value: 'v',
      domain,
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    });
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        cookies: [cookie('cloud.dorkos.ai', 'cloud_session'), cookie('127.0.0.1', 'site_session')],
        origins: [],
      })
    );
    // Sends every DorkOS host to the local server, so a request that got through is counted.
    const port = new URL(site).port;
    const mapping = ['dorkos.ai', '*.dorkos.ai', 'dorkos.ai.', '*.dorkos.ai.']
      .map((host) => `MAP ${host} 127.0.0.1:${port}`)
      .join(', ');
    const mappingFile = path.join(root, 'mapping.json');
    fs.writeFileSync(
      mappingFile,
      JSON.stringify({ browser: { launchOptions: { args: [`--host-resolver-rules=${mapping}`] } } })
    );
    const connection = agentBrowserConnection(stateFile);

    // Control: unguarded, a redirect reaches fake Cloud.
    const unguarded = await startBrowser([...connection.args, '--config', mappingFile], root);
    await unguarded.call('browser_navigate', { url: `${site}/to-cloud` }).catch(() => '');
    await unguarded.close();
    expect(cloudHits.length).toBeGreaterThan(0);
    cloudHits.length = 0;

    const guarded = guardAgentBrowsers(
      { browser: connection },
      { dorkHome, entries: cloudOriginEntries() }
    );
    expect(fs.readFileSync(stateFile, 'utf8')).not.toContain('cloud_session');
    const guardedArgs = guarded.browser!.args;
    const configFile = guardedArgs[guardedArgs.indexOf('--config') + 1]!;
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8')) as {
      browser: { launchOptions: { args: string[] } };
    };
    config.browser.launchOptions.args = config.browser.launchOptions.args.map(
      (arg) => `${arg}, ${mapping}`
    );
    fs.writeFileSync(configFile, JSON.stringify(config));
    const browser = await startBrowser(guardedArgs, root);
    try {
      const direct = await browser.call('browser_navigate', { url: 'http://cloud.dorkos.ai/' });
      expect(direct).toContain('net::ERR_BLOCKED_BY_CLIENT');
      await browser.call('browser_navigate', { url: 'http://cloud.dorkos.ai/any/path' });
      await browser.call('browser_navigate', { url: 'https://app.cloud.dorkos.ai/' });
      await browser.call('browser_navigate', { url: 'http://dorkos.ai/any/path' });
      // The fully qualified, trailing-dot spelling is a different host to Chrome.
      for (const url of [
        'http://cloud.dorkos.ai./',
        'http://cloud.dorkos.ai./any/path',
        'http://app.cloud.dorkos.ai./',
        'http://dorkos.ai./',
      ]) {
        expect(await browser.call('browser_navigate', { url })).toContain(
          'net::ERR_BLOCKED_BY_CLIENT'
        );
      }
      const redirected = await browser.call('browser_navigate', { url: `${site}/to-cloud` });
      expect(redirected).toContain('net::ERR_NAME_NOT_RESOLVED');
      await browser.call('browser_navigate', { url: `${site}/to-cloud-sub` });
      await browser.call('browser_navigate', { url: `${site}/framed` });
      await settle();
      await browser.call('browser_navigate', { url: `${site}/` });
      await browser.call('browser_evaluate', {
        function: `() => { window.open('http://cloud.dorkos.ai/popup'); return Promise.all(['http://cloud.dorkos.ai/fetch', 'http://cloud.dorkos.ai./fetch'].map((u) => fetch(u, { credentials: 'include' }).then(() => 'ok', () => 'refused'))); }`,
      });
      await settle();
      expect(cloudHits).toEqual([]);
      // Control: the ordinary site loads, with its own saved sign-in.
      siteCookies.length = 0;
      const ordinary = await browser.call('browser_navigate', { url: `${site}/` });
      expect(ordinary).toContain('ordinary site');
      expect(siteCookies.some((header) => header.includes('site_session=v'))).toBe(true);
    } finally {
      await browser.close();
    }
  }, 180_000);
});
