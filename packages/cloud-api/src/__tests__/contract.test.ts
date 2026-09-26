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
      '/v1/communities',
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

describe('buying credit', () => {
  it('takes a positive integer of micro-units, and nothing else', () => {
    // The same unit as every other amount on this wire, narrowed to what a
    // purchase can be made of. Zero and negative are not purchases, and a
    // number is the precision bug `MicroAmountSchema` exists to prevent.
    const request = contract.TopupRequestSchema;
    expect(request.safeParse({ amountMicro: '20000000' }).success).toBe(true);
    expect(request.safeParse({ amountMicro: '1' }).success).toBe(true);
    expect(request.safeParse({ amountMicro: '0' }).success).toBe(false);
    expect(request.safeParse({ amountMicro: '-20000000' }).success).toBe(false);
    expect(request.safeParse({ amountMicro: '020000000' }).success).toBe(false);
    expect(request.safeParse({ amountMicro: '20.5' }).success).toBe(false);
    expect(request.safeParse({ amountMicro: 20000000 }).success).toBe(false);
  });

  it('names no minimum and no ceiling, only the codes that refuse one', () => {
    // What an amount has to clear is server policy. The contract publishes the
    // refusal, never the threshold.
    expect(contract.ProblemCodeSchema.safeParse('topup_below_minimum').success).toBe(true);
    expect(contract.ProblemCodeSchema.safeParse('first_purchase_cap').success).toBe(true);
    const moneyShapes = [
      contract.TopupRequestSchema,
      contract.RefundRequestSchema,
      contract.RefundResponseSchema,
    ];
    const described = moneyShapes
      .flatMap((shape) => [
        shape.description ?? '',
        ...Object.values(shape.shape).map((field) => field.description ?? ''),
      ])
      .join(' ')
      // A standards reference is not an amount: `ISO-8601`, `RFC 2606`,
      // `base-10`. Everything else numeric in a money description would be a
      // threshold, and a threshold is server policy that is published nowhere.
      .replace(/\b(iso|rfc|utf)-?\s?\d+/gi, '')
      .replace(/base-\d+/gi, '');
    expect(described).not.toMatch(/\d/);
  });

  it('serves `/v1/topup` and `/v1/refunds` as their own routes', () => {
    expect(V1_ROUTES.topup).toBe('/v1/topup');
    expect(V1_ROUTES.refunds).toBe('/v1/refunds');
  });
});

describe('refunds', () => {
  it('asks by opaque charge identifier and carries no amount in the request', () => {
    expect(contract.RefundRequestSchema.safeParse({ chargeId: 'chg_0001' }).success).toBe(true);
    expect(contract.RefundRequestSchema.safeParse({}).success).toBe(false);
    expect(Object.keys(contract.RefundRequestSchema.shape)).toEqual(['chargeId']);
  });

  it('answers with what came back and when', () => {
    const accepted = {
      refundId: 'rfnd_0001',
      chargeId: 'chg_0001',
      refundedMicro: '20000000',
      refundedAt: '2026-09-15T12:00:00.000Z',
    };
    expect(contract.RefundResponseSchema.safeParse(accepted).success).toBe(true);
    // The amount is an exact integer of micro-units, like every other one here.
    expect(
      contract.RefundResponseSchema.safeParse({ ...accepted, refundedMicro: 20000000 }).success
    ).toBe(false);
  });

  it('refuses a late refund with its own code rather than a stand-in', () => {
    expect(contract.ProblemCodeSchema.safeParse('refund_window_closed').success).toBe(true);
  });
});

describe('the balance additions', () => {
  const minimal = {
    allowance: { grantedMicro: '0', remainingMicro: '0', resetsAt: '2026-09-15T12:00:00.000Z' },
    purchased: { remainingMicro: '0' },
    heldMicro: '0',
    owedMicro: '0',
    autoReload: { enabled: false, ceilingMicro: null },
  };

  it('leaves a balance without them valid, which is what additive means', () => {
    expect(contract.BalanceSchema.safeParse(minimal).success).toBe(true);
  });

  it('carries the hold count and the value held but not yet spendable', () => {
    const withHolds = {
      ...minimal,
      purchased: { remainingMicro: '0', holds: 1 },
      pendingMicro: '20000000',
    };
    const parsed = contract.BalanceSchema.safeParse(withHolds);
    expect(parsed.success && parsed.data.purchased.holds).toBe(1);
    expect(parsed.success && parsed.data.pendingMicro).toBe('20000000');
    // A count is a count; an amount is a micro-unit string.
    expect(contract.BalanceSchema.safeParse({ ...withHolds, pendingMicro: 20000000 }).success).toBe(
      false
    );
    expect(
      contract.BalanceSchema.safeParse({
        ...withHolds,
        purchased: { remainingMicro: '0', holds: 1.5 },
      }).success
    ).toBe(false);
  });
});

