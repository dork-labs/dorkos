import { spawn } from 'node:child_process';
import { cpus, freemem, totalmem, loadavg, release, arch } from 'node:os';
import { performance } from 'node:perf_hooks';

type Identity = Readonly<{ pid: number; birth: string }>;
type Counter = Readonly<{
  pid: number;
  rssBytes: number;
  cpuMilliseconds: number;
}>;
type Owner = Readonly<{
  own: <T>(work: Promise<T>) => Promise<T>;
  guard: () => void;
  signal: AbortSignal;
  snapshot: () => Promise<readonly Identity[]>;
  observe: (
    identity: Identity,
    signal: AbortSignal
  ) => Promise<Readonly<{ status: 'alive' | 'dead' | 'unknown' }>>;
}>;
const key = (identity: Identity) => `${identity.pid}:${identity.birth}`;
const refused = (message: string) => new Error(`PUBLIC_NATIVE_RESOURCE_${message}`);

/** CPU is cumulative consumed time, not ps's lifetime-averaged %cpu. */
export function parseCounters(bytes: string, expected: readonly Identity[]): readonly Counter[] {
  const rows = bytes
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+((?:\d+-)?\d+(?::\d+){1,2}(?:\.\d+)?)\s*$/u.exec(line);
      if (!match) throw refused('COUNTER_ROW_UNKNOWN');
      const pid = Number(match[1]);
      const [days, clock] = match[3]!.includes('-') ? match[3]!.split('-') : ['0', match[3]!];
      const parts = clock!.split(':');
      const [secondsText, fraction = ''] = parts.at(-1)!.split('.');
      if (
        parts.length < 2 ||
        parts.length > 3 ||
        fraction.length > 3 ||
        BigInt(secondsText!) >= 60n ||
        (parts.length === 3 && BigInt(parts[1]!) >= 60n)
      )
        throw refused('CPU_TIME_UNKNOWN');
      const seconds =
        parts.slice(0, -1).reduce((sum, value) => sum * 60n + BigInt(value), 0n) * 60n +
        BigInt(secondsText!);
      const milliseconds =
        (BigInt(days!) * 86400n + seconds) * 1000n + BigInt(fraction.padEnd(3, '0'));
      const rss = BigInt(match[2]!) * 1024n;
      if (
        milliseconds > BigInt(Number.MAX_SAFE_INTEGER) ||
        rss > BigInt(Number.MAX_SAFE_INTEGER) ||
        !Number.isSafeInteger(pid) ||
        pid < 1 ||
        rss < 1n
      )
        throw refused('COUNTER_VALUE_UNKNOWN');
      const rssBytes = Number(rss),
        cpuMilliseconds = Number(milliseconds);
      return { pid, rssBytes, cpuMilliseconds };
    });
  const wanted = new Set(expected.map((identity) => identity.pid));
  if (
    !expected.length ||
    expected.length > 512 ||
    wanted.size !== expected.length ||
    rows.length !== expected.length ||
    new Set(rows.map((row) => row.pid)).size !== rows.length ||
    rows.some((row) => !wanted.has(row.pid))
  )
    throw refused('COMPLETE_TREE_COUNTERS_REQUIRED');
  return rows;
}

export function requireOriginalCounterEOF(
  pipes: readonly Readonly<{ readableEnded: boolean }>[],
  ends: readonly boolean[]
): void {
  if (
    pipes.length !== 2 ||
    ends.length !== 2 ||
    pipes.some((pipe, index) => !ends[index] || !pipe.readableEnded)
  )
    throw refused('COUNTER_PIPE_EOF_REQUIRED');
}

