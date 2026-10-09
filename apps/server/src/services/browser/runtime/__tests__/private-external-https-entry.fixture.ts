import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  resolveInstalledRuntimeConfiguration,
  createRuntimeInstallation,
  verifyInstalledNativeJournal,
} from '@dorkos/browser/runtime-installation';
import {
  BrowserProductionOpenReceiptSchema,
  BrowserControlSchema,
  BrowserProductionNavigateReceiptSchema,
} from '@dorkos/shared/browser-schemas';
import {
  boundedOriginalFile,
  readPublicNativeInput,
  verifyPublicNativeEmits,
} from './public-native-input.js';
import { SemanticSnapshotV1Schema } from '@dorkos/shared/browser-semantic-schemas';
import { withOriginalInstalledBrowserRound } from './private-storage-runner.fixture.js';

/** One genuine default-policy public HTTPS navigation; no local grant, frontend or SDK Page. */
async function main() {
  const [configPath] = process.argv.slice(2);
  if (process.argv.length !== 3 || !configPath || !isAbsolute(configPath))
    throw new Error('EXTERNAL_HTTPS_ORIGINAL_CONFIG_REQUIRED');
  const absolute = z.string().max(4096).refine(isAbsolute);
  const config = z
    .object({ input: absolute, node: absolute, artifacts: absolute })
    .strict()
    .parse(JSON.parse((await boundedOriginalFile(configPath, 16384)).toString('utf8')));
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new Error('EXTERNAL_HTTPS_ORIGINAL_PARENT_STOP'));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const timer = setTimeout(
    () => lifetime.abort(new Error('EXTERNAL_HTTPS_ORIGINAL_CAMPAIGN_BUDGET')),
    180000
  );
  const current = () => lifetime.signal.throwIfAborted();
  const reports: unknown[] = [];
  const retain = async (report: unknown) => {
    if (reports.length >= 32) throw new Error('EXTERNAL_HTTPS_RECEIPT_BOUND');
    reports.push(report);
  };
  let first: { value: unknown } | undefined;
  let created = false;
  const destination = 'https://example.com/';
  try {
    const input = await readPublicNativeInput(config.input, current);
    await mkdir(config.artifacts, { mode: 0o700 });
    created = true;
    if ((await realpath(config.artifacts)) !== config.artifacts)
      throw new Error('EXTERNAL_HTTPS_ORIGINAL_ARTIFACT_PATH_REQUIRED');
    await verifyPublicNativeEmits(input, current);
    const configuration = await resolveInstalledRuntimeConfiguration(
      pathToFileURL(input.cliEntry),
      input.home
    );
    if (
      (await createRuntimeInstallation(configuration).inspectExisting()).state !== 'installed-files'
    )
      throw new Error('EXTERNAL_HTTPS_ORIGINAL_INSTALLATION_REQUIRED');
    const native = await verifyInstalledNativeJournal(configuration);
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
          throw new Error('EXTERNAL_HTTPS_ORIGINAL_OPEN_REQUIRED');
        await port.birth(opened.binding);
        const control = BrowserControlSchema.parse(
          await port.request('/api/browser/control', opened.binding)
        );
        if (control.status !== 'ready' || !control.controllerId)
          throw new Error('EXTERNAL_HTTPS_ORIGINAL_CONTROL_REQUIRED');
        const navigationId = randomUUID();
        const navigated = BrowserProductionNavigateReceiptSchema.parse(
          await port.request('/api/browser/runtime/navigate', {
            controllerId: control.controllerId,
            command: {
              kind: 'navigate',
              requestId: navigationId,
              binding: control.binding,
              url: destination,
            },
          })
        );
        if (
          navigated.requestId !== navigationId ||
          navigated.binding.tabId !== opened.binding.tabId ||
          navigated.binding.browserId !== opened.binding.browserId ||
          navigated.binding.browserGeneration !== opened.binding.browserGeneration ||
          navigated.binding.navigationGeneration <= control.binding.navigationGeneration
        )
          throw new Error('EXTERNAL_HTTPS_ORIGINAL_PAGE_CHANGED');
        const snapshot = SemanticSnapshotV1Schema.parse(
          await port.request('/api/browser/semantic/owner/read', { binding: navigated.binding })
        );
        for (const key of Object.keys(navigated.binding) as (keyof typeof navigated.binding)[])
          if (snapshot[key] !== navigated.binding[key])
            throw new Error('EXTERNAL_HTTPS_ORIGINAL_CONTENT_BINDING_REQUIRED');
        if (
          snapshot.completeness !== 'complete' ||
          !snapshot.nodes.some((node) => node.role === 'heading' && node.name === 'Example Domain')
        )
          throw new Error('EXTERNAL_HTTPS_ORIGINAL_PAGE_CONTENT_REQUIRED');
        await retain({
          kind: 'original-default-policy-external-https',
          destination,
          binding: navigated.binding,
          successfulNavigationReceipt: true,
          originalSemanticHeading: 'Example Domain',
          localDestinationGrantIssued: false,
          scope: 'public HTTPS smoke only; not shared-SAN H2 or complete network isolation',
        });
      }
    );
    await verifyPublicNativeEmits(input, current);
  } catch (value) {
    first = { value };
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    if (created) {
      try {
        await writeFile(
          join(config.artifacts, 'RESULT.json'),
          JSON.stringify({
            version: 1,
            acceptance: 'external-https-smoke',
            destination,
            returned: first ? 'FAIL' : 'PASS',
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
  console.error('Original external HTTPS smoke fixture failure:', cause);
  process.exitCode = 1;
});
