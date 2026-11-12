/** Runs only in CI: real production browser code, invented profile, public pages, no sign-in. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { BrowserContext } from 'playwright-core';
import { LocalBrowserService } from '../../../server/src/services/session/local-browser/service.js';
import { BrowserHandover } from '../../../server/src/services/session/local-browser/handover.js';
import { SignInWindow } from '../../../server/src/services/session/local-browser/sign-in-window.js';
import { productionBackend } from '../../../server/src/services/session/local-browser/playwright-backend.js';
import {
  FORBIDDEN_PLAIN_FLAGS,
  spawnPlainChromium,
  profileLockPid,
  type PlainChromium,
} from '../../../server/src/services/session/local-browser/plain-chromium.js';
import { installedChromePath } from '../../../server/src/services/session/local-browser/connection/chrome-installation.js';

const run = promisify(execFile);
const evidence = process.env.DORKOS_PUBLIC_CHROME_ARTIFACTS!;
assert.equal(process.env.CI, 'true');
assert.equal(process.platform, 'darwin');
assert(installedChromePath(), 'Install Google Chrome before the public-site proof');
await mkdir(evidence, { recursive: true });
let context: BrowserContext | undefined;
let agentPid: number | undefined;
let plain: PlainChromium | undefined;
const signIns = new SignInWindow({
  spawner(executable, args) {
    assert.equal(executable, installedChromePath());
    assert(
      !args.some((arg) =>
        FORBIDDEN_PLAIN_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`))
      )
    );
    plain = spawnPlainChromium(executable, args);
    return plain;
  },
});
const backend = {
  ...productionBackend,
  async launch(...args: Parameters<typeof productionBackend.launch>) {
    context = await productionBackend.launch(...args);
    agentPid = profileLockPid(args[0]);
    assert(agentPid, 'The throwaway agent profile must name its own Chrome process');
    return context;
  },
};
const browser = new LocalBrowserService(process.env.DORK_HOME!, undefined, backend);
const handover = new BrowserHandover(browser, signIns, () => process.env.DORK_HOME!);
handover.useOutsideTurnCheck(async () => false);
type Identity = {
  ua: string;
  brands: { brand: string; version: string }[];
  webdriver: boolean;
  headers?: Record<string, unknown>;
};
let receipt: Identity | undefined;
const echo = createServer((request, response) => {
  if (request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      receipt = { ...JSON.parse(body), headers: request.headers };
      response.end('saved');
    });
  } else {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<h1>Made-up browser check</h1><pre id="result"></pre><script>
      const identity={ua:navigator.userAgent,brands:navigator.userAgentData.brands,webdriver:navigator.webdriver};
      document.querySelector('#result').textContent=JSON.stringify(identity,null,2);
      fetch(location.href,{method:'POST',body:JSON.stringify(identity)});
    </script>`);
  }
});
async function until<T>(read: () => Promise<T | undefined>, timeout = 30000): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw new Error('The browser proof did not reach its expected page');
}
/**
 * The window is plain Chrome by every identity check. `webdriver` is the honest answer for who
 * drives it: `true` in the agent's own window, which the agent drives, and `false` in the person's
 * handoff window, which nothing drives (the PM's ruling, DOR-4178: never hide that an agent drives).
 */
function assertIdentity(identity: Identity, agentDriven: boolean): void {
  assert.doesNotMatch(identity.ua, /electron|dorkos/i);
  assert.equal(identity.webdriver, agentDriven);
  const chrome = identity.brands.find((item) => item.brand === 'Google Chrome');
  assert(chrome);
  assert.equal(chrome.version, /Chrome\/(\d+)/.exec(identity.ua)?.[1]);
  if (identity.headers)
    assert(String(identity.headers['sec-ch-ua']).includes(`"Google Chrome";v="${chrome.version}"`));
}
/**
 * `webdriver === false` in the person's window counts only if nothing drives it (Security's
 * condition, DOR-4178). Its launch flags are checked in the spawner above, against
 * `FORBIDDEN_PLAIN_FLAGS` (both debugging flags among them). Here: it is its own Chrome process,
 * the agent's Chrome did not start it, and the agent's Playwright connection gained no page.
 *
 * @param agentPages - The agent connection's pages just before the handoff.
 */
