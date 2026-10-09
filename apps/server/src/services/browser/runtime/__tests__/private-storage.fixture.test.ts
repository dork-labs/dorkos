import { it, onTestFinished } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readPublicNativeInput } from './public-native-input.js';
import { runPrivateOriginalStorageWindow } from './private-storage-runner.fixture.js';
// Explicit private storage campaign only; normal quality runs cannot launch it.
const inputPath = process.env.DORKOS_BROWSER_PUBLIC_ACCEPTANCE_FIXTURE;
const armed = process.env.DORKOS_BROWSER_STORAGE_ACCEPTANCE === '1' && !!inputPath;
it.skipIf(!armed)(
  'actual built CLI: durable storage after three restarts, unseeded clean context and two unattended100-mutation Pages',
  async () => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('STORAGE_ORIGINAL_CAMPAIGN_BUDGET')),
      180000
    );
    onTestFinished(() => {
      clearTimeout(timer);
      controller.abort(new Error('STORAGE_ORIGINAL_FIXTURE_CLOSED'));
    });
    const current = () => controller.signal.throwIfAborted();
    const input = await readPublicNativeInput(inputPath!, current);
    const artifacts = join(input.home, 'storage-original-receipts');
    await mkdir(artifacts, { mode: 0o700 });
    let report = 0;
    await runPrivateOriginalStorageWindow({
      input,
      node: process.execPath,
      artifacts,
      signal: controller.signal,
      current,
      async retain(value) {
        current();
        if (++report > 32) throw new Error('STORAGE_RECEIPT_BOUND');
        await writeFile(
          join(artifacts, 'receipt-' + report + '.json'),
          JSON.stringify(value, null, 2),
          { flag: 'wx', mode: 0o600 }
        );
      },
    });
  },
  190000
);
