import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startTestChild } from './child-startup.mjs';
import { loadPlaywright } from '../runtime.mjs';
import { BrowserManager } from '../manager.mjs';
import { processIdentity } from '../profile-reservation.mjs';

const repoRoot = resolve(new URL('../../../', import.meta.url).pathname);
const runtime = await loadPlaywright({ repoRoot });
async function setup(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'browser-manager-'));
  const origin = options.fixtureOrigin ?? (await fixture(t));
  const manager = new BrowserManager({
    profilesDir: root,
    runtime,
    fixtureOrigin: origin,
    ...options,
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return { root, manager };
}
async function fixture(t, forbiddenOrigin = null) {
  const server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: forbiddenOrigin });
      res.end();
      return;
    }
    if (req.url === '/worker.js') {
      res.setHeader('content-type', 'application/javascript');
      res.end(
        `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('message',async e=>{try{const r=await fetch(e.data);e.source.postMessage(r.ok?'reached':'blocked')}catch{e.source.postMessage('blocked')}})`
      );
      return;
    }
    if (req.url === '/missing') {
      res.writeHead(503);
      return res.end('fixture failure');
    }
    res.setHeader('content-type', 'text/html');
    res.end(
      `<h1 id="marker">${req.url === '/popup' ? 'POPUP' : 'ORIGINAL'}</h1><input id="text"><button id="popup" onclick="window.open('/popup')">Popup</button><script>window.inputs=[];window.pointerReleases=[];window.compositions=[];document.addEventListener('keydown',e=>inputs.push({key:e.key,shift:e.shiftKey}));document.addEventListener('mouseup',e=>pointerReleases.push(e.buttons));for(const type of ['compositionstart','compositionupdate','compositionend'])document.addEventListener(type,e=>compositions.push({type,data:e.data}));window.seed=()=>{localStorage.setItem('state','durable');document.cookie='state=durable; max-age=86400; path=/'};window.read=()=>({storage:localStorage.getItem('state'),cookie:document.cookie});window.fail=()=>{console.error('fake fixture error');fetch('/missing');setTimeout(()=>{throw Error('fake fixture error')},0)};</script>`
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  return `http://127.0.0.1:${server.address().port}`;
}

test('durable state survives restart, clean context remains unseeded and durable work runs without viewers', async (t) => {
  // Compare exact stores in two actual Chromium processes and retain canonical IDs.
  const url = await fixture(t);
  const { manager } = await setup(t, { fixtureOrigin: url });
  const durable = await manager.openPersistent('fake-worker');
  const tab = manager.getTab(durable.tabIds[0]);
  await tab.page.goto(url);
  await tab.page.evaluate(() => globalThis.seed());
  const clean = await manager.openClean();
  const cleanTab = manager.getTab(clean.tabIds[0]);
  await cleanTab.page.goto(url);
  assert.deepEqual(await cleanTab.page.evaluate(() => globalThis.read()), {
    storage: null,
    cookie: '',
  });
  await cleanTab.page.evaluate(() => localStorage.setItem('state', 'clean'));
  assert.deepEqual(await tab.page.evaluate(() => globalThis.read()), {
    storage: 'durable',
    cookie: 'state=durable',
  });
  assert.equal(manager.getTab(tab.tabId).tabId, tab.tabId);
  const process = manager.ownedProcess(durable.browserId);
  assert.ok(process?.pid);
  await Promise.all([
    manager.closeBrowser(durable.browserId),
    manager.closeBrowser(durable.browserId),
  ]);
  assert.equal(processIdentity(process.pid), null);
  const reopened = await manager.openPersistent('fake-worker');
  assert.notEqual(reopened.browserId, durable.browserId);
  assert.notEqual(reopened.tabIds[0], tab.tabId);
  const page = manager.getTab(reopened.tabIds[0]).page;
  await page.goto(url);
  assert.deepEqual(await page.evaluate(() => globalThis.read()), {
    storage: 'durable',
    cookie: 'state=durable',
  });
});

