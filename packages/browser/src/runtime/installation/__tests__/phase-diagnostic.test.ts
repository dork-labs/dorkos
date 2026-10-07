import { describe, expect, it, vi } from 'vitest';
import { createOriginalInstallationPhaseObserver } from '../phase-diagnostic.js';

describe('original installation phase observation', () => {
  it('reports a held original producer only after its original return', async () => {
    let now = 10;
    const rows: string[] = [];
    const observer = createOriginalInstallationPhaseObserver(
      () => now,
      (row) => {
        rows.push(row);
      }
    );
    let release!: (value: object) => void;
    const original = new Promise<object>((resolve) => {
      release = resolve;
    });
    const producer = vi.fn(() => original);
    const returned = observer.observe('fresh-verifier', 'intake', producer);
    const value = Object.freeze({ original: true });
    let released = false;
    try {
      let settled = false;
      void returned.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(producer).toHaveBeenCalledTimes(1);
      expect(rows.map((row) => JSON.parse(row))).toEqual([
        {
          kind: 'browser-installation-phase',
          role: 'fresh-verifier',
          phase: 'intake',
          state: 'start',
          elapsedMilliseconds: 0,
        },
      ]);
      now = 37;
      released = true;
      release(value);
      expect(await returned).toBe(value);
      expect(JSON.parse(rows[1]!)).toEqual({
        kind: 'browser-installation-phase',
        role: 'fresh-verifier',
        phase: 'intake',
        state: 'settled',
        elapsedMilliseconds: 27,
      });
    } finally {
      if (!released) release(value);
      await returned;
    }
  });

  it.each([false, undefined])(
    'preserves original falsy rejection %s through sink failure',
    async (cause) => {
      const sink = vi.fn(() => {
        throw new Error('sink');
      });
      const observer = createOriginalInstallationPhaseObserver(() => 1, sink);
      const producer = vi.fn(() => Promise.reject(cause));
      let actual: { value: unknown } | undefined;
      try {
        await observer.observe('version-probe', 'return', producer);
      } catch (value) {
        actual = { value };
      }
      expect(actual).toEqual({ value: cause });
      expect(producer).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledTimes(2);
    }
  );

  it.each([false, undefined])(
    'preserves original synchronous throw %s through clock failure',
    async (cause) => {
      const observer = createOriginalInstallationPhaseObserver(
        () => {
          throw new Error('clock');
        },
        () => {}
      );
      const producer = vi.fn(() => {
        throw cause;
      });
      let actual: { value: unknown } | undefined;
      try {
        await observer.observe('official-install', 'prepare', producer);
      } catch (value) {
        actual = { value };
      }
      expect(actual).toEqual({ value: cause });
      expect(producer).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['clock', 'sink'] as const)(
    'preserves a successful original return when %s fails',
    async (fault) => {
      const observer = createOriginalInstallationPhaseObserver(
        () => {
          if (fault === 'clock') throw false;
          return 1;
        },
        () => {
          if (fault === 'sink') throw undefined;
        }
      );
      const value = Object.freeze({ original: true });
      const producer = vi.fn(() => Promise.resolve(value));
      expect(await observer.observe('fresh-verifier', 'prepare', producer)).toBe(value);
      expect(producer).toHaveBeenCalledTimes(1);
    }
  );

  it('does not inspect original error properties or emit secret metadata', async () => {
    const rows: string[] = [];
    const observer = createOriginalInstallationPhaseObserver(
      () => 2,
      (row) => {
        rows.push(row);
      }
    );
    const secret = new Proxy(
      {},
      {
        get() {
          throw new Error('must not read error');
        },
      }
    );
    let actual: unknown;
    try {
      await observer.observe('fresh-verifier', 'birth', () => Promise.reject(secret));
    } catch (value) {
      actual = value;
    }
    expect(actual).toBe(secret);
    expect(rows.map((row) => Object.keys(JSON.parse(row)).sort())).toEqual([
      ['elapsedMilliseconds', 'kind', 'phase', 'role', 'state'],
      ['elapsedMilliseconds', 'kind', 'phase', 'role', 'state'],
    ]);
    expect(JSON.parse(rows[1]!).state).toBe('failed');
  });

  it('publishes a terminal observation once even when the sink reenters it', () => {
    const rows: string[] = [];
    const observer = createOriginalInstallationPhaseObserver(
      () => 1,
      (row) => {
        rows.push(row);
        if (JSON.parse(row).state !== 'start') finish?.('failed');
      }
    );
    const finish = observer.begin('fresh-verifier', 'return');
    finish('settled');
    finish('failed');
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1]!).state).toBe('settled');
  });
});
