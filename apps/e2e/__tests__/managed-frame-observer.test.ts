import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { retainOriginalFramePerformanceFailure } from '../fixtures/managed-frame-observer';

it.each([false, undefined])(
  'joins a held original observation before retaining first cause %s despite sink failure',
  async (value) => {
    const first = Object.freeze({ value });
    let release!: (observation: unknown) => void;
    const original = new Promise<unknown>((yes) => {
      release = yes;
    });
    const observe = vi.fn(() => original);
    const retain = vi.fn(async () => {
      throw new Error('LATER_DIAGNOSTIC_SINK');
    });
    let returned = false;
    const work = retainOriginalFramePerformanceFailure(first, observe, retain);
    void work.then(() => {
      returned = true;
    });
    const actual = Object.freeze({ inputEvents: 1, lastDrawnRevision: 0 });
    try {
      expect(observe).toHaveBeenCalledOnce();
      expect(retain).not.toHaveBeenCalled();
      expect(returned).toBe(false);
      release(actual);
      expect(await work).toBe(first);
      expect(retain).toHaveBeenCalledExactlyOnceWith(actual);
    } finally {
      release(actual);
      await work;
    }
  }
);
it.each([false, undefined])(
  'does not replace first assertion with original diagnostic producer refusal %s',
  async (value) => {
    const first = Object.freeze({ value: new Error('ORIGINAL_SAMPLE_ASSERTION') });
    const retain = vi.fn(async () => {});
    expect(
      await retainOriginalFramePerformanceFailure(
        first,
        async () => {
          throw value;
        },
        retain
      )
    ).toBe(first);
    expect(retain).not.toHaveBeenCalled();
  }
);

it.each([false, undefined])(
  'durably retains the same observation when the reporter fails with %s',
  async (cause) => {
    const root = await mkdtemp(join(tmpdir(), 'original-frame-failure-'));
    const path = join(root, 'original-frame-performance-failure.json');
    const first = Object.freeze({ value: cause });
    const observation = Object.freeze({ expectedRevision: 1, inputEvents: 1, actualDecodes: 2 });
    try {
      expect(
        await retainOriginalFramePerformanceFailure(
          first,
          async () => observation,
          () => {
            throw cause;
          },
          async (actual) => {
            await writeFile(path, JSON.stringify(actual), { flag: 'wx' });
          }
        )
      ).toBe(first);
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(observation);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
it.each([false, undefined])(
  'joins the original independent sink even when durable retention refuses with %s',
  async (cause) => {
    const first = Object.freeze({ value: new Error('ORIGINAL_PIXEL_ASSERTION') });
    const observation = Object.freeze({ expectedRevision: 1, lastDrawnRevision: 0 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const report = vi.fn(() => held);
    let returned = false;
    const work = retainOriginalFramePerformanceFailure(
      first,
      async () => observation,
      report,
      () => {
        throw cause;
      }
    );
    void work.then(() => {
      returned = true;
    });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(report).toHaveBeenCalledExactlyOnceWith(observation);
      expect(returned).toBe(false);
    } finally {
      release();
      expect(await work).toBe(first);
    }
  }
);
