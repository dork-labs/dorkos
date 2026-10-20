/* global document, innerWidth, innerHeight */
// Serialized callbacks run in the owned fixture page.
const assert = require('node:assert/strict');
const path = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow, webContents } = require('electron');
app.on('window-all-closed', () => {});
process.on('uncaughtException', (error) => {
  console.error(error);
  app.exit(1);
});
setTimeout(() => {
  console.error('BRIDGE PROOF DEADLINE');
  app.exit(1);
}, 50000).unref();
if (!process.env.DORKOS_BRIDGE_PLAYWRIGHT) throw new Error('Run through bridge-proof.ts');
const { chromium } = require(process.env.DORKOS_BRIDGE_PLAYWRIGHT);
const { startLocalBrowserBridge, LOCAL_BROWSER_BOUNDS_CHANNEL } = require(process.argv[2]);
const { createServer } = require('node:http');
const fixtureDirectory = process.env.DORKOS_BRIDGE_PROOF_DIRECTORY;
if (!fixtureDirectory) throw new Error('Run through bridge-proof.ts');
const outputDirectory = process.env.DORKOS_BRIDGE_PROOF_OUTPUT;
if (!outputDirectory) throw new Error('Missing owned proof output');
app.setPath('userData', path.join(fixtureDirectory, 'user-data'));
app.setPath('sessionData', path.join(fixtureDirectory, 'session-data'));
app.setPath('logs', path.join(fixtureDirectory, 'logs'));
app
  .whenReady()
  .then(async () => {
    const fixture = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      if (request.url === '/popup')
        response.end(
          `<title>Sign-in popup</title><script>setTimeout(()=>{window.opener.postMessage('login-complete',location.origin);window.close()},1000)</script>`
        );
      else if (request.url.startsWith('/persistent-popup'))
        response.end('<title>Owned extra window</title><h1>Human-only window</h1>');
      else if (request.url === '/shell') response.end('<h1>Isolated DorkOS shell</h1>');
      else
        response.end(
          `<title>Guest page</title><h1>Guest fixture</h1><button onclick="window.open('/popup','signin','width=450,height=400')">Sign in</button><button onclick="window.open('/persistent-popup?before','before','width=450,height=400')">Keep window</button><button onclick="window.open('/persistent-popup?after','after','width=450,height=400')">Another window</button><script>window.addEventListener('message',event=>{if(event.origin===location.origin && event.data==='login-complete')document.title='Sign-in returned'})</script>`
        );
    });
    await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${fixture.address().port}`;
    // Only this owned shell fixture gets a preload. Production guest content stays sandboxed.
    const preload = path.join(fixtureDirectory, 'shell-preload.cjs');
    writeFileSync(
      preload,
      `const { contextBridge, ipcRenderer } = require('electron');\ncontextBridge.exposeInMainWorld('proofBounds', bounds => ipcRenderer.invoke(${JSON.stringify(LOCAL_BROWSER_BOUNDS_CHANNEL)}, bounds));`
    );
    const shellOptions = {
      width: 900,
      height: 650,
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false },
    };
    const shell = new BrowserWindow(shellOptions);
    await shell.loadURL(`${origin}/shell`);
    const bridge = await startLocalBrowserBridge(
      () => origin,
      () => shell
    );
    const endpoint = process.env.DORKOS_LOCAL_BROWSER_BRIDGE;
    const headers = {
      Authorization: `Bearer ${process.env.DORKOS_LOCAL_BROWSER_BRIDGE_TOKEN}`,
      'Content-Type': 'application/json',
    };
    const connectionId = 'native-bridge-fixture';
    let browser;
    let pip;
    try {
      const refused = await fetch(`${endpoint}/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      });
      if (refused.status !== 403) throw new Error('Unauthenticated shell bridge opened');
      const opened = await fetch(`${endpoint}/open`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ connectionId }),
      });
      if (!opened.ok) throw new Error(`Guest open ${opened.status}`);
      const guest = await opened.json();
      browser = await chromium.connectOverCDP(guest.endpoint, {
        headers: guest.headers,
        noDefaults: true,
        timeout: 10000,
      });
      const pages = browser.contexts().flatMap((context) => context.pages());
      if (pages.length !== 1) throw new Error(`Shell target leaked: ${pages.length}`);
      const page = pages[0];
      await page.goto(`${origin}/guest`);
      const guestContents = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === `${origin}/guest`);
      assert(guestContents && guestContents !== shell.webContents);
      const guestId = guestContents.id;
      const guestView = shell.contentView.children.find(
        (view) => view.webContents === guestContents
      );
      assert(guestView, 'Automation must reach the exact native child view');
      console.log(
        'VIEW_STATE',
        JSON.stringify(
          await page.evaluate(() => ({
            visibility: document.visibilityState,
            width: innerWidth,
            height: innerHeight,
            button: document.querySelector('button').getBoundingClientRect().toJSON(),
          }))
        )
      );
      await page.getByRole('button', { name: 'Sign in' }).click({ timeout: 5000 });
      let humanOnlyPopup = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        humanOnlyPopup = BrowserWindow.getAllWindows().some(
          (window) => window.getTitle() === 'Extra browser window • You only'
        );
        if (humanOnlyPopup) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!humanOnlyPopup) throw new Error('Popup did not explain its human-only status');
      if (browser.contexts().flatMap((context) => context.pages()).length !== 1)
        throw new Error('Human-only popup leaked into agent page selection');
      await page.waitForFunction(() => document.title === 'Sign-in returned', undefined, {
        timeout: 5000,
      });
      if (page.url() !== `${origin}/guest`) throw new Error('Popup replaced the original page');
      let session;
      let rootRefused = false;
      try {
        session = await page.context().newCDPSession(page);
        await session.send('Target.getTargets');
      } catch {
        rootRefused = true;
      }
      if (!rootRefused) throw new Error('Browser target discovery exposed');
      await session?.detach().catch(() => undefined);
      const until = async (check, label) => {
        const deadline = Date.now() + 5000;
        do {
          const value = check();
          if (value) return value;
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        throw new Error(label);
      };
      const livePages = () => browser.contexts().flatMap((context) => context.pages());
      const sameGuest = (host) => {
        assert(!guestContents.isDestroyed());
        assert.equal(guestContents.id, guestId);
        assert(host.contentView.children.includes(guestView));
        assert.equal(livePages().length, 1, 'Shell and popups must remain outside agent selection');
        assert.equal(livePages()[0], page, 'Presentation moves must preserve the exact Page');
        assert.equal(page.url(), `${origin}/guest`);
      };
      const present = async (host) => {
        const bounds = { connectionId, x: 20, y: 80, width: 420, height: 450, visible: true };
        // Invoke the production IPC handler through the genuine authorized renderer frame.
        await host.webContents.executeJavaScript(`window.proofBounds(${JSON.stringify(bounds)})`);
        sameGuest(host);
      };
      const screenshots = [];
      const capture = async (host, name) => {
        let guestImage;
        let painted;
        const deadline = Date.now() + 5000;
        do {
          guestImage = await guestContents.capturePage();
          const bitmap = guestImage.toBitmap();
          painted = 0;
          for (let offset = 0; offset < bitmap.length; offset += 4)
            if (bitmap[offset] < 240 || bitmap[offset + 1] < 240 || bitmap[offset + 2] < 240)
              painted++;
          if (painted >= 64) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        assert(
          guestImage && !guestImage.isEmpty() && painted >= 64,
          'Native fixture must visibly paint'
        );
        const guestPath = path.join(outputDirectory, `${name}-native-page.png`);
        writeFileSync(guestPath, guestImage.toPNG());
        const shellPath = path.join(outputDirectory, `${name}-fixture-host.png`);
        writeFileSync(shellPath, (await host.capturePage()).toPNG());
        screenshots.push({
          guestPath,
          shellPath,
          guestId,
          paintedPixels: painted,
          size: guestImage.getSize(),
        });
      };
      await present(shell);
      await capture(shell, 'main-first');
      const popupAt = (suffix) =>
        BrowserWindow.getAllWindows().find(
          (window) => window.webContents.getURL() === `${origin}/persistent-popup?${suffix}`
        );
      await page.getByRole('button', { name: 'Keep window', exact: true }).click({ timeout: 5000 });
      const before = await until(() => popupAt('before'), 'Original popup did not open');
      assert.equal(before.getTitle(), 'Extra browser window • You only');
      assert.equal(before.getParentWindow(), shell);
      pip = new BrowserWindow({ ...shellOptions, width: 650, height: 620 });
      await pip.loadURL(`${origin}/shell`);
      await present(pip);
      assert.equal(before.getParentWindow(), pip, 'Existing popup must follow its PiP host');
      await capture(pip, 'pip-fixture');
      await page
        .getByRole('button', { name: 'Another window', exact: true })
        .click({ timeout: 5000 });
      const after = await until(() => popupAt('after'), 'PiP popup did not open');
      assert.equal(after.getTitle(), 'Extra browser window • You only');
      assert.equal(after.getParentWindow(), pip, 'New popup must use the current host');
      await present(shell);
      assert.equal(before.getParentWindow(), shell);
      assert.equal(after.getParentWindow(), shell);
      const pipClosed = new Promise((resolve) => pip.once('closed', resolve));
      pip.destroy();
      await pipClosed;
      sameGuest(shell);
      await capture(shell, 'main-returned');
      await page.getByRole('heading', { name: 'Guest fixture' }).waitFor({ timeout: 5000 });
      // Closing the presenting window must close the owned guest and automation transport.
      let disconnected = false;
      browser.once('disconnected', () => (disconnected = true));
      shell.destroy();
      for (let attempt = 0; attempt < 50 && !disconnected; attempt++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      if (!disconnected) throw new Error('Guest survived its presenting window');
      assert(guestContents.isDestroyed());
      assert(before.isDestroyed() && after.isDestroyed(), 'Owned popups survived guest cleanup');
      if (
        webContents.getAllWebContents().some((contents) => contents.getURL() === `${origin}/guest`)
      )
        throw new Error('Guest web contents retained');
      console.log(
        'BRIDGE_PROOF_RESULT ' +
          JSON.stringify({
            ok: true,
            electron: process.versions.electron,
            chromium: process.versions.chrome,
            playwright: require(path.join(process.env.DORKOS_BRIDGE_PLAYWRIGHT, 'package.json'))
              .version,
            guestId,
            screenshots,
            qualificationOnly: true,
            shippedBrowserPipUi: false,
            authenticatedPageOnlyBridge: true,
            hiddenViewActions: true,
            popupOpenerPreserved: true,
            humanOnlyPopupStatus: true,
            shellTargetsRefused: true,
            parentCloseGuestClosed: true,
            sameNativeGuestAndPageAcrossHosts: true,
            existingPopupFollowsHost: true,
            newPopupUsesCurrentHost: true,
            oldHostClosePreservesGuest: true,
          })
      );
      await bridge.close();
      fixture.closeAllConnections();
      await new Promise((resolve) => fixture.close(resolve));
      app.exit(0);
    } catch (error) {
      console.error(error);
      await browser?.close().catch(() => undefined);
      await bridge.close();
      if (pip && !pip.isDestroyed()) pip.destroy();
      if (!shell.isDestroyed()) shell.destroy();
      fixture.closeAllConnections();
      fixture.close();
      app.exit(1);
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
