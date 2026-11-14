/** QA-only headed proof. Arm in sealed Linux Docker after the launch cut; never on the Mac. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, it } from 'vitest';

type Backend = typeof import('../playwright-backend.js');
type Context = Awaited<ReturnType<Backend['productionBackend']['launch']>>;
type CDP = Awaited<ReturnType<Context['newCDPSession']>>;
// Captured before any other test can stub environment. The normal unit suite never launches Chrome.
const armed = process.env.DORKOS_BROWSER_POPUP_PROOF === '1';
const output = process.env.DORKOS_BROWSER_POPUP_PROOF_OUTPUT;
const display = process.env.DISPLAY;
const root = path.resolve(import.meta.dirname, '../../../../../../..');
const receipts: Record<string, unknown>[] = [];
let runtime: { service: typeof import('../service.js'); backend: Backend };
let revision: string;

async function evaluate<T>(client: CDP, expression: string): Promise<T> {
  const response = await client.send(
    'Runtime.evaluate',
    {
      expression,
      userGesture: false,
      awaitPromise: true,
      returnByValue: true,
    },
    { timeout: 10_000 }
  );
  assert(!response.exceptionDetails, 'Proof expression failed');
  return response.result.value as T;
}

const html = `<!doctype html><title>Synthetic sign-in</title>
<button id="start">Start delayed sign-in</button>
<button id="person">Open sign-in popup</button>
<form id="signin" target="proof-popup" action="https://login.popup-proof.example/popup"></form>
<iframe src="https://frame.other-proof.example/frame"></iframe>
<script>
window.arm = (kind, delay) => setTimeout(() => {
  console.log('proof-attempt');
  if (kind === 'window') window.open('https://login.popup-proof.example/popup', 'proof-popup');
  else document.getElementById('signin').submit();
}, delay);
document.getElementById('start').onclick = () => window.arm(new URL(location).searchParams.get('kind') || 'window', 850);
document.getElementById('person').onclick = () => window.open('https://login.popup-proof.example/popup', 'proof-popup');
</script>`;

function hostileHTML(url: URL): string {
  const round = Number(url.searchParams.get('round') ?? 1);
  assert([1, 2, 3].includes(round));
  if (url.pathname === '/hostile-frame')
    return `<!doctype html><title>Hostile frame ${round}</title><script>
      setTimeout(() => {
        console.log('proof-attempt-frame-${round}');
        window.open('https://login.popup-proof.example/popup', 'proof-popup');
      }, 850);
    </script>`;
  return `<!doctype html><title>Hostile reload ${round}</title>
    <iframe src="/hostile-frame?round=${round}"></iframe><script>
      console.log('proof-hostile-load-${round}');
      // A detached link bypasses the advisory document capture listener.
      addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
          console.log('proof-attempt-detached-${round}');
          const link = document.createElement('a');
          link.href = 'https://login.popup-proof.example/popup';
          link.target = 'proof-popup';
          link.click();
        }, 650);
        if (${round} < 3) setTimeout(() => location.reload(), 1500);
      });
    </script>`;
}

async function rig(kind: string) {
  const directory = await mkdtemp(path.join(tmpdir(), 'popup-focus-proof-'));
  let context: Context | undefined;
  let scripts = 0;
  let hostileLoads = 0;
  const service = new runtime.service.LocalBrowserService(
    directory,
    undefined,
    {
      ...runtime.backend.productionBackend,
      launch: async (...args) => {
        context = await runtime.backend.productionBackend.launch(...args);
        await context.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (
            !url.hostname.endsWith('.popup-proof.example') &&
            url.hostname !== 'frame.other-proof.example'
          )
            return route.abort();
          if (url.pathname === '/ran') {
            scripts++;
            return route.fulfill({ body: 'recorded' });
          }
          if (url.pathname === '/popup')
            return route.fulfill({
              contentType: 'text/html',
              body: '<script>if(window.name==="proof-popup")fetch("https://marker.popup-proof.example/ran")</script>Sign in',
            });
          if (url.pathname === '/hostile') url.searchParams.set('round', String(++hostileLoads));
          if (url.pathname === '/hostile' || url.pathname === '/hostile-frame')
            return route.fulfill({ contentType: 'text/html', body: hostileHTML(url) });
          if (url.pathname === '/frame')
            return route.fulfill({
              contentType: 'text/html',
              body: html.replace(/<iframe.*?<\/iframe>/, ''),
            });
          return route.fulfill({ contentType: 'text/html', body: html });
        });
        return context;
      },
    },
    undefined,
    () => ({ platform: 'linux', display }),
    () => [],
    () => []
  );
  service.useAgentIdentityLookup(async () => 'made-up-kestrel');
  service.windowNames.use(async () => 'Kestrel');
  service.handover.useOutsideTurnCheck(async () => false);
  try {
    await service.open({
      mode: 'new-window',
      sessionId: 'popup-proof-chat',
      url: `https://chat.popup-proof.example/?kind=${kind}`,
    });
    assert(context);
    const page = context
      .pages()
      .find((page) => page.url().startsWith('https://chat.popup-proof.example/'))!;
    assert(page);
    await page.waitForLoadState('load');
    const browser = context.browser();
    assert(browser, 'The production browser must expose its owned browser session');
    const browserCDP = await browser.newBrowserCDPSession();
    receipts.at(-1)!.browser = await browserCDP.send('Browser.getVersion');
    const observerPromise = context.waitForEvent('page');
    const created = await browserCDP.send('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
    });
    const observer = await observerPromise;
    const observerCDP = await context.newCDPSession(observer);
    assert.equal(
      (await observerCDP.send('Target.getTargetInfo')).targetInfo.targetId,
      created.targetId
    );
    await observer.goto('https://observer.popup-proof.example/');
    let attempts = 0;
    const hostileEvents = new Set<string>();
    page.on('console', (message) => {
      const text = message.text();
      if (text.startsWith('proof-attempt')) attempts++;
      if (text.startsWith('proof-attempt-') || text.startsWith('proof-hostile-load-'))
        hostileEvents.add(text);
    });
    const pageCDP = await context.newCDPSession(page);
    await browserCDP.send('Target.setDiscoverTargets', { discover: true });
    const targets: string[] = [];
    browserCDP.on('Target.targetCreated', ({ targetInfo }) => {
      if (targetInfo.type === 'page') targets.push(targetInfo.targetId);
    });
    return {
      service,
      page,
      observer,
      pageCDP,
      observerCDP,
      browserCDP,
      targets,
      hostileEvents,
      scripts: () => scripts,
      async watch() {
        await observer.bringToFront(); // Explicit person focus before the measured interval.
        await evaluate(
          observerCDP,
          'window.losses=0;window.addEventListener("blur",()=>window.losses++);document.hasFocus()'
        ).then((focused) => assert.equal(focused, true));
      },
      async assertHeldFocus(duration = 1500) {
        // A bounded negative observation is the assertion, not a browser readiness sleep.
        // It spans the regression's 650–1010ms timers and delayed popup creation/focus.
        const focus = await evaluate<{ focused: boolean; losses: number }>(
          observerCDP,
          `new Promise(resolve=>setTimeout(()=>resolve({focused:document.hasFocus(),losses:window.losses}),${duration}))`
        );
        assert(attempts > 0, 'The fixture timer must actually fire; a throttled timer is no pass');
        assert.deepEqual(focus, { focused: true, losses: 0 });
        assert.deepEqual(targets, [], 'No transient popup target may be created');
        assert.equal(scripts, 0, 'No popup payload may run before a broker closes it');
      },
      async close() {
        await browserCDP.detach();
        await observerCDP.detach();
        await pageCDP.detach();
        await service.disconnect();
        await rm(directory, { recursive: true });
      },
    };
  } catch (error) {
    await service.disconnect().catch(() => undefined);
    await rm(directory, { recursive: true });
    throw error;
  }
}

async function record(name: string, exercise: () => Promise<void>) {
  const row: Record<string, unknown> = { name, revision, status: 'running' };
  receipts.push(row);
  try {
    await exercise();
    row.status = 'passed';
  } catch (error) {
    row.status = 'failed';
    row.error = String(error);
    throw error;
  } finally {
    await writeFile(
      path.join(output!, 'popup-focus.json'),
      JSON.stringify(receipts, null, 2) + '\n'
    );
  }
}

describe.runIf(armed)('real Chromium popup activation and focus @sealed-docker', () => {
  beforeAll(async () => {
    assert(
      process.platform === 'linux' && existsSync('/.dockerenv'),
      'Run only in sealed Linux Docker, never the Mac host'
    );
    assert(display?.trim(), 'A headed Xvfb display is required');
    assert(
      output && path.isAbsolute(output),
      'Set a new absolute DORKOS_BROWSER_POPUP_PROOF_OUTPUT directory'
    );
    const git = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: root });
    revision = git.stdout.trim();
    assert(/^[a-f0-9]{40}$/.test(revision));
    const status = await promisify(execFile)(
      'git',
      ['status', '--porcelain', '--untracked-files=no'],
      { cwd: root }
    );
    assert.equal(status.stdout, '', 'Freeze the exact committed proof source');
    await mkdir(output, { recursive: false, mode: 0o700 });
    runtime = {
      service: await import('../service.js'),
      backend: await import('../playwright-backend.js'),
    };
    runtime.backend.assertLocalPlaywrightVersion();
    const { installedChromePath } = await import('../connection/chrome-installation.js');
    const requireServer = createRequire(path.join(root, 'apps/server/package.json'));
    const core = requireServer('playwright-core') as { chromium: { executablePath(): string } };
    await access(installedChromePath() ?? core.chromium.executablePath()); // No download fallback.
    await writeFile(
      path.join(output, 'candidate.json'),
      JSON.stringify({
        revision,
        playwright: runtime.backend.LOCAL_PLAYWRIGHT_VERSION,
        managedChromium: runtime.backend.LOCAL_MANAGED_CHROMIUM_VERSION,
      })
    );
  });

  it('a no-click timer immediately after Show opens nothing, including form targets and frames', async () => {
    for (const kind of ['window', 'form'])
      for (const delay of [650, 850, 1010])
        for (const source of ['main', 'frame']) {
          await record(`1.5-${kind}-${delay}-${source}`, async () => {
            const f = await rig(kind);
            try {
              const handoff = await f.service.handover.ask('popup-proof-chat', 'password');
              await f.service.handover.signIn({ handoffId: handoff.handoffId });
              assert.equal((await f.service.handover.state('popup-proof-chat')).handoffTaken, true);
              if (source === 'main')
                await evaluate(f.pageCDP, `window.arm(${JSON.stringify(kind)},${delay})`);
              else {
                const frame = f.page
                  .frames()
                  .find((frame) => frame.url().startsWith('https://frame.other-proof.example/'))!;
                assert(frame);
                const frameCDP = await f.page.context().newCDPSession(frame);
                try {
                  await evaluate(frameCDP, `window.arm(${JSON.stringify(kind)},${delay})`);
                } finally {
                  await frameCDP.detach();
                }
              }
              await f.watch();
              await f.assertHeldFocus();
              if (kind === 'window' && delay === 1010 && source === 'main') {
                // Positive control: popup blocking must still admit a genuine person click in 1.5.
                const opened = f.page.waitForEvent('popup');
                await f.page.getByRole('button', { name: 'Open sign-in popup' }).click();
                const popup = await opened;
                assert.equal(popup.isClosed(), false);
                await popup.close();
              }
            } finally {
              await f.close();
            }
          });
        }
  }, 300_000);

  it('focus holds through ask_person and a handoff, including an agent click and form target', async () => {
    for (const kind of ['window', 'form'])
      for (const agentClick of [false, true]) {
        await record(`1.4-${kind}-${agentClick ? 'agent-click' : 'ask-only'}`, async () => {
          const f = await rig(kind);
          try {
            const observed = agentClick ? await f.service.observe('popup-proof-chat') : null;
            await f.watch();
            if (observed)
              await f.service.action(
                {
                  kind: 'click',
                  revision: observed.revision,
                  role: 'button',
                  name: 'Start delayed sign-in',
                },
                'popup-proof-chat'
              );
            else await evaluate(f.pageCDP, `window.arm(${JSON.stringify(kind)},850)`);
            await f.service.handover.ask('popup-proof-chat', 'password');
            assert.equal((await f.service.handover.state('popup-proof-chat')).handoffTaken, false);
            await assert.rejects(() => f.service.observe('popup-proof-chat'), {
              code: 'handed_to_person',
            });
            await f.assertHeldFocus();
          } finally {
            await f.close();
          }
        });
      }
  }, 300_000);

  it('a hostile page cannot gain popup activation from titles across repeated loads', async () => {
    await record('agent-held-hostile-reloads', async () => {
      const f = await rig('window');
      try {
        await f.watch();
        // Navigate without an agent click or an activating Playwright evaluation.
        await f.pageCDP.send('Page.navigate', {
          url: 'https://chat.popup-proof.example/hostile',
        });
        // Bounded negative observation spans all three self-driven document loads.
        await f.assertHeldFocus(7000);
        const expected = [1, 2, 3].flatMap((round) => [
          `proof-hostile-load-${round}`,
          `proof-attempt-detached-${round}`,
          `proof-attempt-frame-${round}`,
        ]);
        assert.deepEqual(
          [...f.hostileEvents].sort(),
          expected.sort(),
          'Every reload and both hostile paths must run'
        );
        receipts.at(-1)!.hostileEvents = [...f.hostileEvents].sort();
      } finally {
        await f.close();
      }
    });
  }, 300_000);
});
