import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { startDarwinEngineJournal } from '../runtime/darwin-engine-journal.js';
import type { DarwinJournalDiagnostic } from '../runtime/darwin-journal-diagnostic.js';

const controls = vi.hoisted(() => ({ inspect: vi.fn(), start: vi.fn() }));
vi.mock('../runtime/darwin-process-observer.js', async (original) => ({
  ...(await original<typeof import('../runtime/darwin-process-observer.js')>()),
  createDarwinProcessObserver: () => ({ inspect: controls.inspect }),
}));
vi.mock('../runtime/darwin-journal-worker.js', () => ({
  startDarwinJournalWorker: controls.start,
  darwinMonotonicNow: () => 100,
}));
const roots: string[] = [];
const originalFinalizers = new Set<() => Promise<void>>();
afterEach(async () => {
  let first: { reason: unknown } | undefined;
  const joined = await Promise.allSettled([...originalFinalizers].map((finish) => finish()));
  originalFinalizers.clear();
  for (const result of joined)
    if (result.status === 'rejected') first ??= { reason: result.reason };
  vi.clearAllMocks();
  for (const root of roots.splice(0)) {
    try {
      await rm(root, { recursive: true, force: true });
    } catch (reason) {
      first ??= { reason };
    }
  }
  if (first) throw first.reason;
});
async function fixture() {
  const parentDirectory = await realpath(await mkdtemp(join(tmpdir(), 'engine-journal-')));
  roots.push(parentDirectory);
  controls.inspect.mockResolvedValue({
    bootSeconds: '10',
    bootMicroseconds: '0',
    processes: [
      {
        kind: 'present',
        identity: { pid: process.pid, seconds: '20', microseconds: '0' },
        zombie: false,
      },
    ],
  });
  return {
    parentDirectory,
    binding: {
      journalId: 'journal',
      browserId: 'browser',
      browserGeneration: 0,
      reservationNonce: 'nonce',
      profile: { kind: 'ephemeral' as const },
      runtimeIdentityDigest: 'a'.repeat(64),
      manager: { pid: process.pid, birth: 'darwin-bsd-start:20:0' },
    },
    workerPath: '/private/worker.js',
    artifact: { path: '/private/observer', sha256: 'b'.repeat(64) },
    duration: 1000,
    maxGap: 100,
  };
}
it('awaits enrollment and retains the same completion through stop without early release', async () => {
  let finish!: (value: 'recorded-gone') => void;
  const completion = new Promise<'recorded-gone'>((resolve) => {
    finish = resolve;
  });
  const enrollRoot = vi.fn(async () => {});
  controls.start.mockResolvedValue({
    completion,
    enrollRoot,
    endBrowser: vi.fn(async () => {}),
  });
  const adapter = await startDarwinEngineJournal(await fixture());
  const seed = controls.start.mock.calls[0][0];
  expect(seed.initial.root.kind).toBe('pending');
  expect(seed.initial.binding.bootScope.sourceIdentityDigest).toBe('b'.repeat(64));
  const root = { pid: 123, birth: 'darwin-bsd-start:21:0' };
  await adapter.attributeRoot(root);
  expect(enrollRoot).toHaveBeenCalledExactlyOnceWith(root);
  await expect(adapter.attributeRoot(root)).rejects.toThrow('JOURNAL_ROOT_REFUSED');
  const first = adapter.stop();
  expect(adapter.stop()).toBe(first);
  expect(adapter.custody().pending).toBe(true);
  finish('recorded-gone');
  expect(await first).toBe('recorded-gone');
  expect(adapter.custody()).toEqual({ pending: false, uncertain: false });
});
it('preserves failed root attribution despite later reported completion', async () => {
  let finish!: (value: 'recorded-gone') => void;
  const completion = new Promise<'recorded-gone'>((resolve) => {
    finish = resolve;
  });
  controls.start.mockResolvedValue({
    completion,
    enrollRoot: vi.fn(async () => {
      throw new Error('IPC failed');
    }),
    endBrowser: vi.fn(async () => {}),
  });
  const adapter = await startDarwinEngineJournal(await fixture());
  await expect(adapter.attributeRoot({ pid: 123, birth: 'root' })).rejects.toThrow('IPC failed');
  finish('recorded-gone');
  expect(await adapter.stop()).toBe('uncertain');
  expect(adapter.custody().uncertain).toBe(true);
});

it('keeps recorded gaps distinct from returned original worker custody', async () => {
  controls.start.mockResolvedValue({
    completion: Promise.resolve('campaign-closed-gapped'),
    enrollRoot: vi.fn(async () => {}),
    endBrowser: vi.fn(async () => {}),
  });
  const adapter = await startDarwinEngineJournal(await fixture());
  expect(await adapter.stop()).toBe('campaign-closed-gapped');
  expect(adapter.custody()).toEqual({ pending: false, uncertain: false });
  expect(adapter.historyGapped()).toBe(true);
});

