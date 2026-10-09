import { BrowserLifecycleError } from '@dorkos/browser';
import { expect, it, vi } from 'vitest';
import { BrokerError } from '../../egress/broker/errors.js';
import { createBrowserNavigationRefusalDiagnostic } from '../diagnostics/navigation-refusal.js';

it('projects genuine fixed lifecycle and broker codes and only the native goto token', () => {
  const emit = vi.fn();
  const diagnostic = createBrowserNavigationRefusalDiagnostic(emit);
  const lifecycle = new BrowserLifecycleError('STALE_BINDING');
  expect(diagnostic.failure(lifecycle)).toBe(lifecycle);
  diagnostic.failure(new BrokerError('PEER_REFUSED'));
  diagnostic.failure(
    new Error(
      'page.goto: net::ERR_INVALID_AUTH_CREDENTIALS at https://secret.invalid/private\nCall log: secret'
    )
  );
  expect(emit.mock.calls.map(([row]) => [row.code, row.nativeError])).toEqual([
    ['STALE_BINDING', 'unknown'],
    ['PEER_REFUSED', 'unknown'],
    ['unknown', 'ERR_INVALID_AUTH_CREDENTIALS'],
  ]);
  expect(JSON.stringify(emit.mock.calls)).not.toMatch(/secret|private|Call log/u);
  expect(diagnostic.originalFailure()?.value).toBe(lifecycle);
});
it('does not inspect arbitrary getters or emit an unallowlisted native error', () => {
  const getter = vi.fn(() => {
    throw false;
  });
  const reason = Object.defineProperties(
    {},
    { code: { get: getter }, reason: { get: getter }, message: { get: getter } }
  );
  const emit = vi.fn();
  const diagnostic = createBrowserNavigationRefusalDiagnostic(emit);
  expect(diagnostic.failure(reason)).toBe(reason);
  diagnostic.failure(new Error('page.goto: net::ERR_SECRET_CUSTOM at https://secret.invalid/'));
  expect(getter).not.toHaveBeenCalled();
  expect(emit.mock.calls.map(([row]) => [row.code, row.nativeError, row.phase])).toEqual([
    ['unknown', 'unknown', 'unknown'],
    ['unknown', 'unknown', 'unknown'],
  ]);
});
it.each([false, undefined])(
  'keeps the original %s across descriptor and sink faults and bounded sink reentry',
  (reason) => {
    const trapped = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw reason;
        },
      }
    );
    const emit = vi.fn(
      (_row: Parameters<Parameters<typeof createBrowserNavigationRefusalDiagnostic>[0]>[0]) => {
        diagnostic.failure(trapped);
        throw new Error('sink');
      }
    );
    const diagnostic = createBrowserNavigationRefusalDiagnostic(emit);
    expect(diagnostic.failure(reason)).toBe(reason);
    expect(diagnostic.originalFailure()).toEqual({ value: reason });
    expect(emit).toHaveBeenCalledTimes(16);
    expect(emit.mock.calls.map(([row]) => row.ordinal)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1)
    );
    expect(diagnostic.failure(trapped)).toBe(trapped);
    expect(diagnostic.originalFailure()?.value).toBe(reason);
  }
);

it.each([false, undefined])(
  'isolates an actual classifier string-method throw %s before sink entry',
  (fault) => {
    const reason = new Error(
      'page.goto: net::ERR_INVALID_AUTH_CREDENTIALS at https://secret.invalid/'
    );
    const emit = vi.fn();
    const diagnostic = createBrowserNavigationRefusalDiagnostic(emit);
    const split = vi.spyOn(String.prototype, 'split').mockImplementation(() => {
      throw fault;
    });
    let returned: unknown;
    try {
      returned = diagnostic.failure(reason);
    } finally {
      split.mockRestore();
    }
    expect(returned).toBe(reason);
    expect(diagnostic.originalFailure()?.value).toBe(reason);
    expect(emit).not.toHaveBeenCalled();
    diagnostic.failure(reason);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ ordinal: 2, nativeError: 'ERR_INVALID_AUTH_CREDENTIALS' })
    );
  }
);
