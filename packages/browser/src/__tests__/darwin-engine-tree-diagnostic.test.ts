import { beforeEach, expect, it, vi } from 'vitest';
const receiver = vi.hoisted(() => ({ children: vi.fn(), inspect: vi.fn() }));
vi.mock('../runtime/darwin-process-observer.js', async (original) => ({
  ...(await original<typeof import('../runtime/darwin-process-observer.js')>()),
  createDarwinProcessObserver: () => receiver,
}));
import { createDarwinEngineProcesses } from '../runtime/darwin-engine-processes.js';
const parent = { pid: 41, birth: 'darwin-bsd-start:100:1' };
const child = { pid: 42, birth: 'darwin-bsd-start:100:2' };
const before = { pid: 41, seconds: '100', microseconds: '1' };
const batch = () => ({
  version: 1 as const,
  bootSeconds: '10',
  bootMicroseconds: '1',
  parentBefore: before,
  parentAfter: before,
  complete: true,
  processes: [
    {
      kind: 'present' as const,
      identity: { pid: 42, seconds: '100', microseconds: '2' },
      parentPid: 41,
      zombie: false,
    },
  ],
});
beforeEach(() => {
  receiver.children.mockReset();
  receiver.inspect.mockReset();
});
it.each([undefined, false])(
  'retains exact original children failure %s without changing unknown or retrying',
  async (cause) => {
    const native = createDarwinEngineProcesses({
      path: '/trusted/observer',
      sha256: 'a'.repeat(64),
    });
    receiver.children.mockRejectedValueOnce(cause);
    expect(await native.processes.descendants(parent, new AbortController().signal)).toEqual({
      status: 'unknown',
      identities: [],
    });
    expect(receiver.children).toHaveBeenCalledOnce();
    expect(receiver.children).toHaveBeenCalledWith(parent);
    const diagnostic = native.treeObservationFailure();
    expect(diagnostic).toMatchObject({ sequence: 1, parent, stage: 'children', batch: undefined });
    expect(diagnostic).toHaveProperty('cause');
    expect(Object.is(diagnostic?.cause, cause)).toBe(true);
    receiver.children.mockResolvedValueOnce({ ...batch(), processes: [] });
    expect(await native.processes.descendants(parent, new AbortController().signal)).toEqual({
      status: 'complete',
      identities: [parent],
    });
    expect(native.treeObservationFailure()).toBe(diagnostic);
  }
);
it('retains the ORIGINAL incomplete descendant batch and exact failed parent', async () => {
  const native = createDarwinEngineProcesses({ path: '/trusted/observer', sha256: 'a'.repeat(64) });
  const incomplete = {
    ...batch(),
    complete: false,
    parentBefore: null,
    parentAfter: null,
    processes: [{ kind: 'unknown' as const, pid: 43, error: 3 }],
  };
  receiver.children.mockResolvedValueOnce(batch()).mockResolvedValueOnce(incomplete);
  expect(await native.processes.descendants(parent, new AbortController().signal)).toEqual({
    status: 'unknown',
    identities: [],
  });
  expect(receiver.children.mock.calls).toEqual([[parent], [child]]);
  const diagnostic = native.treeObservationFailure();
  expect(diagnostic?.parent).toEqual(child);
  expect(diagnostic?.stage).toBe('completeness');
  expect(diagnostic?.batch).toBe(incomplete);
  expect(diagnostic?.cause).toBeInstanceOf(Error);
});
it('retains contradictory ORIGINAL row facts while refusing tree completeness', async () => {
  const native = createDarwinEngineProcesses({ path: '/trusted/observer', sha256: 'a'.repeat(64) });
  const contradictory = batch();
  contradictory.processes[0]!.parentPid = 99;
  receiver.children.mockResolvedValueOnce(contradictory);
  expect(await native.processes.descendants(parent, new AbortController().signal)).toEqual({
    status: 'unknown',
    identities: [],
  });
  expect(native.treeObservationFailure()?.stage).toBe('identity');
  expect(native.treeObservationFailure()?.batch).toBe(contradictory);
});
