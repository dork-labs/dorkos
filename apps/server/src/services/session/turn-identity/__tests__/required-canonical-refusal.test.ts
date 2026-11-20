/** Mandatory refusal is sticky for the operation, including its final observation. */
import { expect, it, vi } from 'vitest';
import { RequiredSessionIdentityError } from '../../../../lib/replay/required-session-identity-error.js';
import { createCanonicalRekey } from '../canonical-rekey.js';
import type { SseResponse } from '@dorkos/shared/agent-runtime';

it('does not turn a refused canonical adoption into a successful final response', () => {
  const refusal = new RequiredSessionIdentityError(new Error('required owner refused'));
  let canonical = 'independent-target';
  let key = 'original';
  const rekeyProjector = vi.fn(() => {
    throw refusal;
  });
  const acquireLock = vi.fn(() => true);
  const releaseLock = vi.fn();
  const link = vi.fn();
  const step = createCanonicalRekey({
    sessionId: 'original',
    clientId: 'caller',
    holder: {} as SseResponse,
    lockToken: Symbol('original-owner'),
    turnKey: () => key,
    onTurnKey: (next) => {
      key = next;
    },
    chain: { link },
    deps: { getInternalSessionId: () => canonical, rekeyProjector, acquireLock, releaseLock },
  });
  let caught: unknown;
  try {
    step();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(refusal);
  // The runtime restores its original SDK object after the refusal. Finalization
  // must still report the original mandatory refusal instead of a harmless no-op.
  canonical = 'original';
  caught = undefined;
  try {
    step();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(refusal);
  expect(key).toBe('original');
  expect(link).not.toHaveBeenCalled();
  expect(acquireLock).not.toHaveBeenCalled();
  expect(releaseLock).not.toHaveBeenCalled();
});
