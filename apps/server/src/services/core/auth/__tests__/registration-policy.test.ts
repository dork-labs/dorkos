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
      name: 'an account exists, from this computer',
      in: facts({ hasUsers: true }),
      mode: 'closed',
    },
    {
      name: 'an account exists on a hub, even for provisioning',
      in: facts({ hasUsers: true, role: 'hub', caller: 'provisioning' }),
      mode: 'closed',
    },
    {
      name: 'an account exists, from another device',
      in: facts({ hasUsers: true, caller: OTHER_DEVICE }),
      mode: 'closed',
    },
    {
      name: 'a hub with no account, a local-looking request',
      in: facts({ role: 'hub', caller: THIS_COMPUTER }),
      mode: 'provisioned',
    },
    {
      name: 'a hub with no account, its own request',
      in: facts({ role: 'hub', caller: HUB }),
      mode: 'provisioned',
    },
    {
      name: 'a hub with no account, provisioning',
      in: facts({ role: 'hub', caller: 'provisioning' }),
      mode: 'provisioned',
    },
    { name: 'provisioning on a computer', in: facts({ caller: 'provisioning' }), mode: 'closed' },
    { name: 'no account, this computer', in: facts({}), mode: 'local-open' },
    {
      name: 'no account, code in this process',
      in: facts({ caller: 'in-process' }),
      mode: 'local-open',
    },
    { name: 'no account, the session relay', in: facts({ caller: RELAYED }), mode: 'closed' },
    {
      name: 'no account, a hub-kind request on a computer',
      in: facts({ caller: HUB }),
      mode: 'closed',
    },
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
  // Purpose: F0 keeps today's behavior. `closed` refuses; `setup-code` still
  // allows until F5 (DOR-2968) checks the code; `provisioned` allows hub
  // provisioning and nothing else.
  it('allows local-open and setup-code, provisioning on a hub, and refuses the rest', () => {
    expect(registrationAllowed('local-open', THIS_COMPUTER)).toBe(true);
    expect(registrationAllowed('setup-code', OTHER_DEVICE)).toBe(true);
    expect(registrationAllowed('closed', THIS_COMPUTER)).toBe(false);
    expect(registrationAllowed('provisioned', 'provisioning')).toBe(true);
    expect(registrationAllowed('provisioned', 'in-process')).toBe(false);
    expect(registrationAllowed('provisioned', THIS_COMPUTER)).toBe(false);
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
