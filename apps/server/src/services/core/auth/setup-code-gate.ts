/**
 * The setup-code step of an owner-less sign-up from another device (F5,
 * DOR-2968). `registration-policy.ts` decides the mode; for `setup-code` the
 * sign-up hook in `./index.ts` calls {@link refuseWithoutSetupCode}.
 *
 * @module services/core/auth/setup-code-gate
 */
import { APIError } from 'better-auth/api';
import type { RequestClass } from '../../../lib/request-classifier.js';
import { logger } from '../../../lib/logger.js';
import { isContainerPortClass } from './gate-policy.js';
import type { RegistrationCaller } from './registration-policy.js';
import { checkSetupCode, currentSetupCodeAttempt, type SetupCodeRefusal } from './setup-code.js';

/** Refusal code when an owner-less sign-up from another device needs the setup code. */
export const SETUP_CODE_REQUIRED = 'SETUP_CODE_REQUIRED';

/** Refusal code when the setup code was wrong or has expired. */
export const SETUP_CODE_INVALID = 'SETUP_CODE_INVALID';

/** Refusal code when this address has tried too many wrong setup codes. */
export const SETUP_CODE_TOO_MANY_ATTEMPTS = 'SETUP_CODE_TOO_MANY_ATTEMPTS';

const REFUSALS: Record<SetupCodeRefusal, { code: string; message: string }> = {
  required: {
    code: SETUP_CODE_REQUIRED,
    message:
      'Enter the setup code. It is printed where DorkOS runs, and in the setup-code file in its data folder.',
  },
  invalid: {
    code: SETUP_CODE_INVALID,
    message: 'That setup code is wrong or has expired. Check the latest one where DorkOS runs.',
  },
  'too-many-attempts': {
    code: SETUP_CODE_TOO_MANY_ATTEMPTS,
    message:
      'Too many wrong setup codes. Wait ten minutes, or create the owner on the computer DorkOS runs on.',
  },
};

/**
 * Throw unless this owner-less sign-up from another device may go ahead: it
 * carries the current setup code, or it is a browser at a container's
 * published port, which keeps its open first sign-up for one more release
 * (ADR 261015-125850 rule 11) with a loud warning.
 *
 * @param caller - Who is signing up (an other-device request class).
 * @throws APIError FORBIDDEN with one of the `SETUP_CODE_*` codes.
 */
export function refuseWithoutSetupCode(caller: RegistrationCaller): void {
  if (typeof caller === 'object' && isContainerPortClass(caller as RequestClass)) {
    logger.warn(
      '[Auth] ⚠️ The owner account was created from another device with no setup code, ' +
        'because this container has DORKOS_ALLOW_INSECURE_BIND set and no owner yet. ' +
        'A coming release will require the setup code printed in this terminal instead.'
    );
    return;
  }
  const refusal = checkSetupCode(currentSetupCodeAttempt());
  if (refusal === null) return;
  throw new APIError('FORBIDDEN', REFUSALS[refusal]);
}
