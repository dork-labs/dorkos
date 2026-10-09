import { expect, it, vi } from 'vitest';
import {
  retainOriginalTreeDiagnostic,
  type OriginalTreeDiagnosticBank,
} from './public-native-tree-diagnostic.js';
const manager = { pid: 1, birth: 'original' };
const primary = new Error('PUBLIC_NATIVE_ORIGINAL_TREE_UNKNOWN');
const observation = (cause: unknown) => ({
  sequence: 1,
  parent: manager,
  stage: 'children',
  batch: undefined,
  cause,
});
it.each([undefined, false])(
  'preserves primary and exact original logger failure %s separately',
  (failure) => {
    const bank: OriginalTreeDiagnosticBank = {};
    const publish = vi.fn(() => {
      throw failure;
    });
    expect(
      retainOriginalTreeDiagnostic(primary, () => observation(false), manager, bank, publish)
    ).toBe(primary);
    expect(bank.primary?.cause).toBe(primary);
    expect(bank.diagnosticFailure).toHaveProperty('cause');
    expect(Object.is(bank.diagnosticFailure?.cause, failure)).toBe(true);
  }
);
it('does not enter descriptor or string conversion traps on an original participant cause', () => {
  const trap = vi.fn(() => {
    throw undefined;
  });
  const cause = new Proxy({}, { getOwnPropertyDescriptor: trap, get: trap });
  const bank: OriginalTreeDiagnosticBank = {};
  const publish = vi.fn((_bytes: string) => {});
  expect(
    retainOriginalTreeDiagnostic(primary, () => observation(cause), manager, bank, publish)
  ).toBe(primary);
  expect(trap).not.toHaveBeenCalled();
  expect(bank.diagnosticFailure).toBeUndefined();
  expect(JSON.parse(publish.mock.calls[0]![0] as string).reason).toEqual({ type: 'object' });
});
it('retains diagnostic descriptor/serialization failure without replacing the tree failure', () => {
  const failure = new Error('diagnostic descriptor failed');
  const broken = new Proxy(
    {},
    {
      get() {
        throw failure;
      },
    }
  );
  const bank: OriginalTreeDiagnosticBank = {};
  const publish = vi.fn((_bytes: string) => {});
  expect(
    retainOriginalTreeDiagnostic(
      primary,
      () => ({ ...observation(undefined), batch: broken }),
      manager,
      bank,
      publish
    )
  ).toBe(primary);
  expect(bank.diagnosticFailure?.cause).toBe(failure);
  expect(publish).not.toHaveBeenCalled();
});
it('refuses oversized original diagnostic output while retaining the original primary', () => {
  const bank: OriginalTreeDiagnosticBank = {};
  const publish = vi.fn((_bytes: string) => {});
  expect(
    retainOriginalTreeDiagnostic(
      primary,
      () => ({ ...observation(undefined), batch: 'x'.repeat(256 * 1024) }),
      manager,
      bank,
      publish
    )
  ).toBe(primary);
  expect(bank.diagnosticFailure?.cause).toEqual(
    new Error('PUBLIC_NATIVE_TREE_DIAGNOSTIC_OVERFLOW')
  );
  expect(publish).not.toHaveBeenCalled();
});
it.each([undefined, false, true])(
  'retains safe distinct original primitive %s without getters',
  (cause) => {
    const bank: OriginalTreeDiagnosticBank = {};
    const publish = vi.fn((_bytes: string) => {});
    expect(
      retainOriginalTreeDiagnostic(primary, () => observation(cause), manager, bank, publish)
    ).toBe(primary);
    expect(JSON.parse(publish.mock.calls[0]![0] as string).reason).toEqual(
      cause === undefined ? { type: 'undefined' } : { type: 'boolean', value: cause }
    );
  }
);

it.each([undefined, false])('retains original diagnostic reader failure %s separately', (cause) => {
  const bank: OriginalTreeDiagnosticBank = {};
  const publish = vi.fn((_bytes: string) => {});
  expect(
    retainOriginalTreeDiagnostic(
      primary,
      () => {
        throw cause;
      },
      manager,
      bank,
      publish
    )
  ).toBe(primary);
  expect(bank.diagnosticFailure).toHaveProperty('cause');
  expect(Object.is(bank.diagnosticFailure?.cause, cause)).toBe(true);
  expect(publish).not.toHaveBeenCalled();
});