describe('charges that are not inference', () => {
  const inferenceOnly = {
    from: '2026-09-15T12:00:00.000Z',
    to: '2026-10-15T12:00:00.000Z',
    groupBy: 'seat',
    state: 'active',
    rows: [],
    totals: { listPriceMicro: '0', dorkosPriceMicro: '0' },
  };
  const storageRow = {
    periodStart: '2026-09-15T12:00:00.000Z',
    periodEnd: '2026-10-15T12:00:00.000Z',
    units: 2.5,
    unit: 'GB-month',
    displayName: 'Extra storage',
    dorkosPriceMicro: '1250000',
    costBasis: 'published_price',
  };
  const withStorage = (row: Record<string, unknown>) => ({
    ...inferenceOnly,
    storage: { rows: [row], dorkosPriceMicro: '1250000' },
  });

  it('leaves a response without them valid, which is what an older service sends', () => {
    const parsed = contract.UsageResponseSchema.safeParse(inferenceOnly);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.storage).toBeUndefined();
  });

  it('carries each billing period with the server`s own words for it', () => {
    const parsed = contract.UsageResponseSchema.safeParse(withStorage(storageRow));
    expect(parsed.success && parsed.data.storage?.rows[0]).toEqual(storageRow);
  });

  it('refuses negative units and more than three decimal places', () => {
    const units = (value: number) =>
      contract.UsageResponseSchema.safeParse(withStorage({ ...storageRow, units: value })).success;
    expect(units(0)).toBe(true);
    expect(units(12.345)).toBe(true);
    expect(units(-1)).toBe(false);
    expect(units(-0.001)).toBe(false);
    expect(units(12.3456)).toBe(false);
    expect(units(0.0001)).toBe(false);
  });

  it('carries no list price, no seat and no model, because nothing upstream is resold', () => {
    expect(Object.keys(contract.StorageUsageRowSchema.shape).sort()).toEqual([
      'costBasis',
      'displayName',
      'dorkosPriceMicro',
      'periodEnd',
      'periodStart',
      'unit',
      'units',
    ]);
    // An amount is a micro-unit string here like everywhere else.
    expect(
      contract.UsageResponseSchema.safeParse(withStorage({ ...storageRow, dorkosPriceMicro: 1.25 }))
        .success
    ).toBe(false);
  });

  it('names no unit: `unit` is any string the service sends', () => {
    // A hard-coded unit would publish something about the catalog. The app
    // renders whatever arrives.
    expect(
      contract.UsageResponseSchema.safeParse(withStorage({ ...storageRow, unit: 'a new unit' }))
        .success
    ).toBe(true);
  });
});

describe('a member`s display name', () => {
  const member = {
    id: 'mem_0001',
    orgId: 'org_0001',
    userId: 'acct_0001',
    role: 'owner',
    createdAt: '2026-09-15T12:00:00.000Z',
  };

  it('is optional, so a member without one still parses', () => {
    expect(contract.MemberSchema.safeParse(member).success).toBe(true);
    expect(contract.MemberSchema.safeParse({ ...member, displayName: 'Ada' }).success).toBe(true);
  });

  it('is a name, and the schema carries no email field for it to be confused with', () => {
    // The seat picker labels a person by their profile name. An email is not a
    // display name, and this shape has nowhere to put one.
    expect(Object.keys(contract.MemberSchema.shape)).not.toContain('email');
  });
});

