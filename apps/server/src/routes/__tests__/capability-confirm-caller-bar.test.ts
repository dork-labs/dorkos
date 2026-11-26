/**
 * A caller bar together with the front-door confirm-first hold (DOR-4978),
 * with Security's four terms (t1j, 2026-11-27), each with its own rows, for
 * both bars and on both doors (the capability's REST path and `/invoke`).
 * Driven behind the real chain, a real owner, real sign-ins and the real
 * step-up routes, through two made-up capabilities that join the reviewed
 * confirm-first list for this file only.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { noopLogger } from '@dorkos/shared/logger';
import { ACCOUNT_DECISION_OWNER_ONLY } from '@dorkos/shared/capabilities';
import { user as userTable } from '@dorkos/db';
import { z } from 'zod';

import type { AccountIds } from '../../services/audit/account-ids.js';
import type { AuditLog } from '../../services/audit/audit-log.js';
import { initAuditTrail, resetAuditTrail } from '../../services/audit/audit-trail.js';
import type { RequestFacts } from '../../http/request-facts.js';
import type { RequestUser } from '../../services/core/auth/session-gate.js';
import {
  admitsConfirm,
  peekHeldStepUp,
  resetHeldStepUpsForTests,
} from '../../services/core/auth/step-up/step-up-holds.js';
import {
  composeRegistry,
  type CapabilityHandlerContext,
} from '../../services/core/capabilities/index.js';
import { defineCapability } from '../../services/core/capabilities/capability-definition.js';
import { CONFIRM_FIRST_CAPABILITY_IDS } from '../../services/core/capabilities/declarations/narrow-declarations.js';
import type { ConfirmFirstBar } from '../../services/core/capabilities/declarations/confirm-first.js';
import { createCapabilityHttpRoutes } from '../capability-http.js';
import { createCapabilitiesInvokeRoutes } from '../capabilities-invoke.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

/** What each run's handler saw: the passes the registry handed it. */
const ran: Array<Pick<CapabilityHandlerContext, 'ownerAuthority' | 'personBar'>> = [];

/** A front-door hold on a made-up write, with the sheet built from its input alone. */
const hold = {
  bar: 'front-door',
  kind: 'connection.grant',
  subject: 'made-up things',
  sheet: (_deps: unknown, input: { n: number }) => ({
    target: `made-up-${input.n}`,
    reason: 'Do the made-up thing.',
    bound: input,
  }),
} as const;

const account = defineCapability({
  id: 'testpair.account',
  title: 'Made-up account write',
  description: 'A made-up write behind the account-decision bar and the front-door hold.',
  tier: 'act',
  area: null,
  areaNote: 'a made-up person-only write',
  input: z.object({ n: z.number() }),
  output: z.object({ ran: z.number() }),
  confirmFirst: hold,
  surfaces: {
    http: {
      method: 'post',
      path: '/api/testpair/account',
      audience: 'person',
      callerBar: 'account-decision',
      ownerOnly: ACCOUNT_DECISION_OWNER_ONLY[0],
    },
  },
  invoke: async (_deps, { n }, context) => {
    ran.push({ ownerAuthority: context.ownerAuthority });
    return { ran: n };
  },
});

const person = defineCapability({
  id: 'testpair.person',
  title: 'Made-up person write',
  description: 'A made-up write behind the person bar and the front-door hold.',
  tier: 'act',
  area: null,
  areaNote: 'a made-up person-only write',
  input: z.object({ n: z.number() }),
  output: z.object({ ran: z.number() }),
  confirmFirst: hold,
  surfaces: {
    http: {
      method: 'post',
      path: '/api/testpair/person',
      audience: 'person',
      callerBar: 'person',
      personCopy: { code: 'operator_only', subject: 'made-up things', agent: 'Not for agents.' },
    },
  },
  invoke: async (_deps, { n }, context) => {
    ran.push({ personBar: context.personBar });
    return { ran: n };
  },
});

// The reviewed list names these two for this file only.
const listed = CONFIRM_FIRST_CAPABILITY_IDS as Map<string, ConfirmFirstBar>;
listed.set(account.id, 'front-door');
listed.set(person.id, 'front-door');

/** Which owner the account-decision bar resolves, and a counter stamped on each pass. */
let ownerSuffix = '';
let minted = 0;
const resolveOwner = vi.fn((who: RequestUser | undefined) =>
  who
    ? ({ kind: 'user', userId: `${who.userId}${ownerSuffix}`, minted: ++minted } as never)
    : undefined
);
const ports = { accountDecision: { resolveOwner, loginEnabled: () => true } };

const owner = frontDoorStepUpHarness(() => {
  const domain = { name: 'testpair', capabilities: [account, person] };
  const registry = composeRegistry([domain], { logger: noopLogger });
  return [
    {
      path: '/',
      routes: createCapabilityHttpRoutes({
        registry: () => registry,
        capabilities: domain.capabilities,
        ports,
      }),
    },
    { path: '/api/capabilities', routes: createCapabilitiesInvokeRoutes(registry, ports) },
  ];
});

