import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ComputerStore, type ComputerRecord } from '../store.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'computer-store-')));
  roots.push(root);
  return { root, store: new ComputerStore(root) };
}

async function journal(root: string) {
  return (await readFile(join(root, 'lifecycle.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ComputerRecord & { event: string });
}

describe('ComputerStore publications', () => {
  it('retains invocation snapshots and publishes newer state last despite a delayed first guard', async () => {
    const { store, root } = await setup();
    const guard = store.guard.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstGuard = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(store, 'guard').mockImplementationOnce(async () => {
      entered();
      await waiting;
      await guard();
    });
    const record: ComputerRecord = { id: randomUUID(), generation: 1, phase: 'ready' };
    const first = store.write(record, 'first-ready');
    await firstGuard;
    record.generation = 2;
    record.phase = 'stopped';
    const second = store.write(record, 'second-stopped');
    // The caller reuses its mutable state object while both publications remain pending.
    record.generation = 99;
    record.phase = 'failed';
    release();
    await Promise.all([first, second]);
    expect(await store.read()).toEqual({ id: record.id, generation: 2, phase: 'stopped' });
    expect(
      (await journal(root)).map(({ event, generation, phase }) => ({ event, generation, phase }))
    ).toEqual([
      { event: 'first-ready', generation: 1, phase: 'ready' },
      { event: 'second-stopped', generation: 2, phase: 'stopped' },
    ]);
  });

  it('reports a failed publication while allowing an already queued newer write to succeed', async () => {
    const { store, root } = await setup();
    vi.spyOn(store, 'guard').mockRejectedValueOnce(new Error('storage refused'));
    const id = randomUUID();
    const failed = store.write({ id, generation: 1, phase: 'starting' }, 'failed-start');
    const newer = store.write({ id, generation: 2, phase: 'stopped' }, 'confirmed-stop');
    await expect(failed).rejects.toThrow('storage refused');
    await expect(newer).resolves.toBeUndefined();
    expect(await store.read()).toEqual({ id, generation: 2, phase: 'stopped' });
    expect((await journal(root)).map(({ event }) => event)).toEqual(['confirmed-stop']);
  });
});