describe('the seat reconciliation additions', () => {
  it('publishes the handle grammar, so a bad name is refused before a request goes out', () => {
    const handle = contract.HandleSchema;
    expect(handle.safeParse('scout').success).toBe(true);
    expect(handle.safeParse('scout-2').success).toBe(true);
    expect(handle.safeParse('sc').success).toBe(true);
    // Lower case by grammar: the routing token is compared case-sensitively
    // downstream, so a mixed-case handle would pass and then never match.
    expect(handle.safeParse('Scout').success).toBe(false);
    // The dot is removed on purpose, so a handle is a single routing token.
    expect(handle.safeParse('first.last').success).toBe(false);
    expect(handle.safeParse('-scout').success).toBe(false);
    expect(handle.safeParse('scout-').success).toBe(false);
    expect(handle.safeParse('s').success).toBe(false);
    expect(handle.safeParse('a'.repeat(33)).success).toBe(false);
  });

  it('narrows no field a caller already sends to it, because that would be /v2', () => {
    // A request that parsed before this release still parses after it. Adding
    // the grammar as an export is additive; applying it to `handle` would not be.
    expect(
      contract.AddressCreateRequestSchema.safeParse({ seatId: 'seat_0001', handle: 'First.Last' })
        .success
    ).toBe(true);
  });

  it('lets a grant list say what zero rows resolves to', () => {
    // Zero stored rows means the organization's default, not an empty
    // permission set — and `effective` is the only way an interface can show it.
    const resolved = {
      grants: [],
      effective: [{ granteeKind: 'org', capability: 'address', effect: 'allow' }],
    };
    expect(contract.GrantListResponseSchema.safeParse(resolved).success).toBe(true);
    expect(contract.GrantListResponseSchema.safeParse({ grants: [] }).success).toBe(true);
  });

  it('carries the identity material a claim needs, and keeps hashing on the server', () => {
    const claim = {
      displayName: 'Scout',
      instanceId: 'inst_0001',
      principalKind: 'workspace',
      naturalKey: 'nk_0001',
      authEnabled: false,
      hasUsers: false,
    };
    expect(contract.AgentClaimRequestSchema.safeParse(claim).success).toBe(true);
    // Optional, so an instance one release behind keeps registering.
    expect(
      contract.AgentClaimRequestSchema.safeParse({ displayName: 'Scout', instanceId: 'inst_0001' })
        .success
    ).toBe(true);
    // No hash crosses this wire: a client that could compute one could forge
    // any identity, so the raw key is sent once and discarded on receipt.
    expect(Object.keys(contract.AgentClaimRequestSchema.shape)).not.toContain('naturalKeyHash');
  });

  it('says who a new address is for, and makes accepting the exposure explicit', () => {
    const request = {
      seatId: 'seat_0001',
      handle: 'scout',
      subject: { kind: 'agent', id: 'agt_0001' },
      acknowledgeUnauthenticatedExposure: true,
    };
    expect(contract.AddressCreateRequestSchema.safeParse(request).success).toBe(true);
    // Spelled in full on purpose: a shorter name invites a default, and
    // defaulting it would be the whole problem. Absent reads as not accepted.
    expect(
      contract.AddressCreateRequestSchema.shape.acknowledgeUnauthenticatedExposure.safeParse(
        undefined
      ).success
    ).toBe(true);
  });

  it('binds the holder and issues the address in one request', () => {
    const request = { subject: { kind: 'user', id: 'acct_0001' }, handle: 'ada' };
    expect(contract.SeatAssignRequestSchema.safeParse(request).success).toBe(true);
    expect(
      contract.SeatAssignRequestSchema.safeParse({ subject: { kind: 'user', id: 'acct_0001' } })
        .success
    ).toBe(true);
  });
});

