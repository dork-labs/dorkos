/** Bounded cleanup for the consent proof's detached, disposable Chrome instance. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
interface ProcessIdentity {
  pid: number;
  parent: number;
  group: number;
  identity: string;
  command: string;
}
async function census(): Promise<ProcessIdentity[]> {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command='], {
    timeout: 2_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/);
    return match
      ? [
          {
            pid: Number(match[1]),
            parent: Number(match[2]),
            group: Number(match[3]),
            identity: `${match[1]}:${match[4]}:${match[5]}`,
            command: match[5]!,
          },
        ]
      : [];
  });
}
/** Bound a proof operation while preserving the original failure. */
export async function bounded<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Capture descendants and escaped helpers by their unique fixture path, then recheck identity before signalling. */
export function ownedChromeCleanup(pid: number, fixture: string) {
  const owned = new Set<string>();
  let inFlight: Promise<void> | undefined;
  const capture = () => {
    // Coalesce timer ticks: a slow census must not queue an unbounded cleanup backlog.
    if (inFlight) return inFlight;
    const next = (async () => {
      const rows = await census();
      const selected = new Set(
        rows
          .filter((row) => owned.has(row.identity) || row.command.includes(fixture))
          .map((row) => row.pid)
      );
      const root = rows.find((row) => row.pid === pid);
      if (root && !owned.size) {
        assert(
          root.command.includes(fixture),
          'Refuse a Chrome PID without the owned fixture path'
        );
        assert.equal(root.group, pid, 'Chrome must start in its own detached group');
      }
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          if (!selected.has(row.pid) && selected.has(row.parent)) {
            selected.add(row.pid);
            changed = true;
          }
        }
      }
      for (const row of rows) if (selected.has(row.pid)) owned.add(row.identity);
    })();
    inFlight = next.finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
  return {
    capture,
    async close() {
      // Finish internally before the caller's 60-second timeout; a timeout must not
      // leave a detached cleanup promise signalling processes after handoff.
      const deadline = Date.now() + 50_000;
      const currentCensus = async () => {
        assert(Date.now() < deadline, 'Owned Chrome cleanup deadline exceeded');
        const rows = await census();
        assert(Date.now() < deadline, 'Owned Chrome cleanup deadline exceeded');
        return rows;
      };
      await capture();
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        const rows = await currentCensus();
        const group = rows.filter((row) => row.group === pid);
        assert(
          group.every((row) => owned.has(row.identity)),
          'Refuse a reused or unowned process group'
        );
        if (group.length) {
          try {
            process.kill(-pid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
        for (const row of rows.filter(
          (entry) => entry.group !== pid && owned.has(entry.identity)
        )) {
          const current = (await currentCensus()).find((entry) => entry.pid === row.pid);
          if (current?.identity !== row.identity) continue;
          try {
            process.kill(row.pid, signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
        for (let attempt = 0; attempt < 15; attempt++) {
          await capture();
          const remaining = (await currentCensus()).filter(
            (row) => row.group === pid || owned.has(row.identity) || row.command.includes(fixture)
          );
          if (!remaining.length) return;
          await delay(200);
        }
      }
      throw new Error('Owned Chrome processes remain; preserve the fixture profile');
    },
  };
}
