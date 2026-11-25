/**
 * What a capability handler learns about the HTTP request it was called on
 * (`context.request`, DOR-4978): the derived answers its owner and person
 * checks need, and never a header, so a cookie or a key cannot reach it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

import { capabilityGroup } from '../../http/__tests__/capability-group.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import {
  defineCapability,
  type CapabilityDomain,
  type CapabilityHandlerContext,
} from '../../services/core/capabilities/index.js';
import { initConfigManager } from '../../services/core/config-manager.js';

const fixtureTarget = swappableServer();

// The `/api` chain's host guard and session gate read the real config: login off.
let home: string;
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'dorkos-capability-request-facts-'));
  initConfigManager(home);
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

/** The context the probe's handler last saw. */
let seen: CapabilityHandlerContext | undefined;

const probeDomain: CapabilityDomain = {
  name: 'probe',
  capabilities: [
    defineCapability({
      id: 'probe.echo',
      title: 'Echo',
      description: 'Records its context.',
      tier: 'observe',
      area: null,
      areaNote: 'a test probe',
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
      surfaces: { http: { method: 'get', path: '/api/probe-echo' } },
      invoke: async (_deps, _input, context) => {
        seen = context;
        return { ok: true as const };
      },
    }),
  ],
};

describe('context.request', () => {
  it('hands the handler derived answers, never a cookie or an Authorization value', async () => {
    const server = fixtureTarget.mount(honoGroupListener(capabilityGroup(probeDomain)));
    const res = await request(server)
      .get('/api/probe-echo')
      .set('Cookie', 'better-auth.session_token=cookie-secret-value')
      .set('Authorization', 'Bearer authorization-secret-value');
    expect(res.status).toBe(200);
    expect(seen?.request).toBeDefined();
    expect(Object.keys(seen!.request!).sort()).toEqual([
      'accountOwner',
      'atThisComputerWithoutProgramKey',
      'ownerProven',
    ]);
    const everything = JSON.stringify(seen);
    expect(everything).not.toContain('cookie-secret-value');
    expect(everything).not.toContain('authorization-secret-value');
  });
});