describe('the seat activity event', () => {
  const event = {
    eventId: 'sae_0001',
    orgId: 'org_0001',
    seatId: 'seat_0001',
    periodStart: '2026-08-31T00:00:00.000Z',
    periodEnd: '2026-09-30T00:00:00.000Z',
    occurredAt: '2026-09-15T12:00:00.000Z',
    reason: 'inbound-from-connected-channel',
    sourceKind: 'connected-channel',
    sourceRef: 'src_0001',
  };

  it('is exactly the nine fields a fair-billing consumer needs', () => {
    expect(contract.SeatActivityEventSchema.safeParse(event).success).toBe(true);
    expect(Object.keys(contract.SeatActivityEventSchema.shape)).toEqual([
      'eventId',
      'orgId',
      'seatId',
      'periodStart',
      'periodEnd',
      'occurredAt',
      'reason',
      'sourceKind',
      'sourceRef',
    ]);
  });

  it('carries nothing from a message, and no presence value', () => {
    // The absence is the contract. A sender, a subject or a body here would
    // make a billing feed into a mail feed, and a presence value would make it
    // a tracker.
    const fields = Object.keys(contract.SeatActivityEventSchema.shape);
    expect(
      fields.filter((field) =>
        /\b(message|subject|body|sender|email|presence)/i.test(
          field.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        )
      )
    ).toEqual([]);
  });

  it('names a period, not a month, and needs an explicit offset on both ends', () => {
    // The organization's subscription period, clamped on a short month rather
    // than rolled over — which is only meaningful if both ends are absolute.
    expect(
      contract.SeatActivityEventSchema.safeParse({ ...event, periodEnd: '2026-09-30' }).success
    ).toBe(false);
    expect(Object.keys(contract.SeatActivityEventSchema.shape)).not.toContain('month');
  });

  it('accepts every reason and source kind it publishes, and nothing else', () => {
    for (const reason of [
      'inbound-from-org-seat',
      'inbound-from-connected-channel',
      'turn-triggered-by-qualifying-message',
      'turn-triggered-by-attached-addon',
      'addon-attached',
    ]) {
      expect(contract.SeatActivityEventSchema.safeParse({ ...event, reason }).success).toBe(true);
    }
    expect(
      contract.SeatActivityEventSchema.safeParse({ ...event, reason: 'because' }).success
    ).toBe(false);
    for (const sourceKind of ['seat', 'connected-channel', 'addon']) {
      expect(contract.SeatActivityEventSchema.safeParse({ ...event, sourceKind }).success).toBe(
        true
      );
    }
    expect(
      contract.SeatActivityEventSchema.safeParse({ ...event, sourceKind: 'person' }).success
    ).toBe(false);
  });
});

describe('the inference refusal reasons', () => {
  it('keeps every reason it published before, which is what additive means', () => {
    for (const reason of [
      'balance_exhausted',
      'rate_limited',
      'concurrency_exceeded',
      'model_unavailable',
      'token_revoked',
      'token_expired',
      'entitlement_required',
    ]) {
      expect(contract.InferenceRefusalReasonSchema.safeParse(reason).success).toBe(true);
    }
  });

  it('separates a daily limit from an empty balance, because the action differs', () => {
    // `balance_exhausted` is answered by buying credit. A daily limit is
    // answered by waiting for the reset or asking an administrator to raise it,
    // and answering one with the other sends a person to a checkout page that
    // will not help them.
    expect(contract.InferenceRefusalReasonSchema.safeParse('daily_limit_reached').success).toBe(
      true
    );
    expect(contract.InferenceRefusalReasonSchema.options).toContain('balance_exhausted');
    expect(contract.InferenceRefusalReasonSchema.options).toContain('daily_limit_reached');
  });

  it('separates a spent turn budget from a busy account, for the same reason', () => {
    // `concurrency_exceeded` is answered by waiting and retrying the same work.
    // A spent turn budget is answered by ending the turn or running less at
    // once, which is a different thing to tell somebody.
    expect(contract.InferenceRefusalReasonSchema.safeParse('turn_budget_exhausted').success).toBe(
      true
    );
    expect(contract.InferenceRefusalReasonSchema.options).toContain('concurrency_exceeded');
    expect(contract.InferenceRefusalReasonSchema.options).toContain('turn_budget_exhausted');
  });

  it('refuses a reason it does not publish', () => {
    // The threshold behind each of these is server policy and is published
    // nowhere. That claim is checked where the prose actually ships — the
    // emitted doc comments — by `catalog-blindness.test.ts`, because a
    // `.describe()` is not where a threshold would ever be written down.
    expect(contract.InferenceRefusalReasonSchema.safeParse('made_up').success).toBe(false);
  });
});

