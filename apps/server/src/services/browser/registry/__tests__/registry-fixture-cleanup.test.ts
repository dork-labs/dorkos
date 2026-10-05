import { describe, expect, it } from 'vitest';
import { ownRegistryFixtureCleanup } from './registry-fixture-cleanup.js';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('original registry fixture cleanup custody', () => {
  it('retains a late original after an earlier known finish instead of reopening custody', async () => {
    const custody = ownRegistryFixtureCleanup(),
      late = deferred();
    let calls = 0;
    const first = custody.finish();
    expect(await first).toMatchObject({ held: false, pending: 0 });
    custody.adopt({}, () => {
      calls++;
      return late.promise;
    });
    await Promise.resolve();
    expect(custody.snapshot()).toMatchObject({ held: true, pending: 1 });
    late.resolve();
    await late.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(custody.snapshot()).toMatchObject({ held: true, pending: 0 });
    expect(custody.finish()).toBe(first);
    expect(calls).toBe(1);
  });
  it('enters every peer independently and uses the same finish and raw close once', async () => {
    const custody = ownRegistryFixtureCleanup(),
      held = deferred(),
      started: string[] = [];
    custody.adopt({}, () => {
      started.push('held');
      return held.promise;
    });
    custody.adopt({}, async () => {
      started.push('healthy');
    });
    const first = custody.finish(1000);
    expect(custody.finish(1)).toBe(first);
    await Promise.resolve();
    expect(started).toEqual(['held', 'healthy']);
    held.resolve();
    expect(await first).toMatchObject({ held: false, pending: 0, resources: 2 });
    expect(started).toHaveLength(2);
  });
  it('retains timeout uncertainty after the original raw close later returns', async () => {
    const custody = ownRegistryFixtureCleanup(),
      original = {},
      close = deferred();
    let calls = 0;
    custody.adopt(original, () => {
      calls++;
      return close.promise;
    });
    const first = custody.finish(10);
    const result = await first;
    expect(result).toMatchObject({ held: true, failed: true, pending: 1 });
    expect(custody.finish()).toBe(first);
    custody.adopt(original, async () => {
      throw new Error('REPLACEMENT_MUST_NOT_RUN');
    });
    close.resolve();
    await close.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(custody.snapshot()).toMatchObject({ held: true, pending: 0 });
    expect(calls).toBe(1);
  });
  it('enters a late delivered original during finalization rather than discarding it', async () => {
    const custody = ownRegistryFixtureCleanup(),
      original = deferred(),
      late = deferred();
    let lateCalls = 0;
    custody.adopt({}, () => original.promise);
    const finish = custody.finish(10);
    custody.adopt({}, () => {
      lateCalls++;
      return late.promise;
    });
    await Promise.resolve();
    expect(lateCalls).toBe(1);
    expect(await finish).toMatchObject({ held: true, pending: 2 });
    original.resolve();
    late.resolve();
    await Promise.all([original.promise, late.promise]);
    expect(custody.snapshot().held).toBe(true);
  });
  it('preserves the first peer failure, including undefined, while attempting healthy cleanup', async () => {
    const custody = ownRegistryFixtureCleanup();
    let healthy = 0;
    custody.adopt({}, async () => {
      throw undefined;
    });
    custody.adopt({}, async () => {
      throw new Error('SECONDARY_FAILURE');
    });
    custody.adopt({}, async () => {
      healthy++;
    });
    const result = await custody.finish();
    expect(result).toMatchObject({ failed: true, held: true, pending: 0 });
    expect(result.first).toBeUndefined();
    expect(healthy).toBe(1);
  });
});
