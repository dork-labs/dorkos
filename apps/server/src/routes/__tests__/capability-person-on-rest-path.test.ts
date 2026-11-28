/**
 * `request.personOnRestPath` (DOR-4972): the one request fact a read asks
 * before it answers a caller as the owner. It is set only for a person's own
 * read on a capability's REST path with no program credential, and never
 * behind the person bar or on a confirmed replay. Driven behind the real
 * chain, a real owner, a real sign-in and the real step-up routes, through
 * three made-up reads.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { z } from 'zod';
import { composeRegistry } from '../../services/core/capabilities/index.js';
import { defineCapability } from '../../services/core/capabilities/capability-definition.js';
import { CONFIRM_FIRST_CAPABILITY_IDS } from '../../services/core/capabilities/declarations/narrow-declarations.js';
import type { ConfirmFirstBar } from '../../services/core/capabilities/declarations/confirm-first.js';
import { createCapabilityHttpRoutes } from '../capability-http.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

/** What each read's handler saw, in order. */
const seen: Array<boolean | undefined> = [];

/** A made-up read that records the fact. */
function probe(id: `${string}.${string}`, path: string, extra: Record<string, unknown> = {}) {
  return defineCapability({
    id,
    title: 'Made-up read',
    description: 'A made-up read that records what the mount told it about its caller.',
    tier: 'observe',
    area: null,
    areaNote: 'a made-up read',
    input: z.object({ n: z.coerce.number().default(1) }),
    output: z.object({ ok: z.literal(true) }),
    surfaces: { http: { method: 'get', path, ...(extra.http as object) } },
    ...(extra.confirmFirst ? { confirmFirst: extra.confirmFirst as never } : {}),
    invoke: async (_deps, _input, context) => {
      seen.push(context.request?.personOnRestPath);
      return { ok: true as const };
    },
  });
}

const plain = probe('testread.plain', '/api/testread/plain');
const barred = probe('testread.barred', '/api/testread/barred', {
  http: {
    audience: 'person',
    callerBar: 'person',
    personCopy: { code: 'operator_only', subject: 'made-up things', agent: 'Not for agents.' },
  },
});
const held = probe('testread.held', '/api/testread/held', {
  http: { audience: 'person' },
  confirmFirst: {
    bar: 'front-door',
    kind: 'connection.grant',
    subject: 'made-up things',
    sheet: (_deps: unknown, input: { n: number }) => ({
      target: `made-up-${input.n}`,
      reason: 'Read the made-up thing.',
      bound: input,
    }),
  },
});

// The reviewed list names the held read for this file only.
const listed = CONFIRM_FIRST_CAPABILITY_IDS as Map<string, ConfirmFirstBar>;
listed.set(held.id, 'front-door');
afterAll(() => {
  listed.delete(held.id);
});

const owner = frontDoorStepUpHarness(() => {
  const domain = { name: 'testread', capabilities: [plain, barred, held] };
  const registry = composeRegistry([domain], { logger: noopLogger });
  return [
    {
      path: '/',
      routes: createCapabilityHttpRoutes({
        registry: () => registry,
        capabilities: domain.capabilities,
      }),
    },
  ];
});

beforeEach(() => {
  seen.length = 0;
});

describe('request.personOnRestPath', () => {
  it('is set for the owner’s own read on the REST path', async () => {
    expect((await owner.call('get', '/api/testread/plain')).status).toBe(200);
    expect(seen).toEqual([true]);
  });

  it('is not set behind the person bar, though the same owner reads', async () => {
    expect((await owner.call('get', '/api/testread/barred')).status).toBe(200);
    expect(seen).toEqual([false]);
  });

  it('is not set on a confirmed replay', async () => {
    const asked = await owner.call('get', '/api/testread/held?n=2');
    expect(asked.status).toBe(428);
    expect(seen).toEqual([]);
    const confirmed = await owner.confirm(asked.body.heldActionId as string);
    expect(confirmed.body).toMatchObject({ ok: true, status: 200 });
    expect(seen).toEqual([false]);
  });
});
