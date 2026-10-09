import { expect, it, vi } from 'vitest';
import { createOriginalSelectionPhaseObserver } from '../selection-phase.js';

it('does not publish settlement before the exact original held producer returns', async () => {
  const rows: string[] = [];
  const observer = createOriginalSelectionPhaseObserver(
    () => 10,
    (row) => {
      rows.push(row);
    }
  );
  let release!: (value: object) => void;
  const result = {};
  const original = new Promise<object>((resolve) => {
    release = resolve;
  });
  const producer = vi.fn(() => original);
  const work = observer.observe('read', producer);
  void work.catch(() => undefined);
  try {
    expect(producer).toHaveBeenCalledTimes(1);
    expect(rows.map((row) => JSON.parse(row).state)).toEqual(['start']);
    release(result);
    expect(await work).toBe(result);
    expect(rows.map((row) => JSON.parse(row))).toEqual([
      { kind: 'browser-selection-phase', phase: 'read', state: 'start', elapsedMilliseconds: 0 },
      { kind: 'browser-selection-phase', phase: 'read', state: 'settled', elapsedMilliseconds: 0 },
    ]);
  } finally {
    release(result);
    await Promise.allSettled([work]);
  }
});
it.each([false, undefined])(
  'preserves exact original rejection %s when the diagnostic sink throws',
  async (cause) => {
    const sink = vi.fn(() => {
      throw new Error('diagnostic only');
    });
    const observer = createOriginalSelectionPhaseObserver(() => 10, sink);
    const producer = vi.fn(async () => {
      throw cause;
    });
    await expect(observer.observe('world', producer)).rejects.toBe(cause);
    expect(producer).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledTimes(2);
  }
);
it.each([false, undefined])(
  'enters the original producer once even when the diagnostic clock throws %s',
  async (cause) => {
    const sink = vi.fn();
    const observer = createOriginalSelectionPhaseObserver(() => {
      throw cause;
    }, sink);
    const producer = vi.fn(async () => {
      throw cause;
    });
    await expect(observer.observe('initial-tree', producer)).rejects.toBe(cause);
    expect(producer).toHaveBeenCalledTimes(1);
    expect(sink).not.toHaveBeenCalled();
  }
);
it('observes a close completion at most once and never emits original failure contents', () => {
  const rows: string[] = [];
  const observer = createOriginalSelectionPhaseObserver(
    () => 10,
    (row) => {
      rows.push(row);
    }
  );
  const finish = observer.begin('detach');
  finish('failed');
  finish('settled');
  expect(rows.map((row) => Object.keys(JSON.parse(row)).sort())).toEqual([
    ['elapsedMilliseconds', 'kind', 'phase', 'state'],
    ['elapsedMilliseconds', 'kind', 'phase', 'state'],
  ]);
  expect(rows.map((row) => JSON.parse(row).state)).toEqual(['start', 'failed']);
});
