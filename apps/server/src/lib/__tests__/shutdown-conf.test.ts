import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const conf = pathToFileURL(createRequire(import.meta.url).resolve('conf')).href;
const shutdown = new URL('../shutdown-signal.ts', import.meta.url).href;
const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

/** Exercise Conf's real process hooks, which mocks cannot reproduce. */
async function launch(withHandler = true) {
  const directory = await mkdtemp(join(tmpdir(), 'shutdown-conf-'));
  directories.push(directory);
  const settled = join(directory, 'settled');
  const source = `
    import Conf from ${JSON.stringify(conf)};
    import { createSignalShutdown } from ${JSON.stringify(shutdown)};
    import { writeFile } from 'node:fs/promises';
    const store = new Conf({ projectName: 'shutdown-test', cwd: ${JSON.stringify(directory)} });
    store.set('retained', true);
    const shutdown = createSignalShutdown(async () => {
      process.stdout.write('DRAINING\\n');
      await new Promise(resolve => setTimeout(resolve, 500));
      await writeFile(${JSON.stringify(settled)}, 'done');
    });
    ${withHandler ? "process.on('SIGTERM', shutdown);" : ''}
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const lines = createInterface({ input: child.stdout! });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr!.on('data', (chunk) => (stderr += String(chunk)));
  expect((await once(lines, 'line', { signal: AbortSignal.timeout(15_000) }))[0]).toBe('READY');
  return { child, lines, exited, settled, stderr: () => stderr };
}

// These child-process assertions exercise POSIX signal delivery.
describe.skipIf(process.platform === 'win32')(
  'graceful shutdown with the configuration store',
  () => {
    it('one signal lets services settle before exiting zero', async () => {
      const run = await launch();
      run.child.kill('SIGTERM');
      const [code, signal] = await run.exited;
      expect({ code, signal }, run.stderr()).toEqual({ code: 0, signal: null });
      expect(await readFile(run.settled, 'utf8')).toBe('done');
    }, 20_000);

    it('a genuine second signal still exits immediately', async () => {
      const run = await launch();
      const draining = new Promise<void>((resolve) => {
        run.lines.on('line', (line) => {
          if (line === 'DRAINING') resolve();
        });
      });
      run.child.kill('SIGTERM');
      await draining;
      run.child.kill('SIGTERM');
      const [code, signal] = await run.exited;
      expect({ code, signal }, run.stderr()).toEqual({ code: 1, signal: null });
      await expect(readFile(run.settled, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }, 20_000);

    it('preserves the default signal exit when no application handler exists', async () => {
      const run = await launch(false);
      run.child.kill('SIGTERM');
      const [code, signal] = await run.exited;
      expect({ code, signal }, run.stderr()).toEqual({ code: null, signal: 'SIGTERM' });
      await expect(readFile(run.settled, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }, 20_000);
  }
);
