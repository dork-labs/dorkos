/**
 * What a capability handler learns about the HTTP request it was called on
 * (`context.request`, DOR-4978): the derived answers its owner and person
 * checks need, and never a header, so a cookie or a key cannot reach it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MiddlewareHandler } from 'hono';
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
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import type { ApiEnv } from '../../http/api-chain.js';

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
      'clearsAgentBar',
      'frontDoorElsewhere',
      'frontDoorOwner',
      'heldWifiOwner',
      'ownerOrNoAccount',
      'ownerProven',
      'personOnRestPath',
    ]);
    const everything = JSON.stringify(seen);
    expect(everything).not.toContain('cookie-secret-value');
    expect(everything).not.toContain('authorization-secret-value');
  });
  it('takes the front-door and agent-bar answers from the server’s own gate, never a header (DOR-4978)', async () => {
    // Headers a caller could forge to claim the other place, or a session. (A forged
    // Origin or session cookie is refused before any capability runs, so neither is here.)
    const forged = {
      'X-Forwarded-For': '127.0.0.1',
      Forwarded: 'for=127.0.0.1;host=localhost',
      'X-Real-IP': '127.0.0.1',
      'X-Forwarded-Host': 'localhost',
      'X-DorkOS-Ingress': 'local',
    };
    const viaWifi: MiddlewareHandler<ApiEnv> = async (c, next) => {
      markIngress(c.env.incoming, 'wifi');
      // A Wi-Fi caller the gate asked a credential of: the owner's own sign-in.
      c.set('user', { userId: 'owner', credential: 'cookie', sessionId: 's', route: 'wifi' });
      await next();
    };
    const atThisComputer: MiddlewareHandler<ApiEnv> = async (c, next) => {
      c.set('user', { userId: 'owner', credential: 'cookie', sessionId: 's', route: 'local' });
      await next();
    };
    const answers = async (
      before?: MiddlewareHandler<ApiEnv>,
      headers: Record<string, string> = {}
    ) => {
      seen = undefined;
      const server = fixtureTarget.mount(
        honoGroupListener(capabilityGroup(probeDomain), before ? { before } : {})
      );
      const res = await request(server).get('/api/probe-echo').set(headers);
      // A forged header may get the call refused outright; it may never flip an answer.
      if (res.status !== 200) return 'refused' as const;
      const facts = seen!.request!;
      return {
        owner: facts.frontDoorOwner,
        elsewhere: facts.frontDoorElsewhere,
        agentBar: facts.clearsAgentBar,
      };
    };
    // Off this computer: forged "local" headers flip neither answer.
    const wifi = await answers(viaWifi);
    expect(wifi).toMatchObject({ owner: false, elsewhere: true });
    expect([wifi, 'refused']).toContainEqual(await answers(viaWifi, forged));
    // At this computer: forged headers change nothing either.
    const local = await answers(atThisComputer);
    expect(local).not.toBe('refused');
    expect([local, 'refused']).toContainEqual(
      await answers(atThisComputer, { ...forged, 'X-Forwarded-For': '203.0.113.7' })
    );
  });
});