it('captures the exact original continuous worker observation and fences its loss before completion', async () => {
  let known = true,
    finish!: (value: 'recorded-gone') => void;
  const completion = new Promise<'recorded-gone'>((yes) => {
    finish = yes;
  });
  const original = {
    completion,
    enrollRoot: vi.fn(async () => {}),
    endBrowser: vi.fn(async () => {}),
    isObservationKnown: vi.fn(() => known),
  };
  controls.start.mockResolvedValue(original);
  const adapter = await startDarwinEngineJournal({
    ...(await fixture()),
    continuous: true,
  });
  expect(controls.start.mock.calls[0][0].continuous).toBe(true);
  const captured = original.isObservationKnown;
  original.isObservationKnown = vi.fn(() => true);
  expect(adapter.custody()).toEqual({ pending: true, uncertain: false });
  known = false;
  expect(adapter.custody()).toEqual({ pending: true, uncertain: true });
  expect(captured).toHaveBeenCalledTimes(2);
  known = true;
  expect(adapter.custody().uncertain).toBe(true);
  const stopping = adapter.stop();
  let returned = false;
  void stopping.then(() => {
    returned = true;
  });
  await Promise.resolve();
  expect(returned).toBe(false);
  expect(original.endBrowser).toHaveBeenCalledExactlyOnceWith(true);
  finish('recorded-gone');
  expect(await stopping).toBe('uncertain');
});

it('retains healthy continuous settlement without consulting a closed live observation', async () => {
  let finish!: (value: 'campaign-closed') => void;
  let known = true;
  const original = {
    completion: new Promise<'campaign-closed'>((resolve) => {
      finish = resolve;
    }),
    enrollRoot: vi.fn(async () => {}),
    endBrowser: vi.fn(async () => {}),
    isObservationKnown: vi.fn(() => known),
  };
  controls.start.mockResolvedValue(original);
  const adapter = await startDarwinEngineJournal({
    ...(await fixture()),
    continuous: true,
  });
  await adapter.attributeRoot({ pid: 123, birth: 'root' });
  expect(adapter.custody()).toEqual({ pending: true, uncertain: false });
  const stopped = adapter.stop();
  known = false; // The exact original worker completed and its live IPC observation ended.
  finish('campaign-closed');
  expect(await stopped).toBe('campaign-closed');
  const reads = original.isObservationKnown.mock.calls.length;
  expect(adapter.custody()).toEqual({ pending: false, uncertain: false });
  expect(adapter.custody()).toEqual({ pending: false, uncertain: false });
  expect(original.isObservationKnown).toHaveBeenCalledTimes(reads);
});

it('retains exact refused worker diagnostic output until its original receiver settles', async () => {
  let finish!: (value: 'retained') => void;
  let release!: () => void;
  const output = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batch = {
    version: 1,
    bootSeconds: '10',
    bootMicroseconds: '0',
    parentBefore: { pid: 123, seconds: '21', microseconds: '0' },
    parentAfter: null,
    complete: false,
    processes: [],
  };
  const parent = { pid: 123, birth: 'darwin-bsd-start:21:0' };
  const raw = new TextEncoder().encode(
    JSON.stringify({ kind: 'incomplete-native-children', parent, batch }) + '\n'
  );
  const original = {
    completion: new Promise<'retained'>((resolve) => {
      finish = resolve;
    }),
    stderr: vi.fn(() => raw),
    enrollRoot: vi.fn(async () => {}),
    endBrowser: vi.fn(async () => {}),
  };
  const originals: {
    acquiring?: ReturnType<typeof fixture>;
    starting?: ReturnType<typeof startDarwinEngineJournal>;
    stopping?: ReturnType<Awaited<ReturnType<typeof startDarwinEngineJournal>>['stop']>;
    finishing?: Promise<void>;
  } = {};
  let workerFinished = false,
    receiverReleased = false,
    closed = false;
  const finishWorker = () => {
    if (!workerFinished) {
      workerFinished = true;
      finish('retained');
    }
  };
  const releaseReceiver = () => {
    if (!receiverReleased) {
      receiverReleased = true;
      release();
    }
  };
  const finalize = () => {
    closed = true;
    return (originals.finishing ??= (async () => {
      // Release independently, then join the exact captured start/stop before any root or mock restore.
      finishWorker();
      releaseReceiver();
      if (originals.acquiring) await originals.acquiring;
      if (originals.starting) {
        const originalAdapter = await originals.starting;
        originals.stopping ??= originalAdapter.stop();
        await originals.stopping;
      }
    })());
  };
  originalFinalizers.add(finalize);
  onTestFinished(finalize); // Before fixture home or adapter acquisition.
  originals.acquiring = fixture();
  const options = await originals.acquiring;
  if (closed) throw new Error('JOURNAL_DIAGNOSTIC_CONTROL_FINALIZING');
  controls.start.mockResolvedValue(original);
  const receiver = vi.fn(async (_value: DarwinJournalDiagnostic) => {
    await output;
  });
  originals.starting = startDarwinEngineJournal({
    ...options,
    onDiagnostic: receiver,
  });
  const adapter = await originals.starting;
  const captured = original.stderr;
  original.stderr = vi.fn(() => new Uint8Array());
  await adapter.attributeRoot(parent);
  const stopping = (originals.stopping = adapter.stop());
  let settled = false;
  void stopping.then(() => {
    settled = true;
  });
  finishWorker();
  await vi.waitFor(() => expect(receiver).toHaveBeenCalledOnce());
  expect(captured).toHaveBeenCalledOnce();
  expect(original.stderr).not.toHaveBeenCalled();
  expect(receiver.mock.calls[0][0]).toEqual({
    kind: 'incomplete-native-children',
    journalId: 'journal',
    parent,
    batch,
  });
  expect(adapter.custody().pending).toBe(true);
  expect(settled).toBe(false);
  releaseReceiver();
  expect(await stopping).toBe('uncertain');
  expect(adapter.custody()).toEqual({ pending: false, uncertain: true });
  expect(receiver).toHaveBeenCalledOnce();
  await finalize();
});

