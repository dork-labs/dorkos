/** Adapter for the reviewed, source-built, read-only Darwin observer. */
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

const read = promisify(execFile);

async function query(observer, selector, pid) {
  if (!isAbsolute(observer ?? '') || !Number.isSafeInteger(pid) || pid < 1) return;
  try {
    const { stdout } = await read(observer, [selector, String(pid)], {
      encoding: 'utf8',
      timeout: 500,
      maxBuffer: 8192,
      env: {},
    });
    return stdout;
  } catch {
    return;
  }
}

/** Return the kernel's image path, rather than the executable passed to spawn. */
export async function observeDarwinIdentity(observer, pid) {
  const bytes = await query(observer, 'inspect', pid);
  if (!bytes) return;
  const newline = bytes.indexOf('\n');
  if (newline < 0) return;
  const match = /^(\d+) (\d+) (\d+) (\d+:\d+)$/.exec(bytes.slice(0, newline));
  const executable = bytes.slice(newline + 1);
  if (!match || Number(match[1]) !== pid || !isAbsolute(executable)) return;
  return { pid, parent: Number(match[2]), group: Number(match[3]), birth: match[4], executable };
}

/** A filtered query from inside the current anchor group counts the observer itself. */
export async function observeDarwinMembers(observer, group, anchor) {
  if (group !== anchor) return 'members-or-unknown';
  const bytes = await query(observer, 'group-members', group);
  if (!bytes) return 'members-or-unknown';
  const records = bytes.trim().split('\n');
  if (!records.every((pid) => /^[1-9]\d*$/.test(pid))) return 'members-or-unknown';
  // The native observer omits its own PID from the census.
  return records.length === 1 && Number(records[0]) === anchor
    ? 'anchor-alone'
    : 'members-or-unknown';
}