test('exact fixture origin fences local navigation, redirects and service-worker fetches', async (t) => {
  // A real second listener is the forbidden subject; a direct positive control proves hits observable.
  let hits = 0;
  const forbidden = createServer((_, response) => {
    hits++;
    response.end('forbidden fake fixture');
  });
  forbidden.listen(0, '127.0.0.1');
  await once(forbidden, 'listening');
  t.after(
    () =>
      new Promise((resolve) => {
        forbidden.closeAllConnections();
        forbidden.close(resolve);
      })
  );
  const otherOrigin = `http://127.0.0.1:${forbidden.address().port}`;
  await fetch(otherOrigin);
  assert.equal(hits, 1);
  hits = 0;
  const url = await fixture(t, otherOrigin);
  const { manager } = await setup(t, { fixtureOrigin: url });
  const browser = await manager.openClean();
  const tabId = browser.tabIds[0];
  const page = manager.getTab(tabId).page;
  await page.goto(url);
  await assert.rejects(manager.dispatchInput(tabId, { type: 'navigate', url: otherOrigin }), {
    code: 'INVALID_URL',
  });
  const swResult = await page.evaluate(async (target) => {
    const registration = await navigator.serviceWorker.register('/worker.js');
    await navigator.serviceWorker.ready;
    const reply = new Promise((resolve) =>
      navigator.serviceWorker.addEventListener('message', (event) => resolve(event.data), {
        once: true,
      })
    );
    registration.active.postMessage(target);
    return reply;
  }, otherOrigin);
  assert.equal(swResult, 'blocked');
  assert.equal(hits, 0, 'A CORS error alone must not certify that worker traffic was fenced.');
  const redirectTab = await page.context().newPage();
  const closed = redirectTab.waitForEvent('close');
  await redirectTab.goto(url + '/redirect').catch(() => {});
  await closed;
  assert.equal(hits, 0);
});

