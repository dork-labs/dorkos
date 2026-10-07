import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import {
  boundedOriginalFile,
  readPublicNativeInput,
} from '../../../runtime/__tests__/public-native-input.js';
import { runPrivateOriginalSharedSANH2Window } from './shared-san-h2-installed-driver.fixture.js';

const armed = process.env.DORKOS_BROWSER_SHARED_SAN_CAMPAIGN === '1';
/** Explicit fixture-only entry; the endpoint must already be owned, routable and trusted by Chromium. */
async function main() {
  if (!armed) throw new Error('H2_INSTALLED_CAMPAIGN_EXPLICIT_ARM_REQUIRED');
  const [path] = process.argv.slice(2);
  if (process.argv.length !== 3 || !path || !isAbsolute(path))
    throw new Error('H2_ORIGINAL_CONFIG_REQUIRED');
  const absolute = z.string().max(4096).refine(isAbsolute);
  const config = z
    .object({
      input: absolute,
      node: absolute,
      artifacts: absolute,
      endpointReportPath: absolute,
      originalEndpointReturnPath: absolute,
      endpointExecutablePath: absolute,
      endpointExecutableSHA256: z.string().regex(/^[a-f0-9]{64}$/),
      endpoint: z
        .object({ allowedOrigin: z.string().url(), deniedOrigin: z.string().url() })
        .strict(),
    })
    .strict()
    .parse(JSON.parse((await boundedOriginalFile(path, 16384)).toString('utf8')));
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new Error('H2_ORIGINAL_PARENT_STOP'));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const timer = setTimeout(() => lifetime.abort(new Error('H2_ORIGINAL_CAMPAIGN_BUDGET')), 180000);
  const current = () => lifetime.signal.throwIfAborted();
  const reports: unknown[] = [];
  let first: { value: unknown } | undefined;
  let created = false;
  try {
    const input = await readPublicNativeInput(config.input, current);
    await mkdir(config.artifacts, { mode: 0o700 });
    created = true;
    await runPrivateOriginalSharedSANH2Window({
      ...config,
      input,
      signal: lifetime.signal,
      current,
      retain: async (report) => {
        if (reports.length >= 32) throw new Error('H2_ORIGINAL_REPORT_CAPACITY');
        reports.push(report);
      },
    });
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
            kind: 'original-installed-shared-san-h2',
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
  console.error('Original installed shared SAN campaign failure:', cause);
  process.exitCode = 1;
});
