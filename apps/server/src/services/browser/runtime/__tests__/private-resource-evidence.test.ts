import { ChildProcess } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import {
  parseOriginalResourceReady,
  originalResourceViewerInterval,
  retainOriginalResourceJob,
} from './private-resource-evidence.fixture.js';
import { createOriginalProjectedResourceBank } from './private-projected-resource-bank.fixture.js';
import { withOriginalFrameDrain } from './private-frame-channel.fixture.js';
import type { PrivateViewerSample } from '../private-native-acceptance.js';

// Controlled observations exercise refusal, correlation and cleanup. They confer no native PASS.
const binding = (id: string) => ({
  browserId: id.repeat(22),
  browserGeneration: 0,
  tabId: id.toLowerCase().repeat(22),
  navigationGeneration: 1,
  viewportVersion: 0,
  epoch: 1,
  inputGeneration: 1,
});
const subject = (id: string, persistent: boolean) => ({
  open: {
    requestId: 'R'.repeat(22),
    binding: binding(id),
    instance: {
      browserId: id.repeat(22),
      browserGeneration: 0,
      mode: persistent ? 'persistent' : 'ephemeral',
      status: 'running',
      ...(persistent ? { profileId: 'P'.repeat(22) } : {}),
    },
  },
  drawn: {
    binding: binding(id),
    viewerId: (id === 'B' ? 'V' : 'W').repeat(22),
    frameId: 'F'.repeat(22),
    sequence: 0,
    stage: 'drawn',
    drawnAt: '2026-10-06T00:00:00.000Z',
  },
  decoded: 2,
  draws: 2,
  bytes: 100,
});
const ready = () =>
  parseOriginalResourceReady({ subjects: [subject('B', true), subject('C', false)] });
const snapshot = (at: number, advance = 0) => ({
  at,
  viewers: ready().subjects.map((s) => ({
    viewerId: s.drawn.viewerId,
    binding: { ...s.drawn.binding },
    leases: [
      {
        viewer: {
          viewerId: s.drawn.viewerId,
          binding: { ...s.drawn.binding },
          expiresAt: new Date(30_000).toISOString(),
        },
        observedAt: 900,
      },
    ],
    decoded: 2 + advance,
    draws: 2 + advance,
    receipts: 2 + advance,
    bytes: 100 + advance * 100,
  })),
});
// Fault controls mutate local observations; production samples remain read-only.
type MutableViewerSample = { -readonly [K in keyof PrivateViewerSample]: PrivateViewerSample[K] };
const samples = (at = 2000, inputGeneration = 1): MutableViewerSample[] =>
  Array.from({ length: 9 }, (_, n) => at + n * 1000).flatMap((time) =>
    ready().subjects.map((s) => ({
      at: time,
      binding: { ...s.drawn.binding, inputGeneration },
      viewerId: s.drawn.viewerId,
      pendingFrames: 0,
      pendingBytes: 0,
      encodingMs: 2,
      droppedFrames: 0,
      closed: false,
    }))
  );