it('captures and joins the default original stderr sink without an injected receiver', async () => {
  let finish!: (value: 'retained') => void;
  let release!: () => void;
  const output = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batch = {
    version: 1,
    bootSeconds: '10',
    bootMicroseconds: '0',
    parentBefore: { pid: 123, seconds: '21', microseconds: '0' },
    parentAfter: null,
    complete: false,
    processes: [],
  };
  const parent = { pid: 123, birth: 'darwin-bsd-start:21:0' };
  const raw = new TextEncoder().encode(
    JSON.stringify({ kind: 'incomplete-native-children', parent, batch }) + '\n'
  );
  const original = {
    completion: new Promise<'retained'>((resolve) => {
      finish = resolve;
    }),
    stderr: vi.fn(() => raw),
    enrollRoot: vi.fn(async () => {}),
    endBrowser: vi.fn(async () => {}),
  };
  const originals: {
    acquiring?: ReturnType<typeof fixture>;
    starting?: ReturnType<typeof startDarwinEngineJournal>;
    stopping?: ReturnType<Awaited<ReturnType<typeof startDarwinEngineJournal>>['stop']>;
    finishing?: Promise<void>;
  } = {};
  let workerFinished = false,
    receiverReleased = false,
    closed = false;
  const finishWorker = () => {
    if (!workerFinished) {
      workerFinished = true;
      finish('retained');
    }
  };
  const releaseReceiver = () => {
    if (!receiverReleased) {
      receiverReleased = true;
      release();
    }
  };
  const finalize = () => {
    closed = true;
    return (originals.finishing ??= (async () => {
      // Release independently, then join the exact captured start/stop before any root or mock restore.
      finishWorker();
      releaseReceiver();
      if (originals.acquiring) await originals.acquiring;
      if (originals.starting) {
        const originalAdapter = await originals.starting;
        originals.stopping ??= originalAdapter.stop();
        await originals.stopping;
      }
    })());
  };
  originalFinalizers.add(finalize);
  onTestFinished(finalize); // Before fixture home or adapter acquisition.
  originals.acquiring = fixture();
  const options = await originals.acquiring;
  if (closed) throw new Error('JOURNAL_DIAGNOSTIC_CONTROL_FINALIZING');
  controls.start.mockResolvedValue(original);
  const originalWrite = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  const writer = vi.spyOn(process.stderr, 'write').mockImplementation(((
    bytes: unknown,
    callback: unknown
  ) => {
    if (typeof bytes !== 'string' || !bytes.startsWith('JOURNAL_ORIGINAL_CHILDREN: '))
      return originalWrite(bytes as string);
    lines.push(bytes);
    void output.then(() => (callback as (error?: unknown) => void)());
    return true;
  }) as typeof process.stderr.write);
  onTestFinished(() => {
    writer.mockRestore();
  });
  originals.starting = startDarwinEngineJournal({
    ...options,
  });
  const adapter = await originals.starting;
  const captured = original.stderr;
  original.stderr = vi.fn(() => new Uint8Array());
  await adapter.attributeRoot(parent);
  const stopping = (originals.stopping = adapter.stop());
  let settled = false;
  void stopping.then(() => {
    settled = true;
  });
  finishWorker();
  await vi.waitFor(() => expect(lines).toHaveLength(1));
  expect(captured).toHaveBeenCalledOnce();
  expect(original.stderr).not.toHaveBeenCalled();
  expect(JSON.parse(lines[0].slice('JOURNAL_ORIGINAL_CHILDREN: '.length))).toEqual({
    kind: 'incomplete-native-children',
    journalId: 'journal',
    parent,
    batch,
  });
  expect(adapter.custody().pending).toBe(true);
  expect(settled).toBe(false);
  releaseReceiver();
  expect(await stopping).toBe('uncertain');
  expect(adapter.custody()).toEqual({ pending: false, uncertain: true });
  expect(lines).toHaveLength(1);
  await finalize();
});

