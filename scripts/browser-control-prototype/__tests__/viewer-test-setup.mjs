import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPlaywright } from '../runtime.mjs';
import { startFixture } from '../fixture.mjs';
import { BrowserManager } from '../manager.mjs';
import { PrototypeControl } from '../control.mjs';
import { startViewer } from '../viewer.mjs';
const runtime = await loadPlaywright({
  repoRoot: resolve(new URL('../../../', import.meta.url).pathname),
});
export async function setupViewer(t) {
  const cleanups = [];
  let cleanupStarted = false;
  t.after(async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    const errors = [];
    for (const close of cleanups.reverse()) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Viewer test cleanup failed');
  });
  const fixture = await startFixture();
  cleanups.push(() => fixture.close());
  const root = await mkdtemp(join(tmpdir(), 'browser-viewer-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const manager = new BrowserManager({ profilesDir: root, runtime, fixtureOrigin: fixture.url });
  cleanups.push(() => manager.shutdown());
  const browser = await manager.openClean();
  const tab = manager.getTab(browser.tabIds[0]);
  await tab.page.goto(fixture.url + '/?marker=CANONICAL-A');
  const viewer = await startViewer({
    manager,
    createControl: (origin) =>
      new PrototypeControl({ manager, origin, fixtureOrigin: fixture.url }),
    frameIntervalMs: 50,
  });
  cleanups.push(() => viewer.close());
  const frontend = await runtime.chromium.launch(runtime.launchOptions);
  cleanups.push(() => frontend.close());
  const agent = viewer.control.issueParticipant({
    actorId: 'agent-a',
    kind: 'agent',
    tabIds: [tab.tabId],
    canControl: true,
  });
  const human = viewer.control.issueParticipant({
    actorId: 'human-a',
    kind: 'human',
    tabIds: [tab.tabId],
    canControl: true,
  });
  const observer = viewer.control.issueParticipant({
    actorId: 'observer-a',
    kind: 'human',
    tabIds: [tab.tabId],
    canControl: false,
  });
  await viewer.control.acquire(agent, tab.tabId).barrier;
  async function open(token) {
    const page = await frontend.newPage({ viewport: { width: 1000, height: 1000 } });
    await page.addInitScript(() => {
      const clipboard = { text: '', denied: false };
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          readText: async () => {
            if (clipboard.denied) throw Error('fixture-permission-denied');
            return clipboard.text;
          },
          writeText: async (value) => {
            if (clipboard.denied) throw Error('fixture-permission-denied');
            clipboard.text = value;
          },
        },
      });
      globalThis.fixtureClipboard = {
        seed: (value) => {
          clipboard.text = value;
        },
        deny: (value) => {
          clipboard.denied = value;
        },
      };
    });
    await page.goto(viewer.url);
    await page.evaluate(({ token, tabId }) => globalThis.viewer.connect({ token, tabId }), {
      token,
      tabId: tab.tabId,
    });
    await page.waitForFunction(() => globalThis.viewer.current()?.captureSequence > 0);
    return page;
  }
  return { root, fixture, manager, tab, viewer, frontend, agent, human, observer, open };
}
