/**
 * Rung 1 on DorkOS credits (spec `heartbeats` §6.3, §10 PR 5): nothing spends
 * until a person said yes; the bridge exists only with a live token serving
 * `openaiChat` and never with the kill switch on; a re-minted token is picked
 * up; the source change is recorded once; and the token never reaches a log,
 * a record row or a beat row. Every port is a fake; nothing reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, type Db } from '@dorkos/db';
import { AuditLog } from '../../audit/audit-log.js';
import { AccountIds } from '../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../audit/audit-trail.js';
import { logger } from '../../../lib/logger.js';
import { createBeatTriagePort } from '../../heartbeats/triage/beat-triage.js';
import { TRIAGE_FUSE, triageBeatWith } from '../heartbeat-triage.js';
import {
  CreditsTriage,
  TRIAGE_MAX_TOKENS,
  type CreditsTriagePorts,
  type HeldToken,
} from '../triage-credits.js';
import { recordTriageSourceChange } from '../triage-wiring.js';
import { COMMITS, fakeChatServer } from './triage-fakes.js';

const SECRET = 'dk-credits-TOKEN-must-never-appear-0001';
const NOW = Date.parse('2026-10-12T14:00:00Z');

/** A token that serves the chat format. */
function token(
  value = SECRET,
  served: string[] = ['anthropicMessages', 'openaiChat'],
  tokenId = 'tok-1'
): HeldToken {
  return { tokenId, token: value, endpoints: { openaiChat: 'https://credits.test/v1' }, served };
}

let held: HeldToken | null;
let state: { choice: boolean | null; killed: boolean; linked: boolean; model: string | null };
let recorded: Array<[string, string]>;
let modelAsked: number;

function ports(
  fetch = fakeChatServer({ label: 'c3', probability: 0.97 }).fetch
): CreditsTriagePorts {
  return {
    choice: () => state.choice,
    killed: () => state.killed,
    linked: () => state.linked,
    token: () => held,
    recommendedModel: async () => {
      modelAsked += 1;
      return state.model;
    },
    fetch,
    recordSourceChange: (from, to) => recorded.push([from.runsOn, to.runsOn]),
  };
}

beforeEach(() => {
  held = token();
  state = { choice: true, killed: false, linked: true, model: 'small-1' };
  recorded = [];
  modelAsked = 0;
});

describe('nothing spends until a person says yes', () => {
  it.each([null, false])(
    'with triageOnCredits %s there is no bridge and no request',
    async (choice) => {
      state.choice = choice;
      const server = fakeChatServer({ label: 'a1', probability: 0.99 });
      const credits = new CreditsTriage(ports(server.fetch), { now: () => NOW });
      expect(await credits.bridge()).toBeUndefined();
      expect(await credits.source()).toEqual({ runsOn: 'runtime', reason: 'not-chosen' });
      const outcome = await triageBeatWith(
        { creditsModel: () => credits.bridge(), counter: credits.counter, now: () => NOW },
        [COMMITS],
        { agentName: 'Juno', checklist: null, rules: 'undecided' }
      );
      expect(outcome.decision).toBe('turn');
      expect(server.seen).toHaveLength(0);
      // Not even the model list is read before a yes.
      expect(modelAsked).toBe(0);
    }
  );
});

describe('the bridge exists only when credits can really serve a check', () => {
  it('never with the kill switch on', async () => {
    state.killed = true;
    const credits = new CreditsTriage(ports());
    expect(await credits.bridge()).toBeUndefined();
    expect((await credits.source()).reason).toBe('switched-off');
  });

  it('never on a computer that is not linked', async () => {
    state.linked = false;
    expect((await new CreditsTriage(ports()).source()).reason).toBe('not-linked');
  });

  it('never without a live token', async () => {
    held = null;
    expect((await new CreditsTriage(ports()).source()).reason).toBe('no-token');
  });

  it('never with a token that does not list openaiChat, or lists nothing', async () => {
    held = token(SECRET, ['anthropicMessages']);
    const credits = new CreditsTriage(ports());
    expect((await credits.source()).reason).toBe('not-served');
    held = { token: SECRET, endpoints: { openaiChat: 'https://credits.test/v1' } };
    expect((await credits.source()).reason).toBe('not-served');
  });

  it('never when the service recommends no model on openaiChat', async () => {
    state.model = null;
    expect((await new CreditsTriage(ports()).source()).reason).toBe('no-model');
  });

  it('with all of them, on the token’s own endpoint, the recommended model and 64 tokens', async () => {
    const server = fakeChatServer({ label: 'c3', probability: 0.97 });
    const credits = new CreditsTriage(ports(server.fetch), { now: () => NOW });
    const bridge = await credits.bridge();
    expect(bridge?.model.id).toBe('dorkos-credits:small-1');
    await triageBeatWith(
      { creditsModel: async () => bridge, counter: credits.counter, now: () => NOW },
      [COMMITS],
      { agentName: 'Juno', checklist: null, rules: 'undecided' }
    );
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]!.url).toBe('https://credits.test/v1/chat/completions');
    expect(server.seen[0]!.body).toMatchObject({ model: 'small-1', max_tokens: TRIAGE_MAX_TOKENS });
    expect(TRIAGE_MAX_TOKENS).toBe(64);
  });

  it('past the fuse, checks run on the runtime', async () => {
    const credits = new CreditsTriage(ports(), { now: () => NOW, requestsToday: TRIAGE_FUSE });
    expect(await credits.source()).toEqual({ runsOn: 'runtime', reason: 'fuse' });
    expect(await credits.bridge()).toBeUndefined();
  });
});