test('concurrent same-profile launch has exactly one winner; popup and captured tab identities stay distinct', async (t) => {
  // Neither opening a popup nor capturing it may change the original action target.
  const url = await fixture(t);
  const { manager } = await setup(t, { fixtureOrigin: url });
  const result = await Promise.allSettled([
    manager.openPersistent('contended'),
    manager.openPersistent('contended'),
  ]);
  assert.equal(result.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(result.filter((entry) => entry.status === 'rejected').length, 1);
  const browser = result.find((entry) => entry.status === 'fulfilled').value;
  const original = manager.getTab(browser.tabIds[0]);
  await original.page.goto(url);
  assert.equal(manager.getTab(original.tabId).navigationGeneration, 1);
  const popupEvent = original.page.waitForEvent('popup');
  await original.page.locator('#popup').click();
  await popupEvent;
  const tabs = manager.listTabs(browser.browserId);
  assert.equal(tabs.length, 2);
  assert.notEqual(tabs[0].tabId, tabs[1].tabId);
  const popup = tabs.find((entry) => entry.tabId !== original.tabId);
  await popup.page.waitForLoadState();
  assert.equal(await original.page.locator('#marker').textContent(), 'ORIGINAL');
  assert.equal(await popup.page.locator('#marker').textContent(), 'POPUP');
  const first = await manager.capture(original.tabId, { epoch: 7 });
  const second = await manager.capture(original.tabId, { epoch: 7 });
  assert.equal(first.receipt.tabId, original.tabId);
  assert.equal(first.receipt.browserId, browser.browserId);
  assert.equal(first.receipt.epoch, 7);
  assert.equal(second.receipt.captureSequence, first.receipt.captureSequence + 1);
  assert.ok(first.bytes.length > 0);
  const resized = await manager.resize(original.tabId, { width: 640, height: 360 });
  assert.equal(resized.viewportVersion, 2);
  const frame = await manager.capture(original.tabId);
  assert.equal(frame.receipt.width, 640);
  assert.equal(frame.receipt.height, 360);
  assert.equal(frame.receipt.viewportVersion, 2);
});

test('held modifiers/buttons reset before subsequent input and aborted actions never start', async (t) => {
  // Exact native key event flags reveal a Shift modifier left held across takeover.
  const url = await fixture(t);
  const { manager } = await setup(t, { fixtureOrigin: url });
  const browser = await manager.openClean();
  const tabId = browser.tabIds[0];
  const page = manager.getTab(tabId).page;
  await page.goto(url);
  await page.locator('#text').focus();
  await manager.dispatchInput(tabId, { type: 'keyDown', key: 'Shift' });
  await manager.dispatchInput(tabId, { type: 'mouseDown', button: 'left' });
  await manager.resetInput(tabId);
  await page.locator('#text').focus();
  await manager.dispatchInput(tabId, { type: 'keyDown', key: 'a' });
  await manager.dispatchInput(tabId, { type: 'keyUp', key: 'a' });
  assert.deepEqual(await page.evaluate(() => globalThis.inputs), [
    { key: 'Shift', shift: true },
    { key: 'a', shift: false },
  ]);
  assert.deepEqual(await page.evaluate(() => globalThis.pointerReleases), [0]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    manager.dispatchInput(
      tabId,
      { type: 'text', text: 'should-not-enter' },
      { signal: controller.signal }
    ),
    { code: 'ACTION_ABORTED' }
  );
  assert.equal(await page.locator('#text').inputValue(), 'a');
});

test('synthetic composition reset cancels preedit and later text reaches the field', async (t) => {
  // CDP composition is mechanical evidence only, not an observation of a native IME.
  const url = await fixture(t);
  const { manager } = await setup(t, { fixtureOrigin: url });
  const browser = await manager.openClean();
  const tabId = browser.tabIds[0];
  const page = manager.getTab(tabId).page;
  await page.goto(url);
  await page.locator('#text').focus();
  await manager.dispatchInput(tabId, { type: 'composition', text: '你好' });
  assert.equal(await page.locator('#text').inputValue(), '你好');
  await manager.resetInput(tabId);
  assert.equal(await page.locator('#text').inputValue(), '');
  const events = await page.evaluate(() => globalThis.compositions);
  assert.equal(events[0].type, 'compositionstart');
  assert.equal(events.at(-1).type, 'compositionend');
  await manager.dispatchInput(tabId, { type: 'text', text: '🙂' });
  assert.equal(await page.locator('#text').inputValue(), '🙂');
});

test('capture refuses navigation changes and oversized frames with bounded outstanding captures', async (t) => {
  // Deliberate stale/oversized capture substitutions must fail the exact receipt guard.
  const { manager } = await setup(t);
  const browser = await manager.openClean();
  const tabId = browser.tabIds[0];
  const page = manager.getTab(tabId).page;
  const realCapture = page.screenshot.bind(page);
  page.screenshot = async () => {
    await page.goto(manager.fixtureOrigin + '/new-generation');
    return realCapture();
  };
  await assert.rejects(manager.capture(tabId), { code: 'STALE_CAPTURE' });
  page.screenshot = async () => Buffer.alloc(2 * 1024 * 1024 + 1);
  await assert.rejects(manager.capture(tabId), /byteLength/);
  let release;
  page.screenshot = () =>
    new Promise((resolve) => {
      release = () => resolve(Buffer.from('fixture-frame'));
    });
  const first = manager.capture(tabId);
  const second = manager.capture(tabId);
  assert.throws(() => manager.capture(tabId), { code: 'CAPTURE_BUSY' });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await second;
  page.screenshot = realCapture;
});

test('diagnostics bound loss and omit page secrets; shutdown waits pending launch and has no browser orphan', async (t) => {
  // Exact owned PID is the positive subject; zero browser inventory alone is insufficient.
  const url = await fixture(t);
  const { manager } = await setup(t, { diagnosticLimit: 2, fixtureOrigin: url });
  const browser = await manager.openClean();
  const tabId = browser.tabIds[0];
  const page = manager.getTab(tabId).page;
  await page.goto(url);
  await page.evaluate(() => {
    console.log('fake-one');
    console.log('fake-two');
    console.log('fake-three');
    console.log('fake-four');
  });
  const entries = manager.diagnostics(tabId);
  assert.equal(entries.entries.length, 2);
  assert.equal(entries.dropped, 2);
  assert.deepEqual(
    entries.entries.map((entry) => entry.sequence),
    [3, 4]
  );
  assert.ok(!JSON.stringify(entries).includes('fake-'));
  const owned = manager.ownedProcess(browser.browserId);
  assert.ok(processIdentity(owned.pid));
  const pending = manager.openClean();
  const closing = manager.shutdown();
  const launched = await pending;
  await closing;
  assert.equal(processIdentity(owned.pid), null);
  assert.equal(processIdentity(manager.ownedProcess(launched.browserId).pid), null);
  await assert.rejects(manager.openClean(), { code: 'MANAGER_STOPPED' });
});

test('missing/corrupt executable refuses before creating profile state', async (t) => {
  // The runtime loader receipt is validated but action-time executable absence still fails.
  const root = await mkdtemp(join(tmpdir(), 'manager-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'absent');
  const missing = {
    ...runtime,
    receipt: { ...runtime.receipt, executablePath: path },
    launchOptions: { headless: true, executablePath: path },
  };
  const manager = new BrowserManager({
    profilesDir: root,
    runtime: missing,
    fixtureOrigin: await fixture(t),
  });
  await assert.rejects(manager.openPersistent('worker'), { code: 'EXECUTABLE_UNAVAILABLE' });
  assert.deepEqual(await readdir(root), ['.reservations']);
  await writeFile(path, 'not chromium', { mode: 0o700 });
  await assert.rejects(manager.openPersistent('worker'), { code: 'EXECUTABLE_UNAVAILABLE' });
  assert.deepEqual(await readdir(join(root, '.reservations')), []);
});

test('stop failure preserves the live reservation and a subsequent stop can recover', async (t) => {
  // A failed recovery operation must not advertise a profile as free while Chromium lives.
  const { root, manager } = await setup(t);
  const browser = await manager.openPersistent('stop-failure');
  const record = manager.browsers.get(browser.browserId);
  const actualClose = record.context.close.bind(record.context);
  record.context.close = async () => {
    throw new Error('fixture stop failure');
  };
  await assert.rejects(manager.closeBrowser(browser.browserId), { code: 'BROWSER_STOP_FAILED' });
  assert.equal(manager.listBrowsers()[0].status, 'stop-failed');
  const competing = new BrowserManager({
    profilesDir: root,
    runtime,
    fixtureOrigin: manager.fixtureOrigin,
  });
  t.after(() => competing.shutdown());
  await assert.rejects(competing.openPersistent('stop-failure'), { code: 'BROWSER_STILL_RUNNING' });
  record.context.close = actualClose;
  await manager.closeBrowser(browser.browserId);
  assert.equal(manager.listBrowsers()[0].status, 'stopped');
});

test('unknown launch failure retains manual-repair reservation and closes its private proxy', async (t) => {
  // A launch rejection is not proof that no process spawned; release must fail closed.
  const brokenRuntime = {
    ...runtime,
    chromium: {
      launchPersistentContext: async () => {
        throw new Error('fake launch failure');
      },
    },
  };
  const { manager, root } = await setup(t, { runtime: brokenRuntime });
  await assert.rejects(manager.openPersistent('failed-launch'), (error) => {
    assert.equal(error.code, 'LAUNCH_CLEANUP_FAILED');
    assert.equal(error.primaryCode, 'LAUNCH_FAILED');
    assert.equal(error.cleanupCode, 'BROWSER_IDENTITY_UNAVAILABLE');
    return true;
  });
  assert.equal(manager.proxyPromise, null);
  assert.deepEqual(await readdir(join(root, '.reservations')), ['failed-launch.json']);
});

test('unavailable stop observation retains clean directory until the exact owned child exits', async (t) => {
  // A fulfilled context close does not prove process death when the observer is unavailable.
  const { manager, root } = await setup(t);
  const worker = startTestChild(t, ['-e', "console.log('ready');setInterval(()=>{},1000)"]);
  await worker.ready;
  const profileDir = join(root, '.clean-owned-child');
  await mkdir(profileDir, { mode: 0o700 });
  await writeFile(join(profileDir, 'sentinel'), 'private fixture');
  const record = {
    browserId: 'clean-owned-child',
    profileDir,
    process: processIdentity(worker.child.pid),
    context: { close: async () => {} },
    status: 'running',
    closePromise: null,
  };
  manager.browsers.set(record.browserId, record);
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = '';
    await assert.rejects(manager.closeBrowser(record.browserId), {
      code: 'PROCESS_IDENTITY_UNAVAILABLE',
    });
    assert.equal(record.status, 'stop-failed');
    assert.equal(await readFile(join(profileDir, 'sentinel'), 'utf8'), 'private fixture');
  } finally {
    process.env.PATH = savedPath;
    const stopped = once(worker.child, 'exit');
    worker.child.kill('SIGKILL');
    await stopped;
  }
  await manager.closeBrowser(record.browserId);
  assert.equal(record.status, 'stopped');
  assert.ok(!(await readdir(root)).includes('.clean-owned-child'));
});

test('post-launch setup failure retains clean directory and owned record when close fails', async (t) => {
  // Fallible setup must use the same verified stop path as an ordinary browser shutdown.
  const worker = startTestChild(t, ['-e', "console.log('ready');setInterval(()=>{},1000)"]);
  await worker.ready;
  let profileDir;
  const context = {
    on() {},
    pages() {
      throw Error('fixture setup failure');
    },
    async close() {
      throw Error('fixture close failure');
    },
  };
  const brokenRuntime = {
    ...runtime,
    chromium: {
      async launchPersistentContext(directory) {
        profileDir = directory;
        await symlink(`${hostname()}-${worker.child.pid}`, join(directory, 'SingletonLock'));
        await writeFile(join(directory, 'sentinel'), 'private fixture');
        return context;
      },
    },
  };
  const { manager } = await setup(t, { runtime: brokenRuntime });
  let launchError;
  try {
    await assert.rejects(manager.openClean(), (error) => {
      launchError = error;
      return true;
    });
    assert.equal(await readFile(join(profileDir, 'sentinel'), 'utf8'), 'private fixture');
    assert.equal(launchError.code, 'LAUNCH_CLEANUP_FAILED');
    assert.equal(launchError.primaryCode, 'LAUNCH_FAILED');
    assert.equal(launchError.cleanupCode, 'BROWSER_STOP_FAILED');
    assert.equal([...manager.browsers.values()][0].status, 'stop-failed');
    assert.ok(processIdentity(worker.child.pid));
  } finally {
    const exited = once(worker.child, 'exit');
    worker.child.kill('SIGKILL');
    await exited;
    context.close = async () => {};
  }
  await manager.shutdown();
  assert.equal([...manager.browsers.values()][0].status, 'stopped');
});

test('manager process death either exits owned Chromium or refuses its surviving profile holder', async (t) => {
  // SIGKILL cannot run JS cleanup: native pipe exit is observed, never assumed.
  const root = await mkdtemp(join(tmpdir(), 'manager-crash-'));
  const origin = await fixture(t);
  const source = `import {loadPlaywright} from ${JSON.stringify(new URL('../runtime.mjs', import.meta.url).href)};import {BrowserManager} from ${JSON.stringify(new URL('../manager.mjs', import.meta.url).href)};const m=new BrowserManager({profilesDir:${JSON.stringify(root)},fixtureOrigin:${JSON.stringify(origin)},runtime:await loadPlaywright({repoRoot:${JSON.stringify(repoRoot)}})});const b=await m.openPersistent('crash');console.log(JSON.stringify(m.ownedProcess(b.browserId)));process.stdin.resume();`;
  const worker = startTestChild(t, ['--input-type=module', '-e', source]);
  const child = worker.child;
  let manager;
  t.after(async () => {
    await manager?.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const line = await worker.ready;
  const owned = JSON.parse(line);
  assert.ok(owned.pid);
  manager = new BrowserManager({ profilesDir: root, runtime, fixtureOrigin: origin });
  const sentinel = join(root, 'crash', 'loser-sentinel');
  await writeFile(sentinel, 'unchanged', { mode: 0o600 });
  const reservationBefore = await readFile(join(root, '.reservations', 'crash.json'), 'utf8');
  await assert.rejects(manager.openPersistent('crash'), { code: 'BROWSER_STILL_RUNNING' });
  assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
  assert.equal(
    await readFile(join(root, '.reservations', 'crash.json'), 'utf8'),
    reservationBefore
  );
  const died = once(child, 'exit');
  child.kill('SIGKILL');
  await died;
  const deadline = Date.now() + 2000;
  while (processIdentity(owned.pid) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  if (processIdentity(owned.pid)?.birth === owned.birth) {
    await assert.rejects(manager.openPersistent('crash'), { code: 'BROWSER_STILL_RUNNING' });
    // Only the exact fixture Chromium PID recorded before manager death is terminated.
    process.kill(owned.pid, 'SIGKILL');
    while (processIdentity(owned.pid) && Date.now() < deadline + 2000)
      await new Promise((resolve) => setTimeout(resolve, 25));
    t.diagnostic(
      'Chromium survived manager SIGKILL: orphan recovery requires explicit owned-process cleanup.'
    );
  } else t.diagnostic('Owned Chromium exited after manager SIGKILL.');
  const recovered = await manager.openPersistent('crash');
  assert.equal(recovered.profileId, 'crash');
});
