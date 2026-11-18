/** Bounded npm custody for public-package fixture preparation; never logs raw output. */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const OUTPUT_BYTES = 2 * 1024 * 1024;
type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
type Reason =
  'deadline' | 'output-limit' | 'spawn-error-no-pid' | 'process-error' | 'exit' | 'spawn-throw';

/**
 * Drain/count both streams. Failure stays pending until close, including spawn errors.
 * The injected boundary is used only for synthetic child-event unit validation.
 */
export async function runPreparationCommand(
  stage: 'ci' | 'ls',
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  deadline: number,
  launch: Spawn = spawn,
  record: (line: string) => void = (line) => console.info(`[opencode-plugin-preparation] ${line}`)
): Promise<void> {
  const started = performance.now();
  const remaining = deadline - started;
  if (remaining <= 0) throw new Error('Plugin package preparation deadline exceeded');
  return new Promise<void>((resolve, reject) => {
    const report = (
      reason: Reason | null,
      code: number | null,
      signal: NodeJS.Signals | null,
      pid: number | null
    ) => {
      record(
        JSON.stringify({ stage, reason, code, signal, pid, elapsedMs: performance.now() - started })
      );
    };
    let child: ChildProcess;
    try {
      child = launch('npm', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      report('spawn-throw', null, null, null);
      reject(new Error(`Plugin npm ${stage} could not create a child`));
      return;
    }
    let reason: Reason | null = null;
    let killed = false;
    let bytes = 0;
    const fail = (next: Reason) => {
      reason ??= next;
      if (!killed && child.pid !== undefined) {
        killed = true;
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => fail('deadline'), remaining);
    const read = (data: Buffer | string) => {
      bytes += Buffer.byteLength(data);
      if (bytes > OUTPUT_BYTES) fail('output-limit');
    };
    const onError = () => fail(child.pid === undefined ? 'spawn-error-no-pid' : 'process-error');
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.on('error', onError);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      child.stdout?.off('data', read);
      child.stderr?.off('data', read);
      child.off('error', onError);
      if (!reason && (code !== 0 || signal !== null)) reason = 'exit';
      report(reason, code, signal, child.pid ?? null);
      if (reason) reject(new Error(`Plugin npm ${stage} failed (${reason})`));
      else resolve();
    });
  });
}
