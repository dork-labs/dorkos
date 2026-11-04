/** Linux-CI-only crash injection into an exact fixture child and its descendants. */
import fs from 'node:fs';
import path from 'node:path';
import { codexMountRegistry, processIsGone } from '../../../policy/mount-target-guard.js';

interface Identity {
  pid: number;
  parent: number;
  started: string;
}
function identity(pid: number): Identity | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, parent: Number(fields[1]), started: fields[19]! };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Match the pinned Codex registry's FNV-1a hash; never inspect command lines. */
function markerDirectory(target: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(target))
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return path.join(codexMountRegistry(), hash.toString(16).padStart(16, '0'));
}

export async function killFixtureWithRealLeak(
  rootPid: number,
  target: string | readonly string[]
): Promise<void> {
  if (process.platform !== 'linux' || process.env.CI !== 'true')
    throw new Error('Requires Linux CI.');
  const root = identity(rootPid);
  if (!root || rootPid === process.pid) throw new Error('Fixture child is not running.');
  const children = fs
    .readdirSync('/proc')
    .filter((name) => /^[1-9][0-9]*$/.test(name))
    .flatMap((name) => {
      const id = identity(Number(name));
      return id ? [id] : [];
    });
  const owned = new Map<number, Identity>([[rootPid, root]]);
  for (let changed = true; changed;) {
    changed = false;
    for (const child of children)
      if (!owned.has(child.pid) && owned.has(child.parent)) {
        owned.set(child.pid, child);
        changed = true;
      }
  }
  const signal = (pid: number, value: NodeJS.Signals) => {
    const captured = owned.get(pid);
    const now = identity(pid);
    if (!captured || !now || now.started !== captured.started) return;
    console.info('Codex recovery fixture signal', {
      senderPid: process.pid,
      targetPid: pid,
      signal: value,
      atMs: Date.now(),
    });
    try {
      process.kill(pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const targets = typeof target === 'string' ? [target] : target;
  const holders = new Set<number>();
  for (const file of targets) {
    for (const name of fs.readdirSync(markerDirectory(file))) {
      const pid = Number(name);
      if (owned.has(pid)) holders.add(pid);
    }
  }
  // Freeze actual marker holders first so their cleanup cannot win the kill
  // race. Only a descendant of the exact child spawned by this test qualifies.
  try {
    for (const pid of holders) signal(pid, 'SIGSTOP');
    for (const target of targets) {
      const file = fs.lstatSync(target);
      if (!file.isFile() || file.size !== 0)
        throw new Error('No real synthetic mount target was created.');
    }
    for (const pid of holders) signal(pid, 'SIGKILL');
    signal(rootPid, 'SIGKILL');
    for (const pid of [...owned.keys()].reverse())
      if (pid !== rootPid && !holders.has(pid)) signal(pid, 'SIGKILL');
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && [...owned.keys()].some((pid) => !processIsGone(pid)))
      await new Promise((resolve) => setTimeout(resolve, 20));
    if ([...owned.keys()].some((pid) => !processIsGone(pid)))
      throw new Error('Fixture descendants have not exited.');
    for (const target of targets) {
      const leftover = fs.lstatSync(target);
      if (!leftover.isFile() || leftover.size !== 0)
        throw new Error('Crash did not leave a real mount target.');
    }
  } finally {
    // Never strand a stopped fixture if validation or crash injection fails.
    for (const pid of holders) signal(pid, 'SIGCONT');
  }
}