describe('the token', () => {
  it('is read per request, so a re-minted one is used at once by the same bridge', async () => {
    const server = fakeChatServer({ label: 'a1', probability: 0.99 });
    const credits = new CreditsTriage(ports(server.fetch), { now: () => NOW });
    const deps = { creditsModel: () => credits.bridge(), counter: credits.counter, now: () => NOW };
    const context = { agentName: 'Juno', checklist: null, rules: 'undecided' as const };
    await triageBeatWith(deps, [COMMITS], context);
    held = token('dk-credits-REMINTED');
    await triageBeatWith(deps, [COMMITS], context);
    expect(server.seen.map((r) => r.authorization)).toEqual([
      `Bearer ${SECRET}`,
      'Bearer dk-credits-REMINTED',
    ]);
  });

  it('dropped between the look and the request, sends nothing and goes to a turn', async () => {
    const server = fakeChatServer({ label: 'a1', probability: 0.99 });
    const credits = new CreditsTriage(ports(server.fetch), { now: () => NOW });
    const bridge = await credits.bridge();
    held = null;
    const outcome = await triageBeatWith(
      { creditsModel: async () => bridge, counter: credits.counter, now: () => NOW },
      [COMMITS],
      { agentName: 'Juno', checklist: null, rules: 'undecided' }
    );
    expect(server.seen).toHaveLength(0);
    expect(outcome.decision).toBe('turn');
  });
});

const CONTEXT = { agentName: 'Juno', checklist: null, rules: 'undecided' as const };

/** Triage through this credits triage. */
function deps(credits: CreditsTriage) {
  return { creditsModel: () => credits.bridge(), counter: credits.counter, now: () => NOW };
}

describe('a refusal by the endpoint', () => {
  it.each([401, 402, 403])(
    '%s counts as credits dropping out: recorded once, later checks fall back, the page says so',
    async (status) => {
      const server = fakeChatServer({ label: 'a1', status });
      const credits = new CreditsTriage(ports(server.fetch), { now: () => NOW });
      const first = await triageBeatWith(deps(credits), [COMMITS], CONTEXT);
      expect(first.decision).toBe('turn');
      expect(recorded).toEqual([['credits', 'runtime']]);
      expect(await credits.source()).toEqual({ runsOn: 'runtime', reason: 'refused' });
      for (let i = 0; i < 3; i += 1) {
        expect((await triageBeatWith(deps(credits), [COMMITS], CONTEXT)).source).toBe('runtime');
      }
      expect(server.seen).toHaveLength(1);
      expect(recorded).toEqual([['credits', 'runtime']]);
    }
  );

  it('a 503 is an outage, not a refusal: the next beat tries again', async () => {
    const server = fakeChatServer({ label: 'a1', status: 503 });
    const credits = new CreditsTriage(ports(server.fetch), { now: () => NOW });
    await triageBeatWith(deps(credits), [COMMITS], CONTEXT);
    expect((await credits.source()).runsOn).toBe('credits');
    expect(recorded).toEqual([]);
  });

  it('a re-minted token gets a fresh try, recorded once as credits coming back', async () => {
    const server = fakeChatServer((n) =>
      n === 0 ? { label: 'a1', status: 401 } : { label: 'a1', probability: 0.99 }
    );
    const credits = new CreditsTriage(ports(server.fetch), { now: () => NOW });
    await triageBeatWith(deps(credits), [COMMITS], CONTEXT);
    held = token('dk-credits-NEW', undefined, 'tok-2');
    const again = await triageBeatWith(deps(credits), [COMMITS], CONTEXT);
    expect(again).toMatchObject({ source: 'credits', decision: 'quiet' });
    expect(recorded).toEqual([
      ['credits', 'runtime'],
      ['runtime', 'credits'],
    ]);
  });
});