it('cannot upgrade refused original custody when diagnostic output itself fails with undefined', async () => {
  const parent = { pid: 123, birth: 'darwin-bsd-start:21:0' };
  const raw = new TextEncoder().encode(
    JSON.stringify({
      kind: 'incomplete-native-children',
      parent,
      batch: {
        version: 1,
        bootSeconds: '10',
        bootMicroseconds: '0',
        parentBefore: null,
        parentAfter: null,
        complete: false,
        processes: [],
      },
    }) + '\n'
  );
  controls.start.mockResolvedValue({
    completion: Promise.resolve('campaign-closed-gapped'),
    stderr: () => raw,
    enrollRoot: vi.fn(async () => {}),
    endBrowser: vi.fn(async () => {}),
  });
  const receiver = vi.fn(() => {
    throw undefined;
  });
  const adapter = await startDarwinEngineJournal({
    ...(await fixture()),
    onDiagnostic: receiver,
  });
  expect(await adapter.stop()).toBe('uncertain');
  expect(adapter.historyGapped()).toBe(true);
  expect(adapter.custody()).toEqual({ pending: false, uncertain: true });
  expect(receiver).toHaveBeenCalledOnce();
});

it('never publishes raw untyped stderr or malformed kernel metadata', async () => {
  const options = await fixture();
  const receiver = vi.fn();
  controls.start.mockResolvedValue({
    completion: Promise.resolve('retained'),
    stderr: () => new TextEncoder().encode('private arbitrary stderr\n'),
    enrollRoot: vi.fn(async () => {}),
    endBrowser: vi.fn(async () => {}),
  });
  const adapter = await startDarwinEngineJournal({
    ...options,
    onDiagnostic: receiver,
  });
  expect(await adapter.stop()).toBe('uncertain');
  expect(receiver).not.toHaveBeenCalled();
  controls.start.mockResolvedValue({
    completion: Promise.resolve('retained'),
    stderr: () =>
      new TextEncoder().encode(
        '{"kind":"incomplete-native-children","parent":{"pid":123,"birth":"root"},"batch":{"URL":"must not escape"}}\n'
      ),
    enrollRoot: vi.fn(async () => {}),
    endBrowser: vi.fn(async () => {}),
  });
  const malformed = await startDarwinEngineJournal({
    ...options,
    onDiagnostic: receiver,
  });
  expect(await malformed.stop()).toBe('uncertain');
  expect(receiver).not.toHaveBeenCalled();
});

it.each([false, true])(
  'retains the exact original pre-close join and undefined refusal (refusal=%s)',
  async (refusal) => {
    const f = await fixture();
    let release!: () => void, finish!: (value: 'recorded-gone') => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completion = new Promise<'recorded-gone'>((resolve) => {
      finish = resolve;
    });
    const prepareClose = vi.fn(async () => {
      await held;
      if (refusal) throw undefined;
    });
    controls.start.mockResolvedValue({
      completion,
      enrollRoot: vi.fn(async () => {}),
      prepareClose,
      endBrowser: vi.fn(async () => {}),
    });
    const originals: {
      starting?: ReturnType<typeof startDarwinEngineJournal>;
      cleanup?: Promise<void>;
    } = {};
    let closed = false;
    const cleanup = () => {
      closed = true;
      return (originals.cleanup ??= Promise.resolve().then(async () => {
        release();
        finish('recorded-gone');
        if (originals.starting) {
          const original = await originals.starting;
          await original.stop();
        }
      }));
    };
    originalFinalizers.add(cleanup);
    onTestFinished(cleanup);
    originals.starting = startDarwinEngineJournal(f);
    const adapter = await originals.starting;
    if (closed) throw new Error('FIXTURE_CLOSED');
    await adapter.attributeRoot({ pid: 123, birth: 'darwin-bsd-start:21:0' });
    if (closed) throw new Error('FIXTURE_CLOSED');
    const first = adapter.prepareClose();
    void first.catch(() => {});
    expect(adapter.prepareClose()).toBe(first);
    await Promise.resolve();
    expect(prepareClose).toHaveBeenCalledTimes(1);
    release();
    if (refusal) await expect(first).rejects.toBeUndefined();
    else await first;
    finish('recorded-gone');
    expect(await adapter.stop()).toBe(refusal ? 'uncertain' : 'recorded-gone');
  }
);