it('retains genuine zero idle deltas and zero queues without inventing work or capacity', () => {
  const report = originalResourceViewerInterval(
    ready(),
    snapshot(1000),
    snapshot(11000),
    samples(),
    false
  );
  expect(report.elapsedMilliseconds).toBe(10000);
  expect(report.frames).toBe(0);
  expect(report.bytes).toBe(0);
  expect(report.viewers.every((v) => v.queue.maximumPendingBytes === 0)).toBe(true);
});
it('requires active decoded/drawn/receipt/wire progress for BOTH original subjects', () => {
  const before = snapshot(1000),
    after = snapshot(11000, 1);
  const report = originalResourceViewerInterval(ready(), before, after, samples(2000, 1), true);
  expect(report.frames).toBe(2);
  expect(report.bytes).toBe(200);
  // The second genuine producer did not advance; a busy first viewer cannot substitute it.
  after.viewers[1] = before.viewers[1]!;
  expect(() => originalResourceViewerInterval(ready(), before, after, samples(), true)).toThrow(
    'FRAME_COUNTERS_UNAVAILABLE'
  );
});
it('a same-browser second viewer cannot substitute the second original browser', () => {
  expect(() =>
    parseOriginalResourceReady({
      subjects: [subject('B', true), { ...subject('C', false), open: subject('B', false).open }],
    })
  ).toThrow();
});
it.each(['missing', 'closed', 'unknown encoding', 'changed viewport', 'late sample'])(
  'refuses original %s observer rather than treating it as zero',
  (caseName) => {
    const rows = samples();
    if (caseName === 'missing') rows.splice(1, 1);
    if (caseName === 'closed') rows[1] = { ...rows[1]!, closed: true };
    if (caseName === 'unknown encoding') rows[1] = { ...rows[1]!, encodingMs: null };
    if (caseName === 'changed viewport')
      rows[1] = { ...rows[1]!, binding: { ...rows[1]!.binding, viewportVersion: 1 } };
    if (caseName === 'late sample') rows[1] = { ...rows[1]!, at: 12000 };
    expect(() =>
      originalResourceViewerInterval(ready(), snapshot(1000), snapshot(11000), rows, false)
    ).toThrow('QUEUE_OBSERVER_UNAVAILABLE');
  }
);
it('reentrant viewer replacement and input counter rollback cannot qualify a window', () => {
  const before = snapshot(1000),
    after = snapshot(11000, 1);
  after.viewers[1]!.viewerId = 'X'.repeat(22);
  expect(() => originalResourceViewerInterval(ready(), before, after, samples(), true)).toThrow(
    'LEASE_UNKNOWN'
  );
  after.viewers[1]!.viewerId = before.viewers[1]!.viewerId;
  after.viewers[0]!.binding.inputGeneration = 0;
  expect(() => originalResourceViewerInterval(ready(), before, after, samples(), true)).toThrow(
    'VIEWER_CHANGED'
  );
});
it('zero duration and regressed drop counters refuse', () => {
  expect(() =>
    originalResourceViewerInterval(ready(), snapshot(1000), snapshot(1000), samples(), false)
  ).toThrow('POSITIVE_OBSERVATION_WINDOW');
  const rows = samples();
  rows[0] = { ...rows[0]!, droppedFrames: 3 };
  rows[2] = { ...rows[2]!, droppedFrames: 1 };
  expect(() =>
    originalResourceViewerInterval(ready(), snapshot(1000), snapshot(11000), rows, false)
  ).toThrow('DROP_COUNTER_REGRESSED');
});
it('Node resource roles use the actual captured CLI and both exact original generation supervisors', async () => {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: 42 });
  const manager = { pid: 42, birth: 'original-cli' },
    parent = { pid: 41, birth: 'original-parent' };
  const observe = vi.fn(async () => ({ status: 'alive' as const }));
  const bank = createOriginalProjectedResourceBank({
    parent,
    cli: child,
    identity: async () => manager,
    attributeRoot: async () => true,
    processes: { observe, descendants: async () => ({ status: 'complete', identities: [] }) },
    signal: new AbortController().signal,
    current: () => {},
    own: (work) => work,
  });
  await bank.captureCli();
  for (const [id, pid] of [
    ['B', 51],
    ['C', 61],
  ] as const) {
    const root = { pid, birth: 'root-' + id },
      supervisor = { pid: pid + 1, birth: 'supervisor-' + id };
    await bank.retainBirth({
      browserId: id.repeat(22),
      browserGeneration: 0,
      manager,
      root,
      supervisor,
      identities: [root],
      complete: true,
    });
  }
  const bindings = ready().subjects.map((s) => s.open.binding);
  expect(bank.resourceNodeIdentities(bindings)).toEqual([
    manager,
    { pid: 52, birth: 'supervisor-B' },
    { pid: 62, birth: 'supervisor-C' },
  ]);
  expect(observe).not.toHaveBeenCalled(); // Actual liveness/counters still belong to subsequent native sampling.
  expect(() =>
    bank.resourceNodeIdentities([{ ...bindings[0]!, browserGeneration: 1 }, bindings[1]!])
  ).toThrow('NODE_ROLES_REQUIRED');
});
it.each([false, undefined])(
  'first original sampling failure %s retains release and independent close joins',
  async (cause) => {
    let finish!: () => void;
    const held = new Promise<void>((yes) => {
      finish = yes;
    });
    const events: string[] = [];
    const outcome = withOriginalFrameDrain(
      async () => {
        throw cause;
      },
      async () => {
        events.push('release');
      },
      [
        async () => {
          events.push('held-entered');
          await held;
          events.push('held-joined');
        },
        async () => {
          events.push('other-close');
          throw new Error('later close');
        },
      ]
    );
    void outcome.catch(() => {});
    await vi.waitFor(() => expect(events).toContain('other-close'));
    expect(events).not.toContain('held-joined');
    finish();
    await expect(outcome).rejects.toBe(cause);
    expect(events).toContain('held-joined');
  }
);

