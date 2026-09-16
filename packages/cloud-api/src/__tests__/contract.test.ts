/**
 * The contract-level invariants: the wire version, the shape of the route
 * table, the money rule, and the additive-within-a-major discipline.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as contract from '../index.js';
import { V1_ROUTES, v1Path } from '../routes.js';

describe('the wire version', () => {
  it('is 1, and every fixed route is served under /v1', () => {
    expect(contract.WIRE_VERSION).toBe(1);
    expect(contract.WIRE_PATH_PREFIX).toBe('/v1');
    expect(contract.WIRE_VERSION_HEADER_VALUE).toBe('1');
    for (const route of Object.values(V1_ROUTES)) {
      expect(route.startsWith('/v1/'), `${route} is not under /v1`).toBe(true);
    }
  });

  it('builds every parameterised route under /v1 too', () => {
    for (const [name, build] of Object.entries(v1Path)) {
      const built = (build as (...args: string[]) => string)('a', 'b');
      expect(built.startsWith('/v1/'), `${name} built ${built}`).toBe(true);
    }
  });

  it('percent-encodes identifiers, so an identifier cannot change the route', () => {
    expect(v1Path.seat('a/../b')).toBe('/v1/seats/a%2F..%2Fb');
    expect(v1Path.orgMember('o 1', 'm#1')).toBe('/v1/orgs/o%201/members/m%231');
  });

  it('refuses a dot segment, which percent-encoding does not neutralise', () => {
    // `encodeURIComponent('..')` is `'..'` — a dot is unreserved, so it survives
    // encoding and `new URL()` then resolves it. Unfixed,
    // `v1Path.seatRelease('..')` builds `/v1/seats/../release`, which is
    // requested as `/v1/release`, and a two-segment builder escapes `/v1`
    // entirely. Several of these identifiers come from values a caller supplies.
    expect(() => v1Path.seat('..')).toThrow(TypeError);
    expect(() => v1Path.seatRelease('..')).toThrow(TypeError);
    expect(() => v1Path.seatAddon('..', '..')).toThrow(TypeError);
    expect(() => v1Path.toolkitVersion('.')).toThrow(TypeError);
    expect(() => v1Path.orgMember('org_1', '..')).toThrow(TypeError);
    expect(() => v1Path.seat('')).toThrow(TypeError);
    // A dot inside a larger identifier is ordinary and stays allowed.
    expect(v1Path.seat('a..b')).toBe('/v1/seats/a..b');
  });

  it('never resolves a built path to a different route', () => {
    // The property the builders actually owe: resolving the built path against
    // an origin lands on the same path. Written as a loop so a builder added
    // later is covered without anybody remembering this test.
    const hostile = ['..', '.', '../..', 'a/../..', '%2e%2e'];
    for (const [name, build] of Object.entries(v1Path)) {
      for (const value of hostile) {
        let built: string;
        try {
          built = (build as (...args: string[]) => string)(value, value);
        } catch (error) {
          expect(error, `${name} threw something other than a TypeError`).toBeInstanceOf(TypeError);
          continue;
        }
        const resolved = new URL(`https://example.invalid${built}`).pathname;
        expect(resolved, `${name}(${value}) built ${built} but resolves to ${resolved}`).toBe(
          built
        );
      }
    }
  });
});

describe('money', () => {
  it('never crosses this wire as a number', () => {
    // A `z.number()` on an amount is a precision bug, not a style choice: above
    // 2^53 micro-units the value is wrong, and a float in a renderer makes it
    // wrong sooner.
    const amount = contract.MicroAmountSchema;
    expect(amount.safeParse('1250000').success).toBe(true);
    expect(amount.safeParse('-1250000').success).toBe(true);
    expect(amount.safeParse('0').success).toBe(true);
    expect(amount.safeParse(1250000).success).toBe(false);
    expect(amount.safeParse('1.25').success).toBe(false);
    expect(amount.safeParse('1e6').success).toBe(false);
    expect(amount.safeParse('007').success).toBe(false);
  });

  it('makes owedMicro required on the balance, because an interface must show it', () => {
    const withoutOwed = {
      allowance: { grantedMicro: '0', remainingMicro: '0', resetsAt: '2026-09-15T12:00:00.000Z' },
      purchased: { remainingMicro: '0' },
      heldMicro: '0',
      autoReload: { enabled: false, ceilingMicro: null },
    };
    expect(contract.BalanceSchema.safeParse(withoutOwed).success).toBe(false);
  });
});

describe('timestamps', () => {
  it('require an explicit offset, so no time on this wire is ambiguous', () => {
    expect(contract.TimestampSchema.safeParse('2026-09-15T12:00:00.000Z').success).toBe(true);
    expect(contract.TimestampSchema.safeParse('2026-09-15T12:00:00+02:00').success).toBe(true);
    expect(contract.TimestampSchema.safeParse('2026-09-15T12:00:00').success).toBe(false);
    expect(contract.TimestampSchema.safeParse('2026-09-15').success).toBe(false);
  });
});

describe('the Problem envelope', () => {
  it('is what every endpoint returns in place of its success body', () => {
    expect(contract.isProblem({ code: 'not_found', status: 404, title: 'No such thing.' })).toBe(
      true
    );
    expect(contract.isProblem({ code: 'made_up', status: 404, title: 'No such thing.' })).toBe(
      false
    );
    expect(contract.isProblem({ authenticated: false, scopes: [] })).toBe(false);
  });

  it('carries no amount, ever', () => {
    const fields = Object.keys(contract.ProblemSchema.shape);
    expect(fields.filter((field) => /micro|amount|price|cost/i.test(field))).toEqual([]);
  });
});

describe('additive within a major', () => {
  it('describes every exported schema, so a new field arrives explained', () => {
    // A contract whose types are undocumented cannot be extended safely by
    // somebody who did not write it, and `.describe()` is what reaches the
    // generated JSON Schema the control plane reads.
    const undescribed: string[] = [];
    for (const [name, value] of Object.entries(contract) as Array<[string, unknown]>) {
      if (!name.endsWith('Schema') || !(value instanceof z.ZodType)) continue;
      if (!(value as z.ZodTypeAny).description) undescribed.push(name);
    }
    expect(undescribed).toEqual([]);
  });

  it('keeps every optional field optional, which is what "additive" means in practice', () => {
    // Recorded as an executable statement of the rule rather than a check of
    // it: making an optional field required is a `/v2` change, and a reviewer
    // reading this file should find the rule written where the schemas are.
    const optionalOnStatus = contract.RemoteStatusSchema.shape;
    expect(optionalOnStatus.url.safeParse(undefined).success).toBe(true);
    expect(optionalOnStatus.reason.safeParse(undefined).success).toBe(true);
    expect(optionalOnStatus.alwaysAvailable.safeParse(undefined).success).toBe(false);
  });
});

describe('the surface', () => {
  it('covers every route group the specification names', () => {
    const paths = [
      ...Object.values(V1_ROUTES),
      ...Object.values(v1Path).map((build) => (build as (...args: string[]) => string)('a', 'b')),
    ];
    for (const group of [
      '/v1/session',
      '/v1/account',
      '/v1/device/',
      '/v1/instances',
      '/v1/connections',
      '/v1/entitlements',
      '/v1/balance',
      '/v1/usage',
      '/v1/price-list',
      '/v1/nudge',
      '/v1/checkout',
      '/v1/topup',
      '/v1/portal',
      '/v1/statement',
      '/v1/inference/',
      '/v1/orgs',
      '/v1/seats/',
      '/v1/agents/',
      '/v1/addresses',
      '/v1/invitations/',
      '/v1/remote/',
    ]) {
      expect(
        paths.some((route) => route.startsWith(group)),
        `no route under ${group}`
      ).toBe(true);
    }
  });

  it('excludes the browser-facing surfaces on purpose', () => {
    // `/api/auth/*`, the account and admin pages, and `POST /api/instances/pending`
    // are a user interface of one application rather than a machine wire, and
    // publishing them would freeze a dependency's internals into this contract.
    // The device-code pair is the one exception: it sits under `/api/auth/`
    // today but is a machine wire, so it is here.
    const paths = Object.values(V1_ROUTES) as string[];
    expect(paths.filter((route) => route.includes('/auth/'))).toEqual([]);
    expect(paths.filter((route) => route.includes('pending'))).toEqual([]);
    expect(paths).toContain('/v1/device/code');
    expect(paths).toContain('/v1/device/token');
  });
});
