/** Import-safe assertions for QA's exclusively owned installed browser fixture. Starts no browser. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { assertOwnedBrowserProofHome } from './local-browser-installed-proof';
import { ensureTestOwner, actAsPersonInPage } from '../fixtures/person-step-up';
import { LocalBrowserPage } from './LocalBrowserPage';

const exec = promisify(execFile);
type CensusRunner = (command: string, args: string[]) => Promise<{ stdout: string }>;
const runCensus: CensusRunner = async (command, args) => {
  try {
    return await exec(command, args, { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 });
  } catch (error) {
    // lsof uses 1 for an empty selection. Other failures must never read as a clean census.
    const result = error as { code?: number; stdout?: string; stderr?: string };
    if (command === 'lsof' && result.code === 1 && !result.stdout && !result.stderr)
      return { stdout: '' };
    throw error;
  }
};

/** A physical socket census, restricted to Chrome descendants of the proven fixture server. */
export async function assertNoBrowserDebugListener(serverPid: number, run = runCensus) {
  expect(Number.isSafeInteger(serverPid) && serverPid > 0).toBe(true);
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,ppid=,comm=']);
  const rows = stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), name: match[3]! }] : [];
  });
  expect(
    rows.some((row) => row.pid === serverPid),
    'Owned server must still exist'
  ).toBe(true);
  const owned = new Set([serverPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (owned.has(row.parent) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
  }
  const chrome = rows.filter(
    (row) => owned.has(row.pid) && /chrome|chromium|headless_shell/i.test(row.name)
  );
  expect(chrome.length, 'The fixture must have owned Chrome processes').toBeGreaterThan(0);
  const listeners = await run('lsof', [
    '-nP',
    '-a',
    '-p',
    chrome.map((row) => row.pid).join(','),
    '-iTCP',
    '-sTCP:LISTEN',
    '-Fp',
  ]);
  expect(listeners.stdout.trim(), 'Owned Chrome must not listen on TCP').toBe('');
  return { checkedBrowserProcesses: chrome.length };
}

/**
 * Call only in sealed CI, with an already open agent page and DORKOS_AGENT_BROWSER_STREAM=true.
 * The caller owns the CLI and its final teardown. No cookies or browser profiles are copied.
 */
export async function proveOwnedBrowserViewer(page: Page, baseURL: string, dataDirectory: string) {
  await assertOwnedBrowserProofHome(page.request, baseURL, dataDirectory);
  const capabilities = await page.request.get(
    new URL('/api/local-browser/capabilities', baseURL).href
  );
  expect(capabilities.ok()).toBe(true);
  expect((await capabilities.json()).watchStream, 'QA must explicitly enable the stream').toBe(
    true
  );
  const port = new URL(baseURL).port;
  expect(port && !['4242', '6241', '6242'].includes(port), 'Use the owned proof port').toBeTruthy();
  const listeners = await runCensus('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
  const pids = [...listeners.stdout.matchAll(/^p(\d+)$/gm)].map((match) => Number(match[1]));
  expect(pids, 'The owned API must have exactly one listening server').toHaveLength(1);
  const before = await assertNoBrowserDebugListener(pids[0]!);
  const ui = new LocalBrowserPage(page);
  await ui.open();
  await expect(
    page.getByRole('status').filter({ hasText: 'Turn on sign-in to watch.' })
  ).toBeVisible();
  const owner = {
    email: `viewer-${randomUUID()}@example.test`,
    password: `fixture-${randomUUID()}`,
    name: 'Viewer fixture owner',
  };
  const registered = await ensureTestOwner(page.request, baseURL, owner);
  expect(registered.ok(), 'Viewer proof requires a fresh isolated owner').toBe(true);
  await actAsPersonInPage(page, baseURL, owner.password);
  await page.reload();
  await ui.open();

  // Only made-up content is displayed, and it exists in memory rather than a saved page fixture.
  const marker = `viewer-content-${randomUUID()}`;
  const fixture = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      `<title>Viewer color fixture</title><body style="margin:0;background:rgb(16,160,96)"><span>${marker}</span></body>`
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  const address = fixture.address();
  if (!address || typeof address === 'string') throw Error('Owned viewer fixture did not bind');
  try {
    const started = Date.now();
    await ui.navigate(`http://127.0.0.1:${address.port}/`);
    const canvas = page.getByRole('img', { name: 'Agent browser page', exact: true });
    await expect(canvas).toBeVisible();
    await expect
      .poll(() =>
        canvas.evaluate((element) => {
          const canvas = element as HTMLCanvasElement;
          const pixel = canvas
            .getContext('2d')!
            .getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
          return (
            Math.abs(pixel[0]! - 16) < 8 &&
            Math.abs(pixel[1]! - 160) < 8 &&
            Math.abs(pixel[2]! - 96) < 8
          );
        })
      )
      .toBe(true);
    const firstPaintFromNavigationMs = Date.now() - started;
    const dimensions = await canvas.evaluate((node) => ({
      width: (node as HTMLCanvasElement).width,
      height: (node as HTMLCanvasElement).height,
    }));
    expect(dimensions.width).toBeGreaterThan(0);
    expect(dimensions.width).toBeLessThanOrEqual(1280);
    expect(dimensions.height).toBeLessThanOrEqual(960);
    const watching = await assertNoBrowserDebugListener(pids[0]!);
    const signedOut = await page.request.post(new URL('/api/auth/sign-out', baseURL).href, {
      headers: { origin: baseURL },
    });
    expect(signedOut.ok()).toBe(true);
    await expect(canvas).toBeHidden();
    await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).width)).toBe(0);
    const storageHasContent = await page.evaluate(
      (planted) =>
        [localStorage, sessionStorage].some((storage) =>
          Array.from({ length: storage.length }, (_, index) =>
            storage.getItem(storage.key(index)!)
          ).some((value) => value?.includes(planted))
        ),
      marker
    );
    expect(storageHasContent).toBe(false);
    const signedOutCensus = await assertNoBrowserDebugListener(pids[0]!);
    return {
      firstPaintFromNavigationMs,
      dimensions,
      ownerRequired: true,
      jpegPainted: true,
      clearedAfterSignOut: true,
      noContentInWebStorage: true,
      before,
      watching,
      signedOutCensus,
    };
  } finally {
    fixture.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      fixture.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