/** Only caller's known native births reach ps. No command, environment, or OS-wide ownership scan. */
async function counters(
  identities: readonly Identity[],
  owner: Owner
): Promise<readonly Counter[]> {
  return owner.own(
    Promise.resolve().then(async () => {
      owner.guard();
      if (owner.signal.aborted) throw refused('ADMISSION_CLOSED');
      if (
        !identities.length ||
        identities.length > 512 ||
        identities.some((id) => !Number.isSafeInteger(id.pid) || id.pid < 1 || !id.birth)
      )
        throw refused('IDENTITY_REQUIRED');
      const child = spawn(
        '/bin/ps',
        ['-p', identities.map((id) => id.pid).join(','), '-o', 'pid=,rss=,time='],
        {
          shell: false,
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        }
      );
      let first: { value: unknown } | undefined;
      let bytes = '',
        size = 0;
      const fail = (value: unknown) => {
        first ??= { value };
      };
      const terminal = new Promise<void>((resolve) => {
        child.once('error', fail);
        child.once('close', (code, signal) => {
          if (code !== 0 || signal !== null) fail(refused('COUNTER_RETURN_UNKNOWN'));
          resolve();
        });
      });
      const pipes = [child.stdout!, child.stderr!];
      const ends = pipes.map(() => false);
      const streams = pipes.map(
        (stream, index) =>
          new Promise<void>((resolve) => {
            stream.once('error', fail);
            stream.once('end', () => {
              ends[index] = true;
            });
            stream.once('close', resolve);
            stream!.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > 128 * 1024) {
                fail(refused('COUNTER_OUTPUT_OVERFLOW'));
                try {
                  child.kill('SIGTERM');
                } catch (value) {
                  fail(value);
                }
              } else if (index === 0) bytes += chunk.toString('utf8');
              else if (chunk.length) fail(refused('COUNTER_STDERR_UNKNOWN'));
            });
          })
      );
      const abort = () => {
        fail(refused('COUNTER_ABORTED'));
        try {
          child.kill('SIGTERM');
        } catch (value) {
          fail(value);
        }
      };
      owner.signal.addEventListener('abort', abort, { once: true });
      if (owner.signal.aborted) abort();
      try {
        // Retain all original duties until natural close and both pipe returns, even on an error.
        await Promise.allSettled([terminal, ...streams]);
        try {
          requireOriginalCounterEOF(pipes, ends);
        } catch (value) {
          fail(value);
        }
        if (first) throw first.value;
        owner.guard();
        return parseCounters(bytes, identities);
      } finally {
        owner.signal.removeEventListener('abort', abort);
      }
    })
  );
}

function host() {
  const cores = cpus();
  return {
    monotonicMilliseconds: performance.now(),
    timestamp: new Date().toISOString(),
    freeBytes: freemem(),
    totalBytes: totalmem(),
    loadAverage: loadavg(),
    logicalCores: cores.length,
    idleMilliseconds: cores.reduce((sum, core) => sum + core.times.idle, 0),
    totalMilliseconds: cores.reduce(
      (sum, core) => sum + Object.values(core.times).reduce((a, b) => a + b, 0),
      0
    ),
  };
}
type Sample = Readonly<{
  host: ReturnType<typeof host>;
  counterWindow: Readonly<{
    startMilliseconds: number;
    endMilliseconds: number;
  }>;
  identities: readonly Identity[];
  counters: readonly Counter[];
}>;
export async function sampleResources(owner: Owner): Promise<Sample> {
  owner.guard();
  const before = await owner.snapshot();
  const assertAlive = async (values: readonly Identity[]) => {
    // Native observer creates an original helper producer per call. Avoid a cohort-sized fork burst.
    for (const identity of values) {
      const observation = await owner.own(owner.observe(identity, owner.signal));
      owner.guard();
      if (observation.status !== 'alive') throw refused('EXACT_BIRTH_LIVENESS_UNKNOWN');
    }
  };
  await assertAlive(before);
  const startMilliseconds = performance.now();
  const measured = await counters(before, owner);
  const endMilliseconds = performance.now(),
    measuredHost = host();
  const after = await owner.snapshot();
  if (
    before.length !== after.length ||
    before.some((id) => !after.some((other) => key(other) === key(id)))
  )
    throw refused('TREE_CHURN_OBSERVATION_UNAVAILABLE');
  await assertAlive(after);
  return {
    host: measuredHost,
    counterWindow: { startMilliseconds, endMilliseconds },
    identities: before,
    counters: measured,
  };
}

