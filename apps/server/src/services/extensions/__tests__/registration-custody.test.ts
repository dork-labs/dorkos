import { describe, expect, it, vi } from 'vitest';
import { RegistrationCustody } from '../server-lifecycle/registration-custody.js';

describe('original registration cleanup custody', () => {
  it('joins held original cleanup before permitting a healthy replacement', async () => {
    const bank = new RegistrationCustody();
    const occurrence = bank.begin('owned');
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleanup = vi.fn(() => held);
    let settled = false;
    const closing = occurrence.retire([cleanup]);
    void closing.then(() => {
      settled = true;
    });
    try {
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(bank.permits('owned')).toBe(false);
      expect(occurrence.retire([cleanup])).toBe(closing);
      expect(cleanup).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await closing;
    }
    expect(bank.permits('owned')).toBe(true);
  });

  it.each([false, undefined])(
    'joins a held sibling and retains the exact first thrown %s',
    async (cause) => {
      const bank = new RegistrationCustody();
      const occurrence = bank.begin('owned');
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first = vi.fn(() => {
        throw cause;
      });
      const second = vi.fn(() => held);
      const third = vi.fn(() => {
        throw new Error('later cleanup');
      });
      const closing = occurrence.retire([first, second, third]);
      let observed = false;
      const result = closing.then(
        () => {
          throw new Error('unexpected success');
        },
        (value) => {
          observed = true;
          return { value };
        }
      );
      try {
        await Promise.resolve();
        expect(observed).toBe(false);
        expect(second).toHaveBeenCalledTimes(1);
        expect(third).toHaveBeenCalledTimes(1);
        expect(bank.permits('owned')).toBe(false);
        expect(bank.permits('foreign')).toBe(true);
        expect(() => bank.begin('owned')).toThrow('cleanup is unverified');
      } finally {
        release();
        await result;
      }
      expect((await result).value).toBe(cause);
      await expect(occurrence.retire([first, second, third])).rejects.toBe(cause);
      expect(first).toHaveBeenCalledTimes(1);
    }
  );

  it('late successful receipt does not heal a timed-out original registrar', async () => {
    const bank = new RegistrationCustody();
    const occurrence = bank.begin('owned');
    occurrence.unknown();
    await occurrence.retire([]);
    const cleanup = vi.fn();
    await occurrence.late(cleanup);
    await occurrence.late(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(bank.permits('owned')).toBe(false);
  });

  it('an unexpected late held receipt cannot reopen a previously released occurrence', async () => {
    const bank = new RegistrationCustody();
    const occurrence = bank.begin('owned');
    await occurrence.retire([]);
    expect(bank.permits('owned')).toBe(true);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleanup = vi.fn(() => held);
    const late = occurrence.late(cleanup);
    try {
      expect(bank.permits('owned')).toBe(false);
      expect(() => bank.begin('owned')).toThrow('cleanup is unverified');
    } finally {
      release();
      await late;
    }
    expect(bank.permits('owned')).toBe(false);
  });

  it('joins an already-entered late cleanup while original disposal remains held', async () => {
    const bank = new RegistrationCustody();
    const occurrence = bank.begin('owned');
    occurrence.unknown();
    let releaseDisposal!: () => void;
    let releaseLate!: () => void;
    const disposal = new Promise<void>((resolve) => {
      releaseDisposal = resolve;
    });
    const lateReturn = new Promise<void>((resolve) => {
      releaseLate = resolve;
    });
    const closing = occurrence.retire([() => disposal]);
    const late = occurrence.late(() => lateReturn);
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    try {
      releaseDisposal();
      await disposal;
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(bank.permits('owned')).toBe(false);
    } finally {
      releaseDisposal();
      releaseLate();
      await Promise.all([closing, late]);
    }
    expect(bank.permits('owned')).toBe(false);
  });

  it('reserves retirement before a cleanup reenters and observes the same original', async () => {
    const bank = new RegistrationCustody();
    const occurrence = bank.begin('owned');
    let nested: Promise<void> | undefined;
    const cleanup = vi.fn(() => {
      nested = occurrence.retire([]);
    });
    const closing = occurrence.retire([cleanup]);
    expect(nested).toBe(closing);
    await closing;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
