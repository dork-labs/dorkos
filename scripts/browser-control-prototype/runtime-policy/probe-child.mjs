/* global window, Worker, SharedWorker */
import { createRequire } from 'node:module';
import { processIdentity } from '../profile-reservation.mjs';
let browserServer;
let browser;
let config;
let hold;
const events = [];
const send = (message) => process.send(message);

async function identity(page) {
  return page.evaluate(async () => ({
    ua: navigator.userAgent,
    appVersion: navigator.appVersion,
    platform: navigator.platform,
    secure: window.isSecureContext,
    metadata: await navigator.userAgentData.getHighEntropyValues([
      'architecture',
      'bitness',
      'fullVersionList',
      'model',
      'platformVersion',
      'uaFullVersion',
      'wow64',
      'formFactors',
    ]),
  }));
}
async function runCase(message) {
  const options = message.metadata
    ? { userAgent: message.ua, chromiumUserAgentMetadata: message.metadata }
    : message.ua
      ? { userAgent: message.ua }
      : {};
  const context = await browser.newContext(options);
  try {
    const page = await context.newPage();
    await page.goto(config.urls[0] + '/' + message.id + '-initial');
    const initial = await identity(page);
    await page.evaluate((id) => fetch('/' + id + '-negotiated'), message.id);
    if (message.hold) hold = { released: false, target: null };
    const popupReady = context.waitForEvent('page');
    await page.evaluate((url) => window.open(url), config.urls[1] + '/' + message.id + '-popup');
    const popup = await popupReady;
    await popup.waitForLoadState();
    const popupIdentity = await identity(popup);
    await popup.evaluate((id) => fetch('/' + id + '-negotiated-popup'), message.id);
    let workers;
    if (message.workers)
      workers = await page.evaluate(async () => {
        const dedicated = new Worker('/identity-worker-dedicated');
        const dedicatedValue = await new Promise((resolve, reject) => {
          dedicated.onmessage = (event) => resolve(event.data);
          dedicated.onerror = reject;
        });
        dedicated.terminate();
        const shared = new SharedWorker('/identity-worker-shared');
        const sharedValue = await new Promise((resolve, reject) => {
          shared.port.onmessage = (event) => resolve(event.data);
          shared.onerror = reject;
          shared.port.start();
        });
        shared.port.close();
        const registration = await navigator.serviceWorker.register('/identity-worker-service');
        await navigator.serviceWorker.ready;
        const channel = new MessageChannel();
        const serviceValue = await new Promise((resolve) => {
          channel.port1.onmessage = (event) => resolve(event.data);
          registration.active.postMessage('identity', [channel.port2]);
        });
        channel.port1.close();
        await registration.unregister();
        return { dedicated: dedicatedValue, shared: sharedValue, service: serviceValue };
      });
    return { initial, popup: popupIdentity, workers, events: events.splice(0) };
  } finally {
    await context.close();
    hold = null;
  }
}
process.on('message', async (message) => {
  if (message.type === 'release') {
    if (hold) {
      hold.released = true;
      hold.resolve?.();
    }
    return;
  }
  try {
    if (message.type === 'identity')
      send({ type: 'identity', identity: processIdentity(process.pid) });
    else if (message.type === 'configure') {
      config = message;
      const require = createRequire(message.packageDir + '/package.json');
      const { chromium } = require(message.packageDir);
      globalThis.__runtimePolicyProbe = async (phase, targetId) => {
        const event = { phase, targetId, at: Date.now() };
        events.push(event);
        if (phase === 'before-install' && hold && !hold.target) {
          hold.target = targetId;
          send({ type: 'held', event });
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(Error('HELD_INSTALL_TIMEOUT')), 5000);
            hold.resolve = () => {
              clearTimeout(timer);
              resolve();
            };
            if (hold.released) hold.resolve();
          });
        }
      };
      browserServer = await chromium.launchServer({
        executablePath: message.executablePath,
        headless: true,
        chromiumSandbox: true,
        timeout: 10_000,
        host: '127.0.0.1',
        args: ['--ignore-certificate-errors-spki-list=' + message.spkiHash],
      });
      const root = processIdentity(browserServer.process().pid);
      if (!root) throw Error('BROWSER_IDENTITY_UNAVAILABLE');
      send({ type: 'browser-owned', root });
      browser = await chromium.connect(browserServer.wsEndpoint());
      const args = browserServer.process().spawnargs;
      if (args.includes('--no-sandbox')) throw Error('SANDBOX_DISABLED');
      send({
        type: 'ready',
        browserVersion: browser.version(),
        sandboxRequested: true,
        sandboxFlags: args.filter((argument) => argument.includes('sandbox')),
        spkiFlags: args.filter((argument) => argument.startsWith('--ignore-certificate-errors')),
      });
    } else if (message.type === 'case')
      send({ type: 'result', id: message.id, result: await runCase(message) });
    else if (message.type === 'close') {
      await browser?.close();
      await browserServer?.close();
      send({ type: 'closed' });
      process.disconnect();
    }
  } catch (error) {
    send({ type: 'error', code: error.message });
  }
});
