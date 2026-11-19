/** Raising or removing a space's teammate spending limit needs confirmation; lowering stays free. */
import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { ApiEnv } from '../../http/api-chain.js';
import { addTeammateSpendRoutes, type TeammateSpendPolicy } from '../community-teammate-spend.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const REF = 'remote_spend_a';
const PATH = `/api/community-connections/${REF}/teammate-spend`;

describe('teammate spending limit confirmation', () => {
  let limit: number | null = null;
  const spend: TeammateSpendPolicy = {
    summary: async () => ({
      monthlyLimitUsd: limit,
      spentUsd: 0,
      approximate: false,
      month: '2026-11',
    }),
    setLimit: async (_ref, _owner, next) => {
      limit = next;
    },
  };
  const owner = frontDoorStepUpHarness(() => {
    const routes = new Hono<ApiEnv>();
    addTeammateSpendRoutes(
      routes,
      () => 'northwind-owner',
      () => spend,
      () => false
    );
    return [{ path: '/api/community-connections', routes }];
  });
  beforeEach(() => {
    limit = 5;
  });

  it.each([
    ['raising it', 50],
    ['removing it', null],
  ] as const)('holds %s until the owner confirms', async (_label, next) => {
    const held = await owner.call('put', PATH, 'own-tunnel').send({ monthlyLimitUsd: next });
    expect(held.status).toBe(428);
    expect(limit).toBe(5);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel', true)).body.code).toBe(
      'not-your-action'
    );
    expect(limit).toBe(5);
    expect((await owner.confirm(held.body.heldActionId, 'own-tunnel')).body).toMatchObject({
      ok: true,
      status: 200,
      result: { monthlyLimitUsd: next },
    });
    expect(limit).toBe(next);
  });

  it('holds a raise at this computer too', async () => {
    const held = await owner.call('put', PATH).send({ monthlyLimitUsd: 6 });
    expect(held.status).toBe(428);
    expect(limit).toBe(5);
  });

  it.each([
    ['lowering it', 1, 5],
    ['setting a first limit', 3, null],
  ] as const)('answers %s at once', async (_label, next, before) => {
    limit = before;
    const res = await owner.call('put', PATH, 'own-tunnel').send({ monthlyLimitUsd: next });
    expect(res.status).toBe(200);
    expect(res.body.heldActionId).toBeUndefined();
    expect(limit).toBe(next);
  });
});
