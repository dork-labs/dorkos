import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import {
  resolveInstalledRuntimeConfiguration,
  createRuntimeInstallation,
  verifyInstalledNativeJournal,
} from '@dorkos/browser/runtime-installation';
import {
  BrowserProductionOpenReceiptSchema,
  BrowserControlSchema,
  BrowserLocalDestinationReceiptSchema,
  BrowserProductionNavigateReceiptSchema,
} from '@dorkos/shared/browser-schemas';
import {
  boundedOriginalFile,
  readPublicNativeInput,
  verifyPublicNativeEmits,
} from './public-native-input.js';
import { withOriginalInstalledBrowserRound } from './private-storage-runner.fixture.js';

/** One genuine public CLI round; no frontend, SDK Page or substitute proxy authority. */
async function main() {
  const [configPath] = process.argv.slice(2);
  if (process.argv.length !== 3 || !configPath || !isAbsolute(configPath))
    throw new Error('NAVIGATION_ORIGINAL_CONFIG_REQUIRED');
  const absolute = z.string().max(4096).refine(isAbsolute);
  const config = z
    .object({ input: absolute, node: absolute, artifacts: absolute })
    .strict()
    .parse(JSON.parse((await boundedOriginalFile(configPath, 16384)).toString('utf8')));
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new Error('NAVIGATION_ORIGINAL_PARENT_STOP'));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const timer = setTimeout(
    () => lifetime.abort(new Error('NAVIGATION_ORIGINAL_CAMPAIGN_BUDGET')),
    180000
  );
  const current = () => lifetime.signal.throwIfAborted();
  const reports: unknown[] = [];
  const retain = async (report: unknown) => {
    if (reports.length >= 32) throw new Error('NAVIGATION_RECEIPT_BOUND');
    reports.push(report);
  };
  let first: { value: unknown } | undefined;
  let created = false;
  const receiver = createServer();
  let listening = false;
  const path = '/acceptance/' + randomUUID();
  let hits = 0;
  let credentialLeaks = 0;
  receiver.on('request', (request, response) => {
    if (request.url !== path || request.method !== 'GET') {
      response.writeHead(404).end();
      return;
    }
    hits++;
    if (request.headers.authorization || request.headers['proxy-authorization']) credentialLeaks++;
    response
      .writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      .end(
        '<!doctype html><title>Original public navigation probe</title><p>Owned receiver reached</p>'
      );
  });
  try {
    const input = await readPublicNativeInput(config.input, current);
    await mkdir(config.artifacts, { mode: 0o700 });
    created = true;
    if ((await realpath(config.artifacts)) !== config.artifacts)
      throw new Error('NAVIGATION_ORIGINAL_ARTIFACT_PATH_REQUIRED');
    await verifyPublicNativeEmits(input, current);
    const configuration = await resolveInstalledRuntimeConfiguration(
      pathToFileURL(input.cliEntry),
      input.home
    );
    if (
      (await createRuntimeInstallation(configuration).inspectExisting()).state !== 'installed-files'
    )
      throw new Error('NAVIGATION_ORIGINAL_INSTALLATION_REQUIRED');
    const native = await verifyInstalledNativeJournal(configuration);
    const ready = once(receiver, 'listening');
    receiver.listen(0, '127.0.0.1');
    await ready;
    listening = true;
    const address = receiver.address();
    if (!address || typeof address === 'string')
      throw new Error('NAVIGATION_ORIGINAL_RECEIVER_REQUIRED');
    const origin = 'http://127.0.0.1:' + address.port;
    current();
    await withOriginalInstalledBrowserRound(
      {
        ...config,
        input,
        native,
        round: 0,
        signal: lifetime.signal,
        current,
        retainRetirement: retain,
      },
      async (port) => {
        const requestId = randomUUID();
        const opened = BrowserProductionOpenReceiptSchema.parse(
          await port.request('/api/browser/runtime/open', {
            workspaceId: input.workspaceId,
            request: { requestId, mode: 'ephemeral' },
          })
        );
        if (opened.requestId !== requestId || opened.instance.mode !== 'ephemeral')
          throw new Error('NAVIGATION_ORIGINAL_OPEN_REQUIRED');
        await port.birth(opened.binding);
        const control = BrowserControlSchema.parse(
          await port.request('/api/browser/control', opened.binding)
        );
        if (control.status !== 'ready' || !control.controllerId)
          throw new Error('NAVIGATION_ORIGINAL_CONTROL_REQUIRED');
        const allowedId = randomUUID();
        const permission = BrowserLocalDestinationReceiptSchema.parse(
          await port.request('/api/browser/runtime/local-destination', {
            requestId: allowedId,
            binding: control.binding,
            endpoint: origin + '/',
            ttlMilliseconds: 300000,
          })
        );
        if (permission.requestId !== allowedId || permission.endpoint !== origin)
          throw new Error('NAVIGATION_ORIGINAL_DESTINATION_REQUIRED');
        const navigationId = randomUUID();
        const navigated = BrowserProductionNavigateReceiptSchema.parse(
          await port.request('/api/browser/runtime/navigate', {
            controllerId: control.controllerId,
            command: {
              kind: 'navigate',
              requestId: navigationId,
              binding: control.binding,
              url: origin + path,
            },
          })
        );
        if (
          navigated.requestId !== navigationId ||
          navigated.binding.tabId !== opened.binding.tabId ||
          navigated.binding.browserId !== opened.binding.browserId
        )
          throw new Error('NAVIGATION_ORIGINAL_PAGE_CHANGED');
        if (hits !== 1 || credentialLeaks !== 0)
          throw new Error('NAVIGATION_ORIGINAL_RECEIVER_PROOF_REQUIRED');
        await retain({
          kind: 'original-public-navigation',
          binding: navigated.binding,
          receiverRequests: hits,
          credentialLeaks,
        });
      }
    );
    await verifyPublicNativeEmits(input, current);
  } catch (value) {
    first = { value };
  } finally {
    try {
      receiver.closeAllConnections();
    } catch (value) {
      first ??= { value };
    }
    if (listening || receiver.listening) {
      try {
        await new Promise<void>((resolve, reject) =>
          receiver.close((error) => (error ? reject(error) : resolve()))
        );
      } catch (value) {
        first ??= { value };
      }
    }
    clearTimeout(timer);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (created) {
      try {
        await writeFile(
          join(config.artifacts, 'RESULT.json'),
          JSON.stringify({
            version: 1,
            acceptance: 'public-navigation',
            returned: first ? 'FAIL' : 'PASS',
            receiverRequests: hits,
            credentialLeaks,
            reports,
          }) + '\n',
          { flag: 'wx', mode: 0o600 }
        );
      } catch (value) {
        first ??= { value };
      }
    }
  }
  if (first) throw first.value;
}
void main().catch((cause: unknown) => {
  console.error('Original public navigation fixture failure:', cause);
  process.exitCode = 1;
});
