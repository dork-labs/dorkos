import { execFileSync } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { ProcessIdentity } from '../configuration.js';
import { BrowserLifecycleError } from '../lifecycle/errors.js';

/** Issue a host birth identity; unavailable observation is never observed death. */
export function hostIdentity(pid: number): ProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid < 1 || process.platform === 'win32')
    throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
  try {
    const text = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'stat='], {
      encoding: 'utf8',
      timeout: 1000,
    }).trim();
    const match = /^(.*?)\s+(\S+)$/.exec(text);
    if (!match) throw new Error();
    return match[2]!.startsWith('Z') ? null : { pid, birth: match[1]! };
  } catch {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return null;
    }
    throw new BrowserLifecycleError('PROCESS_OBSERVATION_UNAVAILABLE');
  }
}

/** Read Chromium's native holder without deleting or repairing its lock. */
export function nativeHolder(profileDir: string): ProcessIdentity | null {
  const pid = nativeHolderPid(profileDir);
  if (pid === null) return null;
  const identity = hostIdentity(pid);
  if (!identity) throw new BrowserLifecycleError('UNKNOWN_NATIVE_HOLDER');
  return identity;
}

/** Read only the native lock PID; a separate lifetime observation must bind it. */
export function nativeHolderPid(profileDir: string): number | null {
  let target: string;
  try {
    target = readlinkSync(join(profileDir, 'SingletonLock'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new BrowserLifecycleError('UNKNOWN_NATIVE_HOLDER');
  }
  const match = /^(.*)-(\d+)$/.exec(target);
  if (!match || match[1] !== hostname()) throw new BrowserLifecycleError('UNKNOWN_NATIVE_HOLDER');
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647)
    throw new BrowserLifecycleError('UNKNOWN_NATIVE_HOLDER');
  return pid;
}
