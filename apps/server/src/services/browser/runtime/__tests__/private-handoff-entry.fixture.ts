import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { readPublicNativeInput, verifyPublicNativeEmits } from './public-native-input.js';

/** Isolated executable entry. Caller owns the original child, deadline and source guard. */
async function main() {
  const [inputPath, reportPath] = process.argv.slice(2);
  if (
    process.argv.length !== 4 ||
    !inputPath ||
    !reportPath ||
    !isAbsolute(inputPath) ||
    !isAbsolute(reportPath)
  )
    throw new Error('HANDOFF_ORIGINAL_INPUT_REPORT_REQUIRED');
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new Error('HANDOFF_ORIGINAL_PARENT_STOP'));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const current = () => lifetime.signal.throwIfAborted();
  const input = await readPublicNativeInput(inputPath, current);
  // Set before importing the genuine original index/env/config constructors.
  process.env.DORK_HOME = input.home;
  process.env.DORKOS_SEARCH_NO_EXTERNAL_HISTORY = 'true';
  process.env.DORKOS_PORT = String(input.port);
  process.env.DORKOS_HOST = '127.0.0.1';
  process.env.DORKOS_DEFAULT_CWD = input.home;
  process.env.DORKOS_BOUNDARY = input.home;
  process.env.DORKOS_TASKS_ENABLED = 'false';
  process.env.NODE_ENV = 'production';
  const { prepareOriginalHandoffWorkspace, runPrivateOriginalHandoff } =
    await import('./private-handoff-runner.fixture.js');
  const workspace = await prepareOriginalHandoffWorkspace(input.home);
  const reports: unknown[] = [];
  let first: { value: unknown } | undefined;
  try {
    await runPrivateOriginalHandoff({
      input,
      workspace,
      signal: lifetime.signal,
      current,
      retain: async (report) => {
        reports.push(report);
      },
    });
    await verifyPublicNativeEmits(input, current);
  } catch (value) {
    first = { value };
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    try {
      await writeFile(
        reportPath,
        JSON.stringify({ version: 1, returned: first ? 'FAIL' : 'PASS', reports }) + '\n',
        { flag: 'wx', mode: 0o600 }
      );
    } catch (value) {
      first ??= { value };
    }
  }
  if (first) throw first.value;
}
void main().catch(() => {
  process.exitCode = 1;
});