async function assertNothingDrivesPerson(agentPages: ReadonlySet<unknown>): Promise<void> {
  assert(plain?.pid, 'The person’s window must be its own process');
  assert(agentPid, 'The agent window’s process must be known');
  assert.notEqual(plain.pid, agentPid, 'The person’s window must not be the agent’s Chrome');
  const { stdout } = await run('/bin/ps', ['-o', 'ppid=', '-p', String(plain.pid)]);
  assert.notEqual(Number(stdout.trim()), agentPid, 'The agent’s Chrome must not start it');
  for (const page of context?.pages() ?? [])
    assert(agentPages.has(page), 'The person’s window must not join the agent’s connection');
}
async function pixels(
  name: string,
  ready: (text: string) => boolean,
  pid = plain?.pid
): Promise<string> {
  const file = path.join(evidence, `${name}.png`);
  const helper = fileURLToPath(new URL('./capture-window.swift', import.meta.url));
  return until(async () => {
    if (!pid) return undefined;
    try {
      const { stdout } = await run('/usr/bin/swift', [helper, String(pid), file], {
        timeout: 15000,
      });
      return ready(stdout) ? stdout : undefined;
    } catch {
      return undefined;
    }
  }, 60000);
}
try {
  await new Promise<void>((resolve) => echo.listen(0, '127.0.0.1', resolve));
  const address = echo.address();
  assert(address && typeof address !== 'string');
  const pages = [
    ['echo', `http://127.0.0.1:${address.port}/`],
    ['browserscan', 'https://www.browserscan.net/bot-detection'],
    ['godaddy', 'https://sso.godaddy.com/'],
  ] as const;
  await browser.open({ mode: 'new-window', sessionId: 'made-up-ci-browser' });
  for (const [name, url] of pages) {
    const page = context!.pages()[0]!;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (name === 'godaddy')
      await page.locator('input[type="password"]').waitFor({ state: 'visible', timeout: 30000 });
    if (name === 'browserscan')
      await page.getByText('Test Results:', { exact: false }).first().waitFor();
    const identity = await page.evaluate(() => ({
      ua: navigator.userAgent,
      brands: (
        navigator as Navigator & { userAgentData: { brands: { brand: string; version: string }[] } }
      ).userAgentData.brands,
      webdriver: navigator.webdriver,
    }));
    assertIdentity(identity, true);
    if (name === 'echo') {
      const echoed = await until(async () => receipt);
      assertIdentity(echoed, true);
      await writeFile(
        path.join(evidence, 'agent-ua-and-client-hints.json'),
        JSON.stringify(echoed, null, 2)
      );
    }
    await writeFile(
      path.join(evidence, `${name}-agent-ua.json`),
      JSON.stringify(identity, null, 2)
    );
    await page.screenshot({ path: path.join(evidence, `${name}-agent.png`) });
    await pixels(
      `${name}-agent-native`,
      (text) =>
        name === 'echo'
          ? text.includes('Made-up browser check')
          : name === 'godaddy'
            ? /password/i.test(text) && /username|customer|email/i.test(text)
            : /Test Results|Webdriver/i.test(text),
      agentPid
    );
    receipt = undefined;
    const agentPages = new Set(context?.pages() ?? []);
    const { handoffId } = await handover.ask('made-up-ci-browser', 'wall');
    const text = await pixels(`${name}-person`, (text) =>
      name === 'echo'
        ? text.includes('Made-up browser check')
        : name === 'godaddy'
          ? /password/i.test(text) && /username|customer|email/i.test(text)
          : /Test Results|Webdriver/i.test(text)
    );
    await writeFile(path.join(evidence, `${name}-person-ocr.txt`), text);
    await assertNothingDrivesPerson(agentPages);
    if (name === 'echo') {
      const identity = await until(async () => receipt);
      assertIdentity(identity, false);
      await writeFile(
        path.join(evidence, 'person-ua-and-client-hints.json'),
        JSON.stringify(identity, null, 2)
      );
    }
    if (name === 'godaddy')
      assert.doesNotMatch(
        text,
        /unusual browser|browser looks|access denied|verify you are human/i
      );
    if (name === 'godaddy') {
      await handover.stop(handoffId);
      assert.equal(signIns.active, true, 'Stop must leave the hook-free window open');
    }
    signIns.close();
    await until(async () => (signIns.current?.status === 'saved' ? true : undefined));
    if (name !== 'godaddy') await handover.handBack(handoffId);
  }
  await writeFile(
    path.join(evidence, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        typedNothing: true,
        signedIn: false,
        realProfileUsed: false,
        stopLeftDetached: true,
      },
      null,
      2
    )
  );
} finally {
  signIns.close();
  if (plain) await plain.exited;
  await browser.disconnect();
  await new Promise<void>((resolve) => echo.close(() => resolve()));
}