afterAll(() => {
  listed.delete(account.id);
  listed.delete(person.id);
  resetAuditTrail();
});

/** Every row the audit trail was asked to keep. */
let audited: Array<{ action: string; outcome?: string; error?: string; summary?: string }> = [];

beforeEach(() => {
  resetHeldStepUpsForTests();
  ownerSuffix = '';
  ran.length = 0;
  audited = [];
  initAuditTrail({
    log: {
      record: (row: (typeof audited)[number]) => (audited.push(row), row),
    } as never as AuditLog,
    accounts: new Proxy({}, { get: () => () => 'made-up-actor' }) as AccountIds,
  });
});

type Door = 'rest' | 'invoke';
const DOORS = [
  ['account-decision', account.id, '/api/testpair/account'],
  ['person', person.id, '/api/testpair/person'],
] as const;
const ROWS = DOORS.flatMap(([bar, id, path]) =>
  (['rest', 'invoke'] as const).map((door) => [bar, door, id, path] as const)
);

/** Ask through one door and return the held action's id. */
async function ask(door: Door, id: string, path: string, n = 1): Promise<string> {
  const res =
    door === 'rest'
      ? await owner.call('post', path).send({ n })
      : await owner.call('post', `/api/capabilities/${id}/invoke`).send({ n });
  expect(res.status).toBe(428);
  return res.body.heldActionId as string;
}

/** The confirming request's facts: the owner's very session at this computer, plus `headers`. */
function confirming(heldId: string, headers: Record<string, string> = {}): RequestFacts {
  return {
    headers,
    peerAddress: '127.0.0.1',
    forwardedAddress: '127.0.0.1',
    connectionEncrypted: false,
    ingress: 'direct',
    user: {
      userId: owner.db().select().from(userTable).get()!.id,
      credential: 'cookie',
      sessionId: peekHeldStepUp(heldId)!.sessionId!,
    },
    agentIdentity: undefined,
    method: 'POST',
  } as RequestFacts;
}

/** What a confirm with no hold behind it answers, minus the per-request `instance`. */
async function noHoldAnswer() {
  const res = await owner.confirm('01J0000000000000000000NONE');
  const { instance: _instance, ...body } = res.body as Record<string, unknown>;
  return { status: res.status, body };
}

describe('the pair composes (DOR-4978, Security t1j 2026-11-27)', () => {
  it('a caller bar takes the front-door hold, never the account-owner one', () => {
    const accountOwner = {
      ...account,
      confirmFirst: { bar: 'account-owner', kind: 'connection.grant' },
    } as unknown as typeof account;
    listed.set(account.id, 'account-owner');
    try {
      expect(() =>
        composeRegistry([{ name: 'testpair', capabilities: [accountOwner] }], {
          logger: noopLogger,
        })
      ).toThrow(/takes the front-door bar/);
    } finally {
      listed.set(account.id, 'front-door');
    }
  });
});

