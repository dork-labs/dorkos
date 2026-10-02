/* global window, Worker, SharedWorker */
import { loadPlaywright } from '../../runtime.mjs';
import { processIdentity } from '../../profile-reservation.mjs';
import { executableSha256 } from './pins.mjs';
let server;
let browser;
const send = (message) => process.send(message);
async function readIdentity(frame) {
  return frame.evaluate(() => window.readIdentity());
}
async function matrix(config) {
  // No context userAgent, metadata, headers, scripts or route overrides are supplied.
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(config.urls[0] + '/page');
    const main = await readIdentity(page);
    const frame = page.frames().find((entry) => entry.url() === config.urls[1] + '/frame');
    if (!frame) throw Error('CROSS_SITE_FRAME_UNAVAILABLE');
    const frameIdentity = await readIdentity(frame);
    const cdp = await browser.newBrowserCDPSession();
    const targets = (await cdp.send('Target.getTargets')).targetInfos;
    await cdp.detach();
    const oopifTargets = targets
      .filter((target) => target.type === 'iframe' && target.url === config.urls[1] + '/frame')
      .map(({ targetId, type, url }) => ({ targetId, type, url }));
    await page.evaluate(() => fetch('/page-negotiated'));
    await frame.evaluate(() => fetch('/frame-negotiated'));
    const workers = await page.evaluate(async () => {
      const dedicated = new Worker('/worker-dedicated');
      const dedicatedValue = await new Promise((resolve, reject) => {
        dedicated.onmessage = (event) => resolve(event.data);
        dedicated.onerror = reject;
      });
      dedicated.terminate();
      const shared = new SharedWorker('/worker-shared');
      const sharedValue = await new Promise((resolve, reject) => {
        shared.port.onmessage = (event) => resolve(event.data);
        shared.onerror = reject;
        shared.port.start();
      });
      shared.port.close();
      const registration = await navigator.serviceWorker.register('/worker-service');
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
    await page.evaluate(async () => {
      for (const type of ['dedicated', 'shared', 'service']) await fetch('/fetch-' + type);
    });
    await page.reload();
    const reload = await readIdentity(page);
    return {
      main,
      frame: frameIdentity,
      workers,
      reload,
      oopifTargets,
      frameUrl: frame.url(),
      pageUrl: page.url(),
    };
  } finally {
    await context.close();
  }
}
process.on('message', async (message) => {
  try {
    if (message.type === 'identity')
      send({ type: 'identity', identity: processIdentity(process.pid) });
    else if (message.type === 'configure') {
      const runtime = await loadPlaywright({ repoRoot: message.repoRoot });
      if (runtime.receipt.executableSha256 !== executableSha256)
        throw Error('NATIVE_EXECUTABLE_PIN_MISMATCH');
      server = await runtime.chromium.launchServer({
        ...runtime.launchOptions,
        chromiumSandbox: true,
        host: '127.0.0.1',
        timeout: 10_000,
        args: [
          '--host-resolver-rules=' + message.hostMapping,
          '--ignore-certificate-errors-spki-list=' + message.spkiHash,
        ],
      });
      const root = processIdentity(server.process().pid);
      if (!root) throw Error('BROWSER_IDENTITY_UNAVAILABLE');
      send({ type: 'browser-owned', root });
      browser = await runtime.chromium.connect(server.wsEndpoint());
      const args = server.process().spawnargs;
      if (args.includes('--no-sandbox')) throw Error('SANDBOX_DISABLED');
      send({
        type: 'ready',
        runtime: runtime.receipt,
        browserVersion: browser.version(),
        policyArgs: args.filter((argument) =>
          /sandbox|user-agent|host-resolver-rules|ignore-certificate-errors/.test(argument)
        ),
      });
    } else if (message.type === 'matrix') send({ type: 'result', result: await matrix(message) });
    else if (message.type === 'close') {
      await browser?.close();
      await server?.close();
      send({ type: 'closed' });
      process.disconnect();
    }
  } catch (error) {
    send({ type: 'error', code: error.message });
  }
});