describe('the fuse counts requests', () => {
  it('an ask-twice check is two requests, and the step says so', async () => {
    const server = fakeChatServer({ label: 'a1' });
    const credits = new CreditsTriage(ports(server.fetch), { now: () => NOW });
    const outcome = await triageBeatWith(deps(credits), [COMMITS], CONTEXT);
    expect(server.seen).toHaveLength(2);
    expect(credits.requestsToday()).toBe(2);
    expect(outcome.steps.at(-1)).toMatchObject({ rung: 1, requests: 2 });
  });

  it('never sends past the fuse, not even the second half of a check', async () => {
    const server = fakeChatServer({ label: 'a1' });
    const credits = new CreditsTriage(ports(server.fetch), {
      now: () => NOW,
      requestsToday: TRIAGE_FUSE - 1,
    });
    const outcome = await triageBeatWith(deps(credits), [COMMITS], CONTEXT);
    expect(server.seen).toHaveLength(1);
    expect(credits.requestsToday()).toBe(TRIAGE_FUSE);
    expect(outcome.decision).toBe('turn');
    expect(await credits.source()).toEqual({ runsOn: 'runtime', reason: 'fuse' });
  });

  it('starts from the requests already sent today, so a restart does not reset it', () => {
    const credits = new CreditsTriage(ports(), { now: () => NOW, requestsToday: 40 });
    expect(credits.requestsToday()).toBe(40);
  });
});

describe('the source change', () => {
  it('is recorded once when credits drop out, and once when they come back', async () => {
    const credits = new CreditsTriage(ports(), { now: () => NOW });
    await credits.bridge();
    await credits.bridge();
    expect(recorded).toEqual([]);
    held = null;
    for (let i = 0; i < 5; i += 1) await credits.bridge();
    state.linked = false;
    await credits.bridge();
    expect(recorded).toEqual([['credits', 'runtime']]);
    held = token();
    state.linked = true;
    await credits.bridge();
    await credits.bridge();
    expect(recorded).toEqual([
      ['credits', 'runtime'],
      ['runtime', 'credits'],
    ]);
  });
});

describe('the token never reaches a log or a record', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    initAuditTrail({
      log: new AuditLog(db),
      accounts: new AccountIds({
        db,
        installId: '1',
        readOwnerAccount: () => ({ id: 'acct-owner', name: 'Dorian' }),
      }),
    });
  });

  afterEach(() => {
    resetAuditTrail();
    vi.restoreAllMocks();
  });

  it('across a check, a failed check, a beat row and the source-change rows', async () => {
    const logged: unknown[] = [];
    for (const level of ['debug', 'info', 'warn', 'error', 'log'] as const) {
      vi.spyOn(logger, level).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
    }
    const server = fakeChatServer((n) =>
      n === 0 ? { label: 'c3', probability: 0.97 } : { label: 'a1', status: 401 }
    );
    const credits = new CreditsTriage(
      { ...ports(server.fetch), recordSourceChange: recordTriageSourceChange },
      { now: () => NOW }
    );
    const deps = { creditsModel: () => credits.bridge(), counter: credits.counter, now: () => NOW };
    const port = createBeatTriagePort(
      { queueItem: () => undefined },
      () => 'id',
      (changes, ctx) => triageBeatWith(deps, changes, ctx)
    );
    const context = { agentName: 'Juno', checklist: null, rules: 'undecided' as const };
    const rowsWritten = [
      await port.triage([COMMITS], context),
      await port.triage([COMMITS], context),
    ];
    held = null;
    rowsWritten.push(await port.triage([COMMITS], context));
    held = token(SECRET, undefined, 'tok-2');
    rowsWritten.push(await port.triage([COMMITS], context));

    // The check really went out with the token, so the grep below has something to miss.
    expect(server.seen[0]!.authorization).toBe(`Bearer ${SECRET}`);
    const audit = db.select().from(auditEvents).all();
    // Refused, back on a new token, refused again: three changes, three rows.
    expect(audit.map((row) => row.action)).toEqual([
      'heartbeat.triage_source_changed',
      'heartbeat.triage_source_changed',
      'heartbeat.triage_source_changed',
    ]);
    const everything = JSON.stringify({ rowsWritten, audit, logged });
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(SECRET.slice(-12));
  });
});
