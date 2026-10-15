import { describe, expect, it } from 'vitest';
import {
  currentRegistrationCaller,
  decideRegistration,
  registrationAllowed,
  withRegistrationCaller,
  type RegistrationFacts,
} from '../registration-policy.js';
import type { RequestClass } from '../../../../lib/request-classifier.js';

const THIS_COMPUTER: RequestClass = { kind: 'this-computer', route: 'local' };
const OTHER_DEVICE: RequestClass = { kind: 'other-device', route: 'network', reason: 'forwarded' };
const RELAYED: RequestClass = { kind: 'relayed', route: 'relay' };
const HUB: RequestClass = { kind: 'hub', route: 'hub' };

function facts(overrides: Partial<RegistrationFacts>): RegistrationFacts {
  return { caller: THIS_COMPUTER, hasUsers: false, role: 'computer', ...overrides };
}

describe('decideRegistration', () => {
  // Purpose: one row per rule, in its order, so a reordered rule (say, the
  // relay before the account check) changes a named row.
  it.each([
    {
      name: 'a hub, before anything else',
      in: facts({ role: 'hub', caller: THIS_COMPUTER }),
      mode: 'provisioned',
    },
    {
      name: 'a hub with no account yet, from its own request',
      in: facts({ role: 'hub', caller: HUB }),
      mode: 'provisioned',
    },
    {
      name: 'an account exists, from this computer',
      in: facts({ hasUsers: true }),
      mode: 'closed',
    },
    {
      name: 'an account exists, from another device',
      in: facts({ hasUsers: true, caller: OTHER_DEVICE }),
      mode: 'closed',
    },
    { name: 'no account, this computer', in: facts({}), mode: 'local-open' },
    {
      name: 'no account, code in this process',
      in: facts({ caller: 'in-process' }),
      mode: 'local-open',
    },
    { name: 'no account, the session relay', in: facts({ caller: RELAYED }), mode: 'closed' },
    { name: 'no account, another device', in: facts({ caller: OTHER_DEVICE }), mode: 'setup-code' },
    {
      name: 'no account, the own tunnel',
      in: facts({ caller: { kind: 'other-device', route: 'own-tunnel', reason: 'ingress' } }),
      mode: 'setup-code',
    },
  ] as const)('$name → $mode', ({ in: input, mode }) => {
    expect(decideRegistration(input)).toBe(mode);
  });
});

describe('registrationAllowed', () => {
  // Purpose: F0 keeps today's behavior. Only `closed` and `provisioned`
  // refuse; `setup-code` still allows until F5 (DOR-2968) checks the code.
  it('allows local-open and setup-code, refuses closed and provisioned', () => {
    expect(registrationAllowed('local-open')).toBe(true);
    expect(registrationAllowed('setup-code')).toBe(true);
    expect(registrationAllowed('closed')).toBe(false);
    expect(registrationAllowed('provisioned')).toBe(false);
  });
});

describe('the registration scope', () => {
  // Purpose: outside any request the caller is code in this process; inside
  // the scope it is the request, across awaits, and the scope does not leak.
  it('carries the request class across awaits, and only inside the scope', async () => {
    expect(currentRegistrationCaller()).toBe('in-process');
    const seen = await withRegistrationCaller(OTHER_DEVICE, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return currentRegistrationCaller();
    });
    expect(seen).toEqual(OTHER_DEVICE);
    expect(currentRegistrationCaller()).toBe('in-process');
  });
});
