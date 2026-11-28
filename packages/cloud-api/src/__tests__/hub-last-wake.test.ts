/**
 * Why a hub was woken: the read a hub makes once it is serving, so it can
 * audit the wake.
 *
 * The rules pinned here are the ones a later change could widen quietly: the
 * cause is a closed list matching what wakes a hub; a wake pass's cause names
 * its holder and reason and never carries the pass; nothing in the answer is a
 * credential; a cause a release does not know still leaves the wake to audit;
 * and a hub never woken reads `null`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  HubLastWakeResponseSchema,
  HubWakeCauseSchema,
  ONE_TIME_CREDENTIAL_META,
  V1_ROUTES,
  WakePassMintResponseSchema,
} from '../index.js';
import { walk } from './schema-walk.js';

const fixturesRoot = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'v1');

/** Read one fixture as a plain object. */
function fixture(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixturesRoot, rel), 'utf8')) as Record<string, unknown>;
}

describe('why a hub was woken', () => {
  it('reads the space and the reason when a space`s pass woke it', () => {
    const { lastWake } = HubLastWakeResponseSchema.parse(fixture('hubs/last-wake-pass.json'));
    expect(lastWake?.cause).toEqual({
      kind: 'wake_pass',
      passId: 'wp_0001',
      holder: {
        kind: 'space',
        spaceUrl: 'https://spaces.example.invalid/c/3b2a1c0d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
      },
      reason: 'mention',
    });
    expect(lastWake?.id).toBe('wk_0002');
  });

  it('reads its own next wake when that woke it, and null before any wake', () => {
    const woken = HubLastWakeResponseSchema.parse(fixture('hubs/last-wake-next-wake.json'));
    expect(woken.lastWake?.cause).toEqual({ kind: 'next_wake' });
    const never = HubLastWakeResponseSchema.parse(fixture('hubs/last-wake-none.json'));
    expect(never.lastWake).toBeNull();
  });

  it('names exactly the causes in the list of what wakes a hub, and nothing else', () => {
    // hub-wake.ts lists six things; its owner and its agents both arrive
    // through the front door, which never reads what a request asks for.
    const kinds = HubWakeCauseSchema.options.map((option) => option.shape.kind.value);
    expect(kinds.sort()).toEqual(
      ['computer', 'content_host', 'front_door', 'next_wake', 'wake_pass'].sort()
    );
    expect(HubWakeCauseSchema.safeParse({ kind: 'admin' }).success).toBe(false);
  });

  it('reads a cause its release does not know as unrecognised, and keeps the wake to audit', () => {
    const body = fixture('hubs/last-wake-next-wake.json');
    const lastWake = body.lastWake as Record<string, unknown>;
    const later = HubLastWakeResponseSchema.parse({
      lastWake: { ...lastWake, cause: { kind: 'a_later_cause', extra: 1 } },
    });
    expect(later.lastWake).toEqual({
      id: 'wk_0001',
      at: '2026-12-02T09:00:00Z',
      cause: { kind: 'unrecognised' },
    });
    // A known kind that is malformed is refused, not passed off as unknown.
    const broken = { ...lastWake, cause: { kind: 'wake_pass', reason: 'mention' } };
    expect(HubLastWakeResponseSchema.safeParse({ lastWake: broken }).success).toBe(false);
  });

  it('never carries the pass, even when a body sends it', () => {
    const pass = fixture('hubs/wake-pass-mint.json').pass;
    expect(typeof pass === 'string' && pass.length > 0).toBe(true);
    const body = fixture('hubs/last-wake-pass.json');
    const lastWake = body.lastWake as Record<string, unknown>;
    const withPass = {
      lastWake: { ...lastWake, cause: { ...(lastWake.cause as object), pass } },
    };
    const parsed = HubLastWakeResponseSchema.parse(withPass);
    expect(JSON.stringify(parsed)).not.toContain(String(pass));

    const passCause = HubWakeCauseSchema.options.find(
      (option) => option.shape.kind.value === 'wake_pass'
    );
    expect(Object.keys(passCause?.shape ?? {}).sort()).toEqual(
      ['holder', 'kind', 'passId', 'reason'].sort()
    );
  });

  it('marks nothing as a credential, where the mint answer does', () => {
    const marked = (schema: z.ZodType, name: string) =>
      walk(schema, name).filter(({ node }) => {
        const meta = z.globalRegistry.get(node) as Record<string, unknown> | undefined;
        return meta?.[ONE_TIME_CREDENTIAL_META] === true;
      });
    expect(marked(HubLastWakeResponseSchema, 'HubLastWakeResponseSchema')).toEqual([]);
    // The same walk finds the mint answer's pass, so an empty list above means something.
    expect(marked(WakePassMintResponseSchema, 'WakePassMintResponseSchema')).toHaveLength(1);
  });

  it('is read at the hub`s own path', () => {
    expect(V1_ROUTES.hubLastWake).toBe('/v1/hubs/self/last-wake');
  });
});
