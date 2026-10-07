import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  boundedOriginalFile,
  readPublicNativeInput,
  verifyPublicNativeEmits,
} from './public-native-input.js';
import { runPrivateOriginalStorageWindow } from './private-storage-runner.fixture.js';

/** Direct original Node owner; the existing storage180s abort budget and whole joins remain. */
async function main() {
  const [configPath] = process.argv.slice(2);
  if (process.argv.length !== 3 || !configPath || !isAbsolute(configPath))
    throw new Error('STORAGE_ORIGINAL_CONFIG_REQUIRED');
  const absolute = z.string().max(4096).refine(isAbsolute);
  const config = z
    .object({ input: absolute, node: absolute, artifacts: absolute })
    .strict()
    .parse(JSON.parse((await boundedOriginalFile(configPath, 16384)).toString('utf8')));
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new Error('STORAGE_ORIGINAL_PARENT_STOP'));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const timer = setTimeout(
    () => lifetime.abort(new Error('STORAGE_ORIGINAL_CAMPAIGN_BUDGET')),
    180000
  );
  const current = () => lifetime.signal.throwIfAborted();
  const reports: unknown[] = [];
  let first: { value: unknown } | undefined;
  let created = false;
  const retain = async (report: unknown) => {
    if (reports.length >= 32) throw new Error('STORAGE_RECEIPT_BOUND');
    reports.push(report);
  };
  try {
    const input = await readPublicNativeInput(config.input, current);
    await mkdir(config.artifacts, { mode: 0o700 });
    created = true;
    if ((await realpath(config.artifacts)) !== config.artifacts)
      throw new Error('STORAGE_ORIGINAL_ARTIFACT_PATH_REQUIRED');
    current();
    await runPrivateOriginalStorageWindow({
      ...config,
      input,
      signal: lifetime.signal,
      current,
      retain: async (report) => {
        current();
        await retain(report);
      },
      // Original cleanup facts remain retained even after body cancellation.
      retainRetirement: retain,
    });
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
            acceptance: 'storage',
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
  console.error('Original storage fixture failure:', cause);
  process.exitCode = 1;
});
