/**
 * The registry's half of the account-decision bar (DOR-4978, Security's
 * conditions on `context.ownerAuthority`): only the mount's proof puts an owner
 * on the context, frozen, and only for a capability that declares the bar; a
 * declared capability with no proof is refused before anything runs, whoever
 * calls; compose refuses the bar anywhere an agent could reach it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { noopLogger } from '@dorkos/shared/logger';

import {
  composeRegistry,
  personCaller,
  trustedCaller,
  type CapabilityHandlerContext,
} from '../index.js';
import { defineCapability, type CapabilityDomain } from '../capability-definition.js';
import { accountDecisionPassed } from '../context/owner-authority.js';
import { composeCapabilityRegistryForDocs } from '../../self-description/dorkos-registry.js';
import { OWNER_BAR_CAPABILITIES } from './owner-bar-capabilities.js';

const OWNER = { kind: 'local_install', installationId: 'northwind-install' } as const;
const OWNER_ONLY =
  'Only the owner of this DorkOS can manage the connections on its DorkOS account.' as const;

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

/** Two capabilities that record the context they ran with: one behind the bar, one not. */
function world() {
  const seen: CapabilityHandlerContext[] = [];
  const barred = defineCapability({
    id: 'testbar.barred',
    title: 'Barred',
    description: 'Behind the account-decision bar.',
    tier: 'act',
    area: null,
    areaNote: 'a test',
    input: z.object({}).passthrough(),
    output: z.unknown(),
    surfaces: {
      http: {
        method: 'post',
        path: '/api/testbar/barred',
        audience: 'person',
        ownerBar: 'account-decision',
        ownerOnly: OWNER_ONLY,
      },
    },
    invoke: async (_deps, _input, context) => void seen.push(context),
  });
  const open = defineCapability({
    ...barred,
    id: 'testbar.open',
    surfaces: { http: { method: 'post', path: '/api/testbar/open', audience: 'person' } },
  });
  const domain: CapabilityDomain = { name: 'testbar', capabilities: [barred, open] };
  return { seen, registry: composeRegistry([domain], { logger: noopLogger }) };
}

describe('context.ownerAuthority', () => {
  it('is the bar’s owner, frozen, on a capability that declares the bar', async () => {
    const { seen, registry } = world();
    const owner: { kind: 'local_install'; installationId: string } = { ...OWNER };
    await registry.invoke(
      'testbar.barred',
      {},
      { ...asPerson(), accountDecision: accountDecisionPassed(owner) }
    );
    const authority = seen[0]!.ownerAuthority!;
    expect(authority).toEqual(OWNER);
    expect(Object.isFrozen(authority)).toBe(true);
    // A copy: changing what the mount resolved can't reach the handler.
    owner.installationId = 'elsewhere';
    expect(authority).toEqual(OWNER);
    expect(() => {
      (authority as { installationId: string }).installationId = 'widened';
    }).toThrow(TypeError);
  });

  it('is undefined on a capability without the bar, even beside a genuine proof', async () => {
    const { seen, registry } = world();
    await registry.invoke(
      'testbar.open',
      {},
      { ...asPerson(), accountDecision: accountDecisionPassed(OWNER) }
    );
    expect(seen[0]!.ownerAuthority).toBeUndefined();
  });

  it('fails closed: no proof, a look-alike or an input field is refused person_only, trusted or not', async () => {
    const { seen, registry } = world();
    const lookAlike = { ownerAuthority: OWNER };
    for (const context of [
      asPerson(),
      { ...asPerson(), accountDecision: lookAlike as never },
      { ...asPerson(), ownerAuthority: OWNER } as never,
      {},
    ]) {
      await expect(
        registry.invoke('testbar.barred', { ownerAuthority: OWNER }, context)
      ).rejects.toMatchObject({ payload: { code: 'PERSON_ONLY' } });
    }
    expect(seen).toHaveLength(0);
  });
});

describe('compose', () => {
  const base = world().registry.get('testbar.barred')!;
  const http = base.surfaces.http!;
  it.each([
    ['an agent audience', { http: { ...http, audience: undefined } }, {}],
    ['no owner sentence', { http: { ...http, ownerOnly: undefined } }, {}],
    ['an MCP surface', { http, mcp: { inSession: true } }, {}],
    ['a network mode', { http }, { wifi: 'person-held' }],
    ['an owner sentence with no bar', { http: { ...http, ownerBar: undefined } }, {}],
  ])('refuses the bar with %s', (_name, surfaces, extra) => {
    const capability = { ...base, ...extra, surfaces } as typeof base;
    expect(() =>
      composeRegistry([{ name: 'testbar', capabilities: [capability] }], { logger: noopLogger })
    ).toThrow(/owner/);
  });
});

describe('who declares the bar, and who mints its proof', () => {
  it('pins every capability that declares the account-decision bar', () => {
    const declared = composeCapabilityRegistryForDocs()
      .capabilities.filter((capability) => capability.surfaces.http?.ownerBar !== undefined)
      .map((capability) => capability.id);
    expect(declared).toEqual(OWNER_BAR_CAPABILITIES);
  });

  it('lets only the HTTP dispatcher mint a proof', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const minters: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (name === '__tests__' || name === 'node_modules') continue;
        if (statSync(file).isDirectory()) walk(file);
        else if (
          /\.ts$/.test(name) &&
          readFileSync(file, 'utf8').includes('accountDecisionPassed(')
        ) {
          minters.push(path.relative(src, file));
        }
      }
    };
    walk(src);
    expect(minters.sort()).toEqual([
      'routes/capability-dispatch.ts',
      'services/core/capabilities/context/owner-authority.ts',
    ]);
  });

  it('logs a refusal by its code alone', async () => {
    const { accountDecisionBar } = await import('../../../../lib/http/account-decision-bar.js');
    const { logger } = await import('../../../../lib/logger.js');
    const debug = vi.spyOn(logger, 'debug');
    const outcome = accountDecisionBar(
      {
        headers: { origin: 'https://evil.example', authorization: 'Bearer secret-token' },
        method: 'POST',
        user: undefined,
        agentIdentity: undefined,
        peerAddress: '127.0.0.1',
        ingress: 'direct',
      } as never,
      { resolveOwner: () => OWNER, loginEnabled: () => false, trustedOrigins: () => [] }
    );
    expect(outcome).toEqual({
      ok: false,
      refusal: { code: 'origin_not_allowed', which: 'foreign-origin' },
    });
    expect(debug).toHaveBeenCalledWith('[account-decision] refused', {
      code: 'origin_not_allowed',
    });
    expect(JSON.stringify(debug.mock.calls)).not.toMatch(/evil|secret-token/);
    debug.mockRestore();
  });
});