it.each([false, undefined])(
  'original CLI pipe failure %s aborts admission before a held return and later body failure',
  async (cause) => {
    const lifetime = new AbortController();
    const failure: { first?: { value: unknown } } = {};
    let rejectPipe!: (value: unknown) => void;
    let finishReturn!: () => void;
    const returned = new Promise<void>((resolve) => {
      finishReturn = resolve;
    });
    const pipe = new Promise<void>((_, reject) => {
      rejectPipe = reject;
    });
    const capture = (value: unknown) => {
      failure.first ??= { value };
      lifetime.abort(failure.first.value);
    };
    const originalPipe = retainOriginalResourceJob(pipe, capture);
    const originalReturn = retainOriginalResourceJob(returned, capture);
    expect(originalPipe).toBe(pipe);
    expect(originalReturn).toBe(returned);
    rejectPipe(cause);
    await Promise.resolve();
    expect(failure.first?.value).toBe(cause);
    expect(lifetime.signal.aborted).toBe(true);
    capture(new Error('later body failure'));
    let closed = false;
    const close = withOriginalFrameDrain(
      async () => {
        if (failure.first) throw failure.first.value;
      },
      async () => {},
      [
        async () => {
          await originalReturn;
          closed = true;
        },
      ]
    );
    void close.catch(() => {});
    await Promise.resolve();
    expect(closed).toBe(false);
    finishReturn();
    await expect(close).rejects.toBe(cause);
    expect(closed).toBe(true);
    await expect(originalPipe).rejects.toBe(cause);
  }
);

it('qualifies actual same-page natural renewal and retains each original lease drop counter separately', () => {
  const before = snapshot(1000),
    after = snapshot(11000, 1);
  const old = before.viewers[0]!;
  old.leases[0]!.viewer.expiresAt = new Date(6000).toISOString();
  after.viewers[0]!.leases[0] = { ...old.leases[0]!, viewer: { ...old.leases[0]!.viewer } };
  const successor = {
    viewer: {
      viewerId: 'X'.repeat(22),
      binding: { ...old.binding },
      expiresAt: new Date(35000).toISOString(),
    },
    observedAt: 5100,
  };
  after.viewers[0]!.leases.push(successor);
  after.viewers[0]!.viewerId = successor.viewer.viewerId;
  const rows = samples();
  for (const row of rows.filter((row) => row.viewerId === old.viewerId)) {
    row.droppedFrames =
      row.at < 5000 ? Math.floor(row.at / 1000) : Math.floor((row.at - 5000) / 1000);
    if (row.at >= 5000) row.viewerId = successor.viewer.viewerId;
  }
  const report = originalResourceViewerInterval(ready(), before, after, rows, true);
  expect(report.viewers[0]!.queue.perLease.filter((lease) => lease.observed)).toHaveLength(2);
  expect(report.viewers[0]!.queue.droppedFramesDelta).toBe(7);
  expect(report.frames).toBe(2);
});
it.each([
  'unknown viewer',
  'scope substitution',
  'lineage removal',
  'lease gap',
  'same-lease drop rollback',
])('refuses %s across renewal rather than joining unrelated telemetry', (fault) => {
  const before = snapshot(1000),
    after = snapshot(11000, 1),
    rows = samples();
  if (fault === 'unknown viewer') after.viewers[0]!.viewerId = 'X'.repeat(22);
  if (fault === 'scope substitution')
    after.viewers[0]!.leases[0]!.viewer.binding.tabId = 'X'.repeat(22);
  if (fault === 'lineage removal') after.viewers[0]!.leases[0]!.viewer.viewerId = 'X'.repeat(22);
  if (fault === 'lease gap') {
    before.viewers[0]!.leases[0]!.viewer.expiresAt = new Date(500).toISOString();
    after.viewers[0]!.leases[0]!.viewer.expiresAt = new Date(500).toISOString();
  }
  if (fault === 'same-lease drop rollback') {
    rows[0]!.droppedFrames = 10;
    rows[2]!.droppedFrames = 0;
  }
  expect(() => originalResourceViewerInterval(ready(), before, after, rows, true)).toThrow();
});
