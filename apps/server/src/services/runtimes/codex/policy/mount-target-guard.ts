/** Coordinate with Codex's registry, not merely DorkOS's in-memory pool. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Registry location used by the pinned Linux Codex sandbox helper. */
export function codexMountRegistry(): string {
  return path.join(
    fs.realpathSync(os.tmpdir()),
    `codex-bwrap-synthetic-mount-targets-${process.getuid?.()}`
  );
}

/** Both the OS process directory and kill(0) must say the PID is gone. */
export function processIsGone(pid: number, procRoot = '/proc'): boolean {
  try {
    fs.lstatSync(path.join(procRoot, String(pid)));
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    throw error;
  }
}

/** Call only while holding the registry flock. Any uncertainty refuses removal. */
export function assertNoLiveCodex(registry: string, procRoot = '/proc'): void {
  for (const folder of fs.readdirSync(registry, { withFileTypes: true })) {
    if (folder.name === 'lock' && folder.isFile()) continue;
    if (!/^[a-f0-9]{16}$/.test(folder.name) || !folder.isDirectory())
      throw new Error('Codex cleanup cannot verify its process markers.');
    const dir = path.join(registry, folder.name);
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022)
      throw new Error('Codex marker owner changed.');
    for (const marker of fs.readdirSync(dir, { withFileTypes: true })) {
      const markerStat = fs.lstatSync(path.join(dir, marker.name));
      const pid = Number(marker.name);
      if (
        !/^[1-9][0-9]*$/.test(marker.name) ||
        !Number.isSafeInteger(pid) ||
        !marker.isFile() ||
        !markerStat.isFile() ||
        markerStat.nlink !== 1 ||
        markerStat.uid !== process.getuid?.() ||
        !processIsGone(pid, procRoot)
      )
        throw new Error('Codex cleanup is waiting for running processes to stop.');
    }
  }
  // A newly started app-server may not have a marker yet. Check all this
  // user's executable identities too; never read argv, environments or secrets.
  for (const name of fs.readdirSync(procRoot)) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    const proc = path.join(procRoot, name);
    try {
      if (fs.statSync(proc).uid !== process.getuid?.()) continue;
      const executable = fs.readlinkSync(path.join(proc, 'exe')).replace(/ \(deleted\)$/, '');
      if (/^(?:codex(?:-linux-sandbox)?|bwrap)$/.test(path.basename(executable)))
        throw new Error('Codex cleanup is waiting for running processes to stop.');
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === 'ENOENT' &&
        processIsGone(Number(name), procRoot)
      )
        continue;
      throw error;
    }
  }
}

/**
 * The same flock Codex holds while registering/cleaning targets. A new helper
 * cannot mount a placeholder between the process check and our synchronous
 * unlink. The lock command gets no shell, argv payload or account values.
 */
export async function withCodexRegistryLock<T>(action: (registry: string) => T): Promise<T> {
  if (process.platform !== 'linux') throw new Error('Codex mount cleanup requires Linux.');
  const registry = codexMountRegistry();
  fs.mkdirSync(registry, { recursive: true, mode: 0o700 });
  const dir = fs.lstatSync(registry);
  if (!dir.isDirectory() || dir.uid !== process.getuid?.() || dir.mode & 0o022)
    throw new Error('Codex cleanup cannot trust its process registry.');
  const lock = path.join(registry, 'lock');
  const fd = fs.openSync(
    lock,
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    0o600
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.mode & 0o022)
      throw new Error('Codex cleanup cannot trust its process lock.');
    const child = spawn(
      '/usr/bin/flock',
      [
        '--exclusive',
        '--nonblock',
        '/proc/self/fd/3',
        process.execPath,
        '-e',
        "process.stdout.write('locked\\n'); process.stdin.resume();",
      ],
      { stdio: ['pipe', 'pipe', 'pipe', fd] }
    );
    return await new Promise<T>((resolve, reject) => {
      let value: T;
      let ran = false;
      let output = '';
      let failure: unknown;
      const timer = setTimeout(() => {
        failure = new Error('Codex cleanup could not acquire its process lock.');
        child.stdin!.end();
        child.kill('SIGTERM');
      }, 5_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.stdout!.on('data', (chunk: Buffer) => {
        output += chunk.toString();
        if (ran || failure || !output.includes('locked\n')) return;
        ran = true;
        try {
          value = action(registry);
        } catch (error) {
          failure = error;
        }
        child.stdin!.end();
      });
      child.stdin!.on('error', (error) => {
        failure ??= error;
      });
      child.stderr!.resume();
      child.once('exit', (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (!ran || code !== 0)
          reject(new Error('Codex cleanup could not acquire its process lock.'));
        else resolve(value!);
      });
    });
  } finally {
    fs.closeSync(fd);
  }
}
