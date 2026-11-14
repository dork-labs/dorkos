/** Linux-only resource evidence. No browser imports, launches or command-line census. */
import { readFile, readdir } from 'node:fs/promises';

export interface ProcessIdentity {
  pid: number;
  parent: number;
  birth: string;
  state: string;
}
export interface MemoryOptions {
  revision: string;
  output: string;
  chats: number[];
  repeats: number;
  samples: number;
  intervalMs: number;
}

/** Refuse a host launch before importing the service or Playwright. */
export function assertDocker(platform: string, docker: boolean, display: string | undefined): void {
  if (platform !== 'linux' || !docker) throw Error('Run this measurement only in sealed Docker.');
  if (!display?.trim()) throw Error('A headed browser requires an Xvfb display inside Docker.');
}

/** Keep experiments comparable; a six-chat boundary is explicit, never an inferred measurement. */
export function parseOptions(args: string[]): MemoryOptions {
  const values = new Map<string, string>();
  const allowed = ['--revision', '--output', '--chats', '--repeats', '--samples', '--interval-ms'];
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!;
    const value = args[index + 1];
    if (!allowed.includes(key) || !value || values.has(key)) throw Error('Invalid arguments.');
    values.set(key, value);
  }
  const revision = values.get('--revision') ?? '';
  const output = values.get('--output') ?? '';
  if (!/^[a-f0-9]{40}$/.test(revision) || !output.startsWith('/'))
    throw Error('Supply --revision <full commit> and --output <absolute new directory>.');
  const bounded = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(values.get(key) ?? fallback);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`Invalid ${key}.`);
    return value;
  };
  const chats = (values.get('--chats') ?? '1,3,5').split(',').map(Number);
  if (chats.join(',') !== '1,3,5' && chats.join(',') !== '1,3,5,6')
    throw Error('--chats must be 1,3,5 or 1,3,5,6.');
  return {
    revision,
    output,
    chats,
    repeats: bounded('--repeats', 3, 1, 5),
    samples: bounded('--samples', 10, 5, 60),
    intervalMs: bounded('--interval-ms', 1000, 200, 2000),
  };
}

/** /proc/stat has a parenthesized name that may itself contain spaces and parentheses. */
export function parseProcess(text: string): ProcessIdentity {
  const close = text.lastIndexOf(')');
  const pid = Number(text.slice(0, text.indexOf(' ')));
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const parent = Number(fields[1]);
  const birth = fields[19];
  if (
    close < 0 ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !Number.isSafeInteger(parent) ||
    parent < 0 ||
    !birth ||
    !/^\d+$/.test(birth) ||
    fields[0]?.length !== 1
  )
    throw Error('Invalid process identity.');
  return { pid, parent, birth, state: fields[0] };
}

/** Read identities only; never inspect cmdline, environment, profiles or credentials. */
export async function processTable(): Promise<ProcessIdentity[]> {
  const entries = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
  const rows = await Promise.all(
    entries.map(async (entry) => {
      try {
        return parseProcess(await readFile(`/proc/${entry}/stat`, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    })
  );
  return rows.filter((row): row is ProcessIdentity => row !== null);
}

/** Root births prevent a reused PID from becoming evidence for our browser. */
export function ownedProcesses(
  roots: ProcessIdentity[],
  table: ProcessIdentity[]
): ProcessIdentity[] {
  for (const root of roots)
    if (!table.some((row) => row.pid === root.pid && row.birth === root.birth && row.state !== 'Z'))
      throw Error('Owned browser root disappeared.');
  const ids = new Set(roots.map((root) => root.pid));
  let previous = -1;
  while (previous !== ids.size) {
    previous = ids.size;
    for (const row of table) if (ids.has(row.parent)) ids.add(row.pid);
  }
  return table.filter((row) => ids.has(row.pid) && row.state !== 'Z');
}

/** PSS apportions shared mappings; RSS is retained as a separate, overlapping metric. */
export function parseSmaps(text: string): { rss: number; pss: number; private: number } {
  const bytes = (name: string) => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(text);
    if (!match) throw Error(`Memory evidence missing ${name}.`);
    const value = Number(match[1]) * 1024;
    if (!Number.isSafeInteger(value)) throw Error('Invalid memory sample.');
    return value;
  };
  return {
    rss: bytes('Rss'),
    pss: bytes('Pss'),
    private: bytes('Private_Clean') + bytes('Private_Dirty'),
  };
}

/** Nearest-rank summaries preserve raw samples separately, including outliers. */
export function summarize(values: number[]) {
  if (!values.length || values.some((value) => !Number.isFinite(value)))
    throw Error('Invalid samples.');
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
  return { min: sorted[0]!, median: rank(0.5), p95: rank(0.95), max: sorted.at(-1)! };
}

async function counter(file: string): Promise<number> {
  const value = Number((await readFile(`/sys/fs/cgroup/${file}`, 'utf8')).trim());
  if (!Number.isSafeInteger(value) || value < 0) throw Error(`Invalid cgroup ${file}.`);
  return value;
}

export interface MemorySample {
  at: string;
  elapsedMs: number;
  browserProcesses: number;
  browserRssBytes: number;
  browserPssBytes: number;
  browserPrivateBytes: number;
  vanishedDuringSample: number;
  nodeRssBytes: number;
  containerBytes: number;
  containerPeakLifetimeBytes: number;
  oomKills: number;
}

/** Container totals include Node, Xvfb, detached helpers and cache; browser totals are a subset. */
export async function sampleMemory(
  roots: ProcessIdentity[],
  started: number
): Promise<MemorySample> {
  const rows = ownedProcesses(roots, await processTable());
  let rss = 0,
    pss = 0,
    privateBytes = 0,
    vanished = 0;
  for (const row of rows) {
    try {
      const before = parseProcess(await readFile(`/proc/${row.pid}/stat`, 'utf8'));
      const memory = parseSmaps(await readFile(`/proc/${row.pid}/smaps_rollup`, 'utf8'));
      const after = parseProcess(await readFile(`/proc/${row.pid}/stat`, 'utf8'));
      if (before.birth !== row.birth || after.birth !== row.birth) {
        vanished++;
        continue;
      }
      rss += memory.rss;
      pss += memory.pss;
      privateBytes += memory.private;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
        (error as NodeJS.ErrnoException).code !== 'ESRCH'
      )
        throw error;
      vanished++;
    }
  }
  ownedProcesses(roots, await processTable());
  const events = await readFile('/sys/fs/cgroup/memory.events', 'utf8');
  const oom = /^oom_kill (\d+)$/m.exec(events);
  if (!oom) throw Error('Missing cgroup OOM evidence.');
  return {
    at: new Date().toISOString(),
    elapsedMs: performance.now() - started,
    browserProcesses: rows.length,
    browserRssBytes: rss,
    browserPssBytes: pss,
    browserPrivateBytes: privateBytes,
    vanishedDuringSample: vanished,
    nodeRssBytes: process.memoryUsage().rss,
    containerBytes: await counter('memory.current'),
    containerPeakLifetimeBytes: await counter('memory.peak'),
    oomKills: Number(oom[1]),
  };
}
