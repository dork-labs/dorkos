import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function startupError(code) {
  const error = new Error(`Fixture child startup: ${code}`);
  error.code = code;
  return error;
}

/** Spawn only a test-owned child; register cleanup before awaiting any IPC readiness. */
export function startTestChild(
  t,
  args,
  { env = process.env, cwd = process.cwd(), timeoutMs = 3000 } = {}
) {
  const child = spawn(process.execPath, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false;
  const terminated = new Promise((resolve) => {
    child.once('close', () => {
      closed = true;
      resolve();
    });
  });
  let stopPromise;
  const stop = () => {
    stopPromise ??= (async () => {
      if (closed) return;
      if (child.exitCode === null && child.signalCode === null && child.pid) child.kill('SIGKILL');
      let timer;
      try {
        await Promise.race([
          terminated,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(startupError('CLEANUP_TIMEOUT')), 2000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    })();
    return stopPromise;
  };
  t.after(stop);
  const lines = createInterface({ input: child.stdout });
  // Drain private stderr without retaining or printing page/profile information.
  child.stderr.resume();
  const ready = new Promise((resolve, reject) => {
    let timer;
    const clear = () => {
      clearTimeout(timer);
      lines.off('line', onLine);
      lines.close();
      child.off('error', onError);
      child.off('exit', onExit);
    };
    const onLine = (line) => {
      clear();
      resolve(line);
    };
    const onError = () => {
      clear();
      reject(startupError('SPAWN_FAILED'));
    };
    const onExit = () => {
      clear();
      reject(startupError('EXIT_BEFORE_READY'));
    };
    lines.once('line', onLine);
    child.once('error', onError);
    child.once('exit', onExit);
    timer = setTimeout(() => {
      clear();
      reject(startupError('STARTUP_TIMEOUT'));
    }, timeoutMs);
  }).catch(async (error) => {
    await stop();
    throw error;
  });
  return { child, ready, stop, terminated };
}
