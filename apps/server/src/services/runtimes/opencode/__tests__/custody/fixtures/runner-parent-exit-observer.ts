/** Independent process observations for the macOS-only nested runner case. */
import { execFile, spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { expect } from 'vitest';
import { validateDarwinObserver } from '@dorkos/test-utils/run-custody/posix';

const read = promisify(execFile);

type ProcessIdentity = {
  pid: number;
  parent: number;
  group: number;
  birth: string;
  executable: string;
};

/**
 * Open the reviewed read-only observer for the fixture's known process identities.
 *
 * @param env - The nested runner's curated observer descriptor and invocation environment
 */
export async function openFixtureObserver(env: Record<string, string>) {
  const directory = env.DORKOS_TEST_CUSTODY_DARWIN_OBSERVER_DIR;
  const manifestSha256 = env.DORKOS_TEST_CUSTODY_DARWIN_OBSERVER_MANIFEST_SHA256;
  if (!directory || !manifestSha256) throw new Error('Missing normal reviewed observer');
  const { path } = await validateDarwinObserver({ directory, manifestSha256 });

  return async function inspect(pid: number): Promise<ProcessIdentity> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid owned fixture subject');
    const { stdout } = await read(path, ['inspect', String(pid)], {
      encoding: 'utf8',
      env: {},
      timeout: 500,
      maxBuffer: 8192,
    });
    const boundary = stdout.indexOf('\n');
    const match = /^(\d+) (\d+) (\d+) (\d+:\d+)$/.exec(stdout.slice(0, boundary));
    const executable = stdout.slice(boundary + 1);
    if (!match || Number(match[1]) !== pid || !isAbsolute(executable))
      throw new Error('Unconfirmed owned fixture identity');
    return { pid, parent: Number(match[2]), group: Number(match[3]), birth: match[4], executable };
  };
}

/**
 * Start an independent Node echo control from an inherited-handle-free environment.
 *
 * @param cwd - The outer fixture's private directory
 */
export function openPositiveControl(cwd: string) {
  const child = spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
    cwd,
    env: {},
    stdio: ['pipe', 'pipe', 'ignore'],
    shell: false,
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const replies = lines[Symbol.asyncIterator]();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.stdin.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }
  );
  void closed.catch(() => undefined);

  return {
    pid: child.pid,
    async challenge(words: string) {
      child.stdin.write(words + '\n');
      expect(await replies.next()).toEqual({ value: words, done: false });
    },
    close() {
      child.stdin.end();
      return closed.finally(() => lines.close());
    },
    retire() {
      child.kill();
      return closed.finally(() => lines.close());
    },
  };
}
