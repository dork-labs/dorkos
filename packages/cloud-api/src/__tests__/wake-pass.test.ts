/**
 * Wake passes: a hub's pass for one holder and one reason, the front door's
 * wake that takes it, and the spacing for a space's mention.
 *
 * The rules pinned here are the ones a later change could widen quietly: the
 * wake body is the pass and the reason and nothing else; the reason is a closed
 * list of exactly `mention`; the holder is a tagged kind; the pass is marked as
 * a credential wherever it appears; and the spacing is a published constant.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  FRONT_DOOR_WAKE_PATH,
  FrontDoorWakeRequestSchema,
  HUB_NEXT_WAKE_MIN_INTERVAL_SECONDS,
  ONE_TIME_CREDENTIAL_META,
  V1_ROUTES,
  WAKE_PASS_MAX_LIFETIME_DAYS,
  WAKE_PASS_MENTION_MIN_INTERVAL_SECONDS,
  WakePassHolderSchema,
  WakePassMintRequestSchema,
  WakePassMintResponseSchema,
  WakePassReasonSchema,
  v1Path,
} from '../index.js';
import { walk } from './schema-walk.js';

const fixturesRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'v1');

/** Read one fixture as a plain object. */
function fixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixturesRoot, rel), 'utf8')) as Record<string, unknown>;
}

/** The paths in a schema whose node carries the one-time credential marker. */
function markedPaths(schema: z.ZodType, name: string): string[] {
  return walk(schema, name)
    .filter(({ node }) => {
      const meta = z.globalRegistry.get(node) as Record<string, unknown> | undefined;
      return meta?.[ONE_TIME_CREDENTIAL_META] === true;
    })
    .map(({ path: at }) => at);
}

describe('minting a wake pass', () => {
  it('asks for one holder and one reason, and answers the pass once with when it ends', () => {
    const request = WakePassMintRequestSchema.parse(fixture('hubs/wake-pass-mint-request.json'));
    expect(request.holder.kind).toBe('space');
    const minted = WakePassMintResponseSchema.parse(fixture('hubs/wake-pass-mint.json'));
    expect(minted.reason).toBe('mention');
    expect(minted.expiresAt).toBeTruthy();
  });

  it('lets the hub leave the expiry to the service', () => {
    const { expiresAt: _expiresAt, ...withoutExpiry } = fixture('hubs/wake-pass-mint-request.json');
    expect(WakePassMintRequestSchema.safeParse(withoutExpiry).success).toBe(true);
  });

  it('marks the pass as a credential in the mint and in the wake, and nowhere else', () => {
    expect(markedPaths(WakePassMintResponseSchema, 'WakePassMintResponseSchema')).toEqual([
      'WakePassMintResponseSchema.pass',
    ]);
    expect(markedPaths(FrontDoorWakeRequestSchema, 'FrontDoorWakeRequestSchema')).toEqual([
      'FrontDoorWakeRequestSchema.pass',
    ]);
    expect(markedPaths(WakePassMintRequestSchema, 'WakePassMintRequestSchema')).toEqual([]);
  });

  it('names its holder by a tagged kind, a space today, and refuses a kind it does not know', () => {
    expect(WakePassHolderSchema.options.map((option) => option.shape.kind.value)).toEqual([
      'space',
    ]);
    const request = fixture('hubs/wake-pass-mint-request.json');
    expect(
      WakePassMintRequestSchema.safeParse({
        ...request,
        holder: { kind: 'computer', spaceUrl: 'https://spaces.example.invalid/c/x' },
      }).success
    ).toBe(false);
    expect(
      WakePassMintRequestSchema.safeParse({
        ...request,
        holder: { kind: 'space', spaceUrl: 'javascript:alert(1)' },
      }).success
    ).toBe(false);
    expect(
      WakePassMintRequestSchema.safeParse({
        ...request,
        holder: { kind: 'space', spaceUrl: 'http://localhost:4242/c/x' },
      }).success
    ).toBe(false);
  });

  it('is minted and revoked on the hub`s own routes', () => {
    expect(V1_ROUTES.hubWakePasses).toBe('/v1/hubs/self/wake-passes');
    expect(v1Path.hubWakePass('wp_0001')).toBe('/v1/hubs/self/wake-passes/wp_0001');
    expect(v1Path.hubWakePass('a/b')).toBe('/v1/hubs/self/wake-passes/a%2Fb');
  });
});

describe('the front door`s wake', () => {
  it('takes the pass and the reason, and is served at the front door`s own path', () => {
    const body = FrontDoorWakeRequestSchema.parse(fixture('hubs/front-door-wake-request.json'));
    expect(body).toEqual(fixture('hubs/front-door-wake-request.json'));
    expect(FRONT_DOOR_WAKE_PATH).toBe('/_dorkos/front-door/wake');
  });

  it('refuses a body with any other field, such as text', () => {
    const body = fixture('hubs/front-door-wake-request.json');
    expect(FrontDoorWakeRequestSchema.safeParse({ ...body, text: 'hello @agent' }).success).toBe(
      false
    );
    expect(FrontDoorWakeRequestSchema.safeParse({ ...body, spaceUrl: 'x' }).success).toBe(false);
  });

  it('takes a reason of exactly mention', () => {
    expect(WakePassReasonSchema.options).toEqual(['mention']);
    const body = fixture('hubs/front-door-wake-request.json');
    expect(FrontDoorWakeRequestSchema.safeParse({ ...body, reason: 'agent_request' }).success).toBe(
      false
    );
    const { reason: _reason, ...withoutReason } = body;
    expect(FrontDoorWakeRequestSchema.safeParse(withoutReason).success).toBe(false);
  });

  it('spaces a mention pass`s wakes as a hub`s own next-wake is spaced', () => {
    expect(WAKE_PASS_MENTION_MIN_INTERVAL_SECONDS).toBe(300);
    expect(WAKE_PASS_MENTION_MIN_INTERVAL_SECONDS).toBe(HUB_NEXT_WAKE_MIN_INTERVAL_SECONDS);
  });

  it('caps a pass`s life at thirty days, and says so where a hub reads expiresAt', () => {
    expect(WAKE_PASS_MAX_LIFETIME_DAYS).toBe(30);
    const described = WakePassMintRequestSchema.shape.expiresAt.description ?? '';
    expect(described).toContain('WAKE_PASS_MAX_LIFETIME_DAYS');
  });
});
