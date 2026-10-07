import {
  createOriginalProxyAuthenticationDiagnostic,
  originalProxyAuthenticationCodes,
} from '../runtime/supervisor-uncertainty-diagnostic.js';
import { expect, it } from 'vitest';
import { createSupervisorUncertaintyDiagnostic } from '../runtime/supervisor-uncertainty-diagnostic.js';
import { captureOriginalSupervisorCloseDiagnostic } from '../lifecycle/supervisor-close-diagnostic.js';

it.each([false, undefined])(
  'preserves an original falsy cleanup failure despite sink failure: %s',
  async (value) => {
    const diagnostic = createSupervisorUncertaintyDiagnostic(() => {
      throw value;
    });
    const original = Promise.reject(value);
    const returned = original.catch((reason) => {
      diagnostic.note('NATIVE_DOWNLOAD_CLOSE');
      diagnostic.emit();
      throw reason;
    });
    await expect(returned).rejects.toBe(value);
    expect(diagnostic.line()).toBe('SUPERVISOR_UNCERTAIN: NATIVE_DOWNLOAD_CLOSE\n');
  }
);
it('notes data only at failure, preserves first branch, and reserves before sink reentry', () => {
  let writes = 0;
  const diagnostic = createSupervisorUncertaintyDiagnostic(() => {
    writes++;
    diagnostic.emit();
    diagnostic.note('NATIVE_FINAL_CUSTODY');
  });
  diagnostic.note('NATIVE_TREE_INCOMPLETE');
  expect(writes).toBe(0);
  diagnostic.note('NATIVE_DOWNLOAD_CLOSE');
  diagnostic.emit();
  diagnostic.emit();
  expect(writes).toBe(1);
  expect(diagnostic.line()).toContain('NATIVE_TREE_INCOMPLETE');
});
it('projects only closed uncertainty codes through the actually captured supervisor reader', () => {
  const rows: string[] = [];
  captureOriginalSupervisorCloseDiagnostic(
    {
      diagnostics: () =>
        'SUPERVISOR_UNCERTAIN: WORKER_OWNER_FALSE\nSUPERVISOR_UNCERTAIN: private unknown reason\nSUPERVISOR_UNCERTAIN: CLIENT_BASELINE_RETURN\n',
    },
    (value) => rows.push(value)
  )();
  expect(rows[0]).toContain('WORKER_OWNER_FALSE');
  expect(rows[0]).toContain('CLIENT_BASELINE_RETURN');
  expect(rows[0]).toContain('other');
  expect(rows[0]).not.toContain('private unknown');
});
it('does not emit an absent decision', () => {
  let calls = 0;
  const diagnostic = createSupervisorUncertaintyDiagnostic(() => {
    calls++;
  });
  diagnostic.emit();
  expect(diagnostic.line()).toBe('');
  expect(calls).toBe(0);
});

it.each([false, undefined])(
  'isolates journal identity sink failure %s after fixed first branch',
  (cause) => {
    const diagnostic = createSupervisorUncertaintyDiagnostic(() => {
      throw cause;
    });
    diagnostic.note('JOURNAL_IDENTITY_NATIVE_EAGAIN');
    expect(() => diagnostic.emit()).not.toThrow();
    diagnostic.note('JOURNAL_IDENTITY_TERMINAL_CONTRADICTION');
    expect(diagnostic.line()).toBe('SUPERVISOR_UNCERTAIN: JOURNAL_IDENTITY_NATIVE_EAGAIN\n');
  }
);

it.each([false, undefined])(
  'proxy diagnostic sink %s cannot replace original challenge/ACK decisions',
  (cause) => {
    const seen: string[] = [];
    const diagnostic = createOriginalProxyAuthenticationDiagnostic((line) => {
      seen.push(line);
      diagnostic.emit('PROXY_AUTH_ACK_REFUSED');
      throw cause;
    });
    for (const code of originalProxyAuthenticationCodes) diagnostic.emit(code);
    for (const code of originalProxyAuthenticationCodes) diagnostic.emit(code);
    expect(seen).toHaveLength(originalProxyAuthenticationCodes.length);
    expect(new Set(seen).size).toBe(seen.length);
    expect(Object.isFrozen(originalProxyAuthenticationCodes)).toBe(true);
  }
);