describe.each(ROWS)('the %s bar with the front-door hold, through %s', (bar, door, id, path) => {
  it('held, then confirmed by the same caller, runs once with the confirm’s own pass', async () => {
    const heldId = await ask(door, id, path, 7);
    const done = await owner.confirm(heldId);
    expect(done.body).toMatchObject({ ok: true, status: 200, result: { ran: 7 } });
    expect(ran).toHaveLength(1);
    // Single use: a second confirm finds nothing.
    expect((await owner.confirm(heldId)).status).toBe(404);
  });

  it('1. fresh on both: the bar runs again on the confirm, and the hold keeps no pass', async () => {
    const heldId = await ask(door, id, path);
    const before = resolveOwner.mock.calls.length;
    const askedPass = minted;
    await owner.confirm(heldId);
    if (bar === 'account-decision') {
      // Run on the confirm (before the hold's checks, and again for the pass it runs with).
      expect(resolveOwner.mock.calls.length).toBeGreaterThan(before);
      expect((ran[0]!.ownerAuthority as unknown as { minted: number }).minted).toBeGreaterThan(
        askedPass
      );
    } else {
      expect(ran[0]!.personBar?.caller).toBe('person');
    }
  });

  it('2. a confirm by another kind of caller is refused, never relabelled, and the hold stays usable', async () => {
    const heldId = await ask(door, id, path, 3);
    if (bar === 'account-decision') {
      // Another owner than the one that asked.
      ownerSuffix = '-someone-else';
      expect((await owner.confirm(heldId)).status).toBe(404);
      ownerSuffix = '';
    } else {
      // A key-only program: its bar's tag is `program`, never the person who asked.
      expect(admitsConfirm(heldId, confirming(heldId, { 'x-api-key': 'dork_made_up' }))).toBe(
        false
      );
      const res = await owner
        .call('post', `/api/step-up/${heldId}/password`)
        .set('Authorization', 'Bearer dork_made_up')
        .send({ password: 'made-up-correct-horse-battery' });
      expect(res.status).toBe(403);
    }
    expect(ran).toHaveLength(0);
    const done = await owner.confirm(heldId);
    expect(done.body).toMatchObject({ ok: true, status: 200, result: { ran: 3 } });
  });

  it('3. a refused confirm answers as no hold, spends no try, and names nothing about it', async () => {
    const heldId = await ask(door, id, path);
    const triesBefore = peekHeldStepUp(heldId)!.triesLeft;
    let res;
    if (bar === 'account-decision') {
      ownerSuffix = '-someone-else';
      // A wrong password too: the bar answers before the password is read.
      res = await owner.call('post', `/api/step-up/${heldId}/password`).send({ password: 'wrong' });
      ownerSuffix = '';
    } else {
      // Behind the person bar the step-up route's own caller check is the bar a
      // program meets; it runs before the hold is looked up, as for no hold.
      res = await owner
        .call('post', `/api/step-up/${heldId}/password`)
        .set('Authorization', 'Bearer dork_made_up')
        .send({ password: 'wrong' });
      const none = await owner
        .call('post', '/api/step-up/01J0000000000000000000NONE/password')
        .set('Authorization', 'Bearer dork_made_up')
        .send({ password: 'wrong' });
      expect(res.status).toBe(none.status);
      expect(res.body.detail).toBe(none.body.detail);
    }
    if (bar === 'account-decision') {
      const { instance: _instance, ...body } = res.body as Record<string, unknown>;
      expect({ status: res.status, body }).toEqual(await noHoldAnswer());
    }
    const said = JSON.stringify(res.body);
    for (const word of [heldId, 'made-up-1', 'Do the made-up thing', 'triesLeft', 'expiresAt']) {
      expect(said).not.toContain(word);
    }
    expect(peekHeldStepUp(heldId)!.triesLeft).toBe(triesBefore);
    expect(ran).toHaveLength(0);
  });

  it('3. the bar answers on the confirm before any of the hold’s own checks', async () => {
    const heldId = await ask(door, id, path);
    // Past its time by the clock, before its timer has dropped it.
    const expiresAt = Date.parse(peekHeldStepUp(heldId)!.statement.expiresAt);
    const facts =
      bar === 'account-decision'
        ? confirming(heldId)
        : confirming(heldId, { 'x-dorkos-agent': 'made-up-agent-token' });
    if (bar === 'account-decision') ownerSuffix = '-someone-else';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(expiresAt + 1_000);
    try {
      expect(admitsConfirm(heldId, facts)).toBe(false);
    } finally {
      vi.useRealTimers();
      ownerSuffix = '';
    }
    // The refusal is the bar's, recorded as such, not the hold's time.
    const refused = audited.filter((row) => row.error?.startsWith('not-admitted-'));
    expect(refused.map((row) => row.error)).toEqual([
      bar === 'account-decision' ? 'not-admitted-caller-kind' : 'not-admitted-caller-bar',
    ]);
    expect(refused[0]!.summary).toContain('still held');
  });

  it('4. the run is attributed from the confirm’s pass', async () => {
    const heldId = await ask(door, id, path);
    const askedPass = minted;
    await owner.confirm(heldId);
    const rows = audited.filter((row) => row.action === 'capability.confirm-first.confirmed');
    expect(rows.map((row) => row.outcome)).toEqual(['ok']);
    if (bar === 'account-decision') {
      const owned = ran[0]!.ownerAuthority as unknown as { minted: number; userId: string };
      expect(owned.minted).toBe(minted);
      expect(owned.minted).toBeGreaterThan(askedPass);
    } else {
      expect(ran[0]!.personBar?.caller).toBe('person');
    }
  });

  it('keeps #4526’s proofs: the ingress it was asked by, and no agent path', async () => {
    const heldId = await ask(door, id, path);
    const tunnel = await owner
      .call('post', `/api/step-up/${heldId}/password`, 'own-tunnel')
      .set('Cookie', owner.currentCookie('direct'))
      .send({ password: 'made-up-correct-horse-battery' });
    expect(tunnel.body.ok).not.toBe(true);
    const agent = await owner
      .call('post', door === 'rest' ? path : `/api/capabilities/${id}/invoke`)
      .set('X-DorkOS-Agent', 'made-up-agent-token')
      .send({ n: 1 });
    expect(agent.status).toBe(403);
    expect(agent.body.heldActionId).toBeUndefined();
    expect(ran).toHaveLength(0);
    // Still held for the one that asked.
    expect((await owner.confirm(heldId)).body).toMatchObject({ ok: true, status: 200 });
  });
});
