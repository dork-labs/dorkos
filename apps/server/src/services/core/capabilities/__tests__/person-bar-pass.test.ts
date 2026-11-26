/**
 * The registry's half of the person bar (`http.callerBar: 'person'`,
 * DOR-4978, Security's conditions): only the mount's own pass lets such a
 * capability run; a person proof, a trusted marker or a look-alike does not;
 * the handler sees the pass and nothing that reads as a person's authority;
 * compose refuses the bar anywhere an agent could reach it.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';

import {
  composeRegistry,
  personCaller,
  trustedCaller,
  type CapabilityHandlerContext,
} from '../index.js';
import { defineCapability } from '../capability-definition.js';
import { personBarPassed } from '../context/owner-authority.js';

const COPY = { code: 'operator_only', subject: 'test things', agent: 'No.' } as const;

/** A person at the app with login off: the most any in-process caller can carry. */
function asPerson() {
  const request = {
    agentIdentityPresented: false,
    approvalTokenPresented: false,
    loginEnabled: () => false,
  };
  return {
    trusted: trustedCaller(request)!,
    person: personCaller({ ...request, authorizationPresented: false })!,
  };
}

const barred = defineCapability({
  id: 'testbar.person',
  title: 'Barred',
  description: 'Behind the person bar.',
  tier: 'act',
  area: null,
  areaNote: 'a test',
  input: z.object({}).passthrough(),
  output: z.unknown(),
  surfaces: {
    http: {
      method: 'post',
      path: '/api/testbar/person',
      audience: 'person',
      callerBar: 'person',
      personCopy: COPY,
    },
  },
  invoke: async () => undefined,
});

/** The capability, recording the context it ran with. */
function world() {
  const seen: CapabilityHandlerContext[] = [];
  const capability = {
    ...barred,
    invoke: async (_d: unknown, _i: unknown, c: never) => void seen.push(c),
  };
  const registry = composeRegistry(
    [{ name: 'testbar', capabilities: [capability as typeof barred] }],
    {
      logger: noopLogger,
    }
  );
  return { seen, registry };
}

describe('the person bar’s pass', () => {
  it.each(['person', 'program'] as const)(
    'reaches the handler, frozen, for a %s, and nothing that reads as a person',
    async (caller) => {
      const { seen, registry } = world();
      await registry.invoke('testbar.person', {}, { personBar: personBarPassed(caller) });
      const context = seen[0]!;
      expect(context.personBar?.caller).toBe(caller);
      expect(Object.isFrozen(context.personBar)).toBe(true);
      expect(context.ownerAuthority).toBeUndefined();
      expect(context.personRead).toBeUndefined();
      expect(context.identity).toBeUndefined();
    }
  );

  it('fails closed: a person proof, a trusted marker, a look-alike or nothing is refused', async () => {
    const { seen, registry } = world();
    for (const context of [
      {},
      asPerson(),
      { ...asPerson(), personBar: { caller: 'person' } as never },
      { personBar: JSON.parse(JSON.stringify(personBarPassed('person'))) as never },
    ]) {
      await expect(registry.invoke('testbar.person', {}, context)).rejects.toMatchObject({
        payload: { code: 'PERSON_ONLY' },
      });
    }
    expect(seen).toHaveLength(0);
  });

  it('never reaches the context of a capability without the person bar', async () => {
    const seen: CapabilityHandlerContext[] = [];
    const plain = defineCapability({
      ...barred,
      id: 'testbar.plain',
      surfaces: { http: { method: 'post', path: '/api/testbar/plain' } },
      invoke: async (_deps, _input, context) => void seen.push(context),
    });
    const registry = composeRegistry([{ name: 'testbar', capabilities: [plain] }], {
      logger: noopLogger,
    });
    await registry.invoke('testbar.plain', {}, { personBar: personBarPassed('person') });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.personBar).toBeUndefined();
  });

  it('is not a key to any other person-only capability', async () => {
    const open = defineCapability({
      ...barred,
      id: 'testbar.open',
      surfaces: { http: { method: 'post', path: '/api/testbar/open', audience: 'person' } },
    });
    const registry = composeRegistry([{ name: 'testbar', capabilities: [open] }], {
      logger: noopLogger,
    });
    await expect(
      registry.invoke('testbar.open', {}, { personBar: personBarPassed('person') })
    ).rejects.toMatchObject({ payload: { code: 'PERSON_ONLY' } });
  });
});

describe('compose', () => {
  const http = barred.surfaces.http!;
  it.each([
    [
      'no person audience (agents would see it as open)',
      { http: { ...http, audience: undefined } },
      {},
    ],
    ['no copy', { http: { ...http, personCopy: undefined } }, {}],
    ['copy with no bar', { http: { ...http, callerBar: undefined } }, {}],
    [
      'an owner sentence',
      {
        http: {
          ...http,
          ownerOnly:
            'Only the owner of this DorkOS can manage the connections on its DorkOS account.',
        },
      },
      {},
    ],
    ['an MCP surface', { http, mcp: { inSession: true } }, {}],
    ['a network mode', { http }, { wifi: 'person-held' }],
    [
      'a confirm-first hold',
      { http },
      {
        confirmFirst: {
          bar: 'front-door',
          kind: 'connection.grant',
          subject: 'x',
          sheet: () => ({}),
        },
      },
    ],
  ])('refuses the person bar with %s', (_name, surfaces, extra) => {
    const capability = { ...barred, ...extra, surfaces } as typeof barred;
    expect(() =>
      composeRegistry([{ name: 'testbar', capabilities: [capability] }], { logger: noopLogger })
    ).toThrow(/testbar\.person/);
  });

  it.each(['person-held', 'lowers-power'] as const)(
    'refuses the person bar with the %s network mode, even on a listed id',
    (wifi) => {
      const capability = { ...barred, id: 'todos.add_as_person', wifi } as typeof barred;
      expect(() =>
        composeRegistry([{ name: 'todos', capabilities: [capability] }], { logger: noopLogger })
      ).toThrow(/caller bar/);
    }
  );
});
