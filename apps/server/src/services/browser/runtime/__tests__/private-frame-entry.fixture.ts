import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  boundedOriginalFile,
  readPublicNativeInput,
  verifyPublicNativeEmits,
} from './public-native-input.js';
import { runPrivateOriginalFrameWindow } from './private-frame-runner.fixture.js';

/** Caller owns the existing campaign deadline and actual child return; this entry adds no timer. */
async function main() {
  const [configPath] = process.argv.slice(2);
  if (process.argv.length !== 3 || !configPath || !isAbsolute(configPath))
    throw new Error('FRAME_ORIGINAL_CONFIG_REQUIRED');
  const absolute = z.string().max(4096).refine(isAbsolute);
  const config = z
    .object({
      input: absolute,
      worktree: absolute,
      artifacts: absolute,
      node: absolute,
      pnpm: absolute,
      acceptance: z.enum(['ui', 'performance', 'resource']),
      idleMilliseconds: z.number().int().positive(),
    })
    .strict()
    .parse(JSON.parse((await boundedOriginalFile(configPath, 16384)).toString('utf8')));
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new Error('FRAME_ORIGINAL_PARENT_STOP'));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  const current = () => lifetime.signal.throwIfAborted();
  const reports: unknown[] = [];
  let first: { value: unknown } | undefined;
  let created = false;
  try {
    const input = await readPublicNativeInput(config.input, current);
    await mkdir(config.artifacts, { mode: 0o700 });
    created = true;
    if ((await realpath(config.artifacts)) !== config.artifacts)
      throw new Error('FRAME_ORIGINAL_ARTIFACT_PATH_REQUIRED');
    current();
    await runPrivateOriginalFrameWindow({
      ...config,
      input,
      signal: lifetime.signal,
      current,
      idle: async () => {
        // A recorded observation duration, never a resource passing threshold or readiness delay.
        await delay(config.idleMilliseconds, undefined, { signal: lifetime.signal });
      },
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
    if (created) {
      try {
        await writeFile(
          join(config.artifacts, 'RESULT.json'),
          JSON.stringify({
            version: 1,
            acceptance: config.acceptance,
            returned: first ? 'FAIL' : 'PASS',
            idleObservationMilliseconds:
              config.acceptance !== 'ui' ? config.idleMilliseconds : null,
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
  // The owning parent captures this original stderr; false/undefined stay explicit.
  console.error('Original UI/performance/resource fixture failure:', cause);
  process.exitCode = 1;
});