describe('the remote-access additions', () => {
  const status = {
    mode: 'managed',
    state: 'open',
    address: 'example-instance.remote.invalid',
    alwaysAvailable: false,
  };

  it('publishes both windows on the status shape, and leaves them optional', () => {
    expect(contract.RemoteStatusSchema.safeParse(status).success).toBe(true);
    const withWindows = { ...status, idleWindowSeconds: 900, drainDeadlineSeconds: 30 };
    expect(contract.RemoteStatusSchema.safeParse(withWindows).success).toBe(true);
    expect(
      contract.RemoteStatusSchema.safeParse({ ...status, idleWindowSeconds: -1 }).success
    ).toBe(false);
  });

  it('publishes the same two windows on the open command, or the idle tranche reads a field nobody published', () => {
    const open = {
      kind: 'open',
      id: 'cmd_0001',
      leaseToken: 'lt_0003',
      wakeId: 'wk_0001',
      leaseId: 'lease_0001',
      address: 'example-instance.remote.invalid',
      host: 'remote.invalid',
      idleWindowSeconds: 900,
      drainDeadlineSeconds: 30,
    };
    const parsed = contract.RemoteCommandSchema.safeParse(open);
    expect(parsed.success && parsed.data.kind === 'open' && parsed.data.host).toBe(
      'remote.invalid'
    );
    // Still optional: an open command from before this release is still valid.
    expect(
      contract.RemoteCommandSchema.safeParse({
        kind: 'open',
        id: 'cmd_0001',
        leaseToken: 'lt_0003',
        wakeId: 'wk_0001',
      }).success
    ).toBe(true);
  });

  it('lets a keepalive carry the reconnect delay the stream already implies', () => {
    expect(
      contract.RemoteCommandSchema.safeParse({
        kind: 'keepalive',
        id: 'cmd_0002',
        reconnectAfterMs: 15000,
      }).success
    ).toBe(true);
    expect(
      contract.RemoteCommandSchema.safeParse({ kind: 'keepalive', id: 'cmd_0002' }).success
    ).toBe(true);
  });

  it('acknowledges a refusal with a slug bounded by the handle grammar', () => {
    const outcome = contract.RemoteCommandOutcomeSchema;
    expect(outcome.safeParse('applied').success).toBe(true);
    expect(outcome.safeParse('ignored').success).toBe(true);
    expect(outcome.safeParse('failed').success).toBe(true);
    expect(outcome.safeParse('refused:enrolment-withdrawn').success).toBe(true);
    expect(outcome.safeParse('refused:no_credential').success).toBe(true);
    // Bounded by the same grammar a handle is, so a refusal reason stays one
    // lower-case routing token rather than becoming free prose.
    expect(outcome.safeParse('refused:Enrolment Withdrawn').success).toBe(false);
    expect(outcome.safeParse('refused:').success).toBe(false);
    expect(outcome.safeParse('refused').success).toBe(false);
    expect(outcome.safeParse('refused:a.b').success).toBe(false);
    expect(outcome.safeParse(`refused:${'a'.repeat(33)}`).success).toBe(false);
    expect(outcome.safeParse('declined:whatever').success).toBe(false);
  });

  it('keeps the three settled outcomes narrowable, so an exhaustive switch still type-checks', () => {
    // A plain `z.string()` branch would infer as `string`, swallow the union,
    // and quietly turn a switch TypeScript used to check into one it cannot.
    // The `@ts-expect-error` below is the assertion: it fails the typecheck if
    // this field ever stops refusing a value outside the published set.
    const settled: contract.RemoteCommandOutcome = 'applied';
    const refused: contract.RemoteCommandOutcome = 'refused:enrolment-withdrawn';
    // @ts-expect-error - not an outcome this contract publishes.
    const invented: contract.RemoteCommandOutcome = 'totally-not-an-outcome';
    expect([settled, refused, invented]).toHaveLength(3);
  });

  it('accepts a whole acknowledgement batch carrying a refusal', () => {
    expect(
      contract.RemoteCommandAckRequestSchema.safeParse({
        items: [
          { id: 'cmd_0001', leaseToken: 'lt_0003', outcome: 'applied' },
          { id: 'cmd_0004', leaseToken: 'lt_0004', outcome: 'refused:enrolment-withdrawn' },
        ],
      }).success
    ).toBe(true);
  });
});