export function resourceInterval(
  before: Sample,
  after: Sample,
  node: Identity,
  baseline: readonly Identity[]
) {
  const elapsedMilliseconds =
    (after.counterWindow.startMilliseconds +
      after.counterWindow.endMilliseconds -
      before.counterWindow.startMilliseconds -
      before.counterWindow.endMilliseconds) /
    2;
  const intervalBoundsMilliseconds = {
    minimum: after.counterWindow.startMilliseconds - before.counterWindow.endMilliseconds,
    maximum: after.counterWindow.endMilliseconds - before.counterWindow.startMilliseconds,
  };
  if (
    !(elapsedMilliseconds > 0) ||
    before.identities.length !== after.identities.length ||
    before.identities.some((id) => !after.identities.some((other) => key(other) === key(id)))
  )
    throw refused('INTERVAL_COHORT_CHANGED');
  const rows = after.identities.map((identity) => {
    const previous = before.counters.find((row) => row.pid === identity.pid),
      current = after.counters.find((row) => row.pid === identity.pid);
    if (!previous || !current || current.cpuMilliseconds < previous.cpuMilliseconds)
      throw refused('CPU_COUNTER_REGRESSED');
    return {
      ...identity,
      rssBytes: current.rssBytes,
      cpuMilliseconds: current.cpuMilliseconds - previous.cpuMilliseconds,
      cpuPercentOneCore:
        (100 * (current.cpuMilliseconds - previous.cpuMilliseconds)) / elapsedMilliseconds,
      cpuPercentOneCoreBounds:
        intervalBoundsMilliseconds.minimum > 0
          ? {
              minimum:
                (100 * (current.cpuMilliseconds - previous.cpuMilliseconds)) /
                intervalBoundsMilliseconds.maximum,
              maximum:
                (100 * (current.cpuMilliseconds - previous.cpuMilliseconds)) /
                intervalBoundsMilliseconds.minimum,
            }
          : null,
    };
  });
  const exactNode = rows.find((row) => key(row) === key(node));
  if (!exactNode) throw refused('ORIGINAL_NODE_BIRTH_REQUIRED');
  const additional = rows.filter((row) => !baseline.some((id) => key(row) === key(id)));
  const totalDelta = after.host.totalMilliseconds - before.host.totalMilliseconds;
  const idleDelta = after.host.idleMilliseconds - before.host.idleMilliseconds;
  if (!(totalDelta > 0) || idleDelta < 0 || idleDelta > totalDelta)
    throw refused('HOST_CPU_OBSERVATION_UNKNOWN');
  return {
    elapsedMilliseconds,
    intervalBoundsMilliseconds,
    counterWindows: [before.counterWindow, after.counterWindow],
    rows,
    node: exactNode,
    additionalNativeCohort: {
      attribution: 'unclassified; not per-browser ownership',
      identities: additional,
      rssBytes: additional.reduce((sum, row) => sum + row.rssBytes, 0),
      cpuMilliseconds: additional.reduce((sum, row) => sum + row.cpuMilliseconds, 0),
    },
    host: {
      before: before.host,
      after: after.host,
      cpuPercent: 100 * (1 - idleDelta / totalDelta),
    },
  };
}

export function resourceReport(
  baseline: Sample,
  idle: ReturnType<typeof resourceInterval>,
  active: ReturnType<typeof resourceInterval>,
  payload: Readonly<{ bytes: number; frames: number }>
) {
  return {
    schema: 1,
    status: 'UNVERIFIED',
    os: {
      platform: process.platform,
      release: release(),
      architecture: arch(),
    },
    runtime: { node: process.version, pid: process.pid },
    counter: '/bin/ps PID-only rss KiB, cumulative time; native exact birth/tree fences',
    baseline,
    idle,
    active,
    wire: {
      ...payload,
      bytesPerSecond: (payload.bytes * 1000) / active.elapsedMilliseconds,
      framesPerSecond: (payload.frames * 1000) / active.elapsedMilliseconds,
      renderedFrontendReceipt: false,
    },
    availability: {
      node: 'observed',
      combinedNativeCohort: 'observed but unclassified',
      browserA: 'unavailable authoritative root projection',
      browserB: 'unavailable authoritative root projection',
      frontend: 'unavailable; HTTP fixture owns no frontend',
      nonzeroCPUByObservedRole: {
        nodeIdle: idle.node.cpuMilliseconds > 0,
        nodeActive: active.node.cpuMilliseconds > 0,
        additionalNativeIdle: idle.additionalNativeCohort.cpuMilliseconds > 0,
        additionalNativeActive: active.additionalNativeCohort.cpuMilliseconds > 0,
      },
      twoViewers:
        payload.frames >= 2
          ? 'two distinct authenticated HTTP viewer receipts; not rendered viewers'
          : 'unavailable',
    },
    headroom: {
      observedFreeBytes: active.host.after.freeBytes,
      additionalSlotsAdmitted: 0,
      reason:
        'No calibrated supported envelope or enforceable pressure-refusal policy; measurements confer no capacity.',
    },
    limitations: [
      'RSS sums may count shared pages repeatedly.',
      'Free RAM excludes reclaimable cache.',
      'Complete stable-tree samples refuse churn rather than treating missing counters as zero.',
      'CPU percentage uses counter-bracket midpoint elapsed time; bounds retain timing uncertainty.',
      'Host load includes native observer work around the counters.',
      'No latency acceptance claim from this resource-only window.',
    ],
  };
}
