/**
 * The watch-only spam and rule checks on new posts (specs/official-community-space D15;
 * DOR-2777) over real HTTP and Postgres, with stubbed decision models: no test reaches the
 * network.
 *
 * Pinned here: a post is never delayed by a check, even one that hangs; the built-in rules run
 * first and a message they flag buys no model call; two models run side by side and each writes
 * its own `decision.*` row; a flag is a report in the queue, with each check's verdict beside it,
 * and nothing is hidden, held or removed; a flagged author still posts and reads; the daily cap
 * stops calls and records "unsure"; two sweeps never check one message twice; and the
 * comparison against moderators' rulings reads from the host API and `/metrics`.
 */
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { Pool } from 'pg';
import type { FetchLike } from '@dorkos/decisions';
import type { DecisionAnswer, DecisionModel, DecisionRequest } from '@dorkos/shared/decision-model';
import {
  CommunityDecisionRecordSchema,
  CommunityExportAuditEventRowSchema,
  type CommunityWireReport,
} from '@dorkos/shared/community-wire';
import { createCommunityApp } from '../../app.js';
import { parseConfig } from '../../config.js';
import { migrate } from '../../migrate.js';
import { eraseMembership } from '../../erasure/erasure.js';
import { checkNewPosts, type DecisionWorkerOptions } from '../worker.js';
import { decisionSettings, type ModelSlot } from '../settings.js';
import {
  bootstrapFirstHost,
  responseCookies,
  seedCredentialAccount,
} from '../../__tests__/bootstrap-test-helper.js';

const adminUrl = process.env.COMMUNITY_TEST_DATABASE_URL;
if (!adminUrl) throw new Error('COMMUNITY_TEST_DATABASE_URL is required for post check tests');
const admin = new Pool({ connectionString: adminUrl });
const dbName = `community_checks_${randomUUID().replaceAll('-', '')}`;
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;
const origin = 'http://localhost:6482';
const password = 'password1234';
const authSecret = 'a'.repeat(32);

let pool: Pool;
let server: ReturnType<typeof serve>;
let baseUrl = '';
let storagePath = '';
let communityId = '';
let general = '';
let ownerCookie = '';

interface Person {
  cookie: string;
  memberId: string;
}

function call(path: string, method: string, cookie: string | null, body?: unknown) {
  const headers: Record<string, string> = { origin };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const scoped = (path: string) => `/api/v1/communities/${communityId}${path}`;

async function expectStatus(response: Response, status: number): Promise<Record<string, unknown>> {
  const text = await response.text();
  expect(response.status, text.slice(0, 300)).toBe(status);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function posted(who: Person, text: string): Promise<string> {
  const body = await expectStatus(
    await call(scoped(`/channels/${general}/entries`), 'POST', who.cookie, {
      text,
      idempotencyKey: randomUUID(),
    }),
    201
  );
  return (body.entry as { id: string }).id;
}

async function person(name: string): Promise<Person> {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 6)}@checks.test`;
  await seedCredentialAccount(pool, { name, email, password });
  const signIn = await call('/api/auth/sign-in/email', 'POST', null, { email, password });
  expect(signIn.status).toBe(200);
  const cookie = responseCookies(signIn);
  const { token } = (await expectStatus(
    await call(scoped('/invites'), 'POST', ownerCookie, { seats: 1 }),
    201
  )) as { token: string };
  const preflight = await call(scoped('/invites/preflight'), 'POST', null, { token });
  const both = `${cookie}; ${responseCookies(preflight)}`;
  await expectStatus(await call(scoped('/invites/bind'), 'POST', both, {}), 200);
  const redeemed = await expectStatus(await call(scoped('/invites/redeem'), 'POST', both, {}), 200);
  await expectStatus(await call(scoped(`/channels/${general}/join`), 'POST', cookie, {}), 200);
  return { cookie, memberId: redeemed.memberId as string };
}

/** A stub decision model: answers with `answer`, or waits for the signal when told to hang. */
function stubModel(
  answer: (req: DecisionRequest) => Record<string, DecisionAnswer>,
  hooks: { hang?: boolean; started?: () => void } = {}
): DecisionModel & { calls: DecisionRequest[] } {
  const calls: DecisionRequest[] = [];
  return {
    id: 'stub',
    calls,
    capabilities: {
      kinds: ['choice'],
      customRules: true,
      reasons: false,
      calibrated: false,
      runsLocally: true,
      maxInputTokens: 32_000,
    },
    async decide(req, signal) {
      calls.push(req);
      hooks.started?.();
      if (hooks.hang) {
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        return {
          answers: Object.fromEntries(
            Object.keys(req.questions).map((id) => [
              id,
              { value: null, confidence: 0, failure: 'aborted' as const },
            ])
          ),
          modelId: 'stub-hang-1',
          latencyMs: 1,
        };
      }
      return { answers: answer(req), modelId: 'stub-model-1', latencyMs: 12, costMicroUsd: 40 };
    },
  };
}

const ordinary = () => ({ spam: { value: 'a1', confidence: 0.9 } });
const spammy = () => ({ spam: { value: 'a2', confidence: 0.9 } });

function sweep(models: ModelSlot[], extra: Partial<DecisionWorkerOptions> = {}) {
  return checkNewPosts({ pool, authSecret, models, dailyCallCap: 1000, batch: 100, ...extra });
}

async function records(entryId: string) {
  const result = await pool.query<{ action: string; next_state: string; decision: unknown }>(
    `SELECT action,next_state,decision FROM audit_events
     WHERE community_id=$1 AND subject_id=$2 AND action LIKE 'decision.%'
     ORDER BY action,decision->>'check'`,
    [communityId, entryId]
  );
  return result.rows.map((row) => ({
    ...row,
    record: CommunityDecisionRecordSchema.parse(row.decision),
  }));
}

async function checkReports(entryId: string) {
  const result = await pool.query<{ check_name: string; reason: string; note: string }>(
    `SELECT check_name,reason,note FROM reports
     WHERE entry_id=$1 AND source='check' ORDER BY check_name`,
    [entryId]
  );
  return result.rows;
}

async function history(): Promise<string[]> {
  const page = await expectStatus(
    await call(scoped(`/channels/${general}/entries?limit=100`), 'GET', ownerCookie),
    200
  );
  return (page.entries as Array<{ id: string }>).map((entry) => entry.id);
}

beforeAll(async () => {
  storagePath = await mkdtemp(join(tmpdir(), 'community-checks-'));
  await admin.query(`CREATE DATABASE ${dbName}`);
  await migrate(dbUrl.toString());
  pool = new Pool({ connectionString: dbUrl.toString() });
  const config = parseConfig({
    COMMUNITY_DATABASE_URL: dbUrl.toString(),
    COMMUNITY_AUTH_SECRET: authSecret,
    COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
    COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
    COMMUNITY_PUBLIC_URL: origin,
    COMMUNITY_STORAGE_PATH: storagePath,
    COMMUNITY_POSTS_PER_TEN_MINUTES: '500',
  });
  const app = createCommunityApp({
    config,
    pool,
    hooks: { invitePreviewPeer: () => randomUUID() },
  });
  server = serve({ fetch: app.fetch, port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  baseUrl = `http://localhost:${address.port}`;
  const founder = await bootstrapFirstHost(
    (path, body, cookie) => call(path, 'POST', cookie ?? null, body),
    {
      secret: config.bootstrapSecret,
      accountName: 'Olive Owner',
      email: 'olive@checks.test',
      password,
      communityName: 'Checked',
    }
  );
  ownerCookie = founder.cookie;
  communityId = founder.communityId;
  general = founder.channelId;
});

afterAll(async () => {
  (server as Server | undefined)?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.end();
  await rm(storagePath, { recursive: true, force: true });
});

describe('a post and its checks', () => {
  // Every test starts with nothing waiting: earlier tests' messages are claimed by the rules alone,
  // so no sweep here meets another test's message.
  beforeEach(async () => {
    await sweep([]);
  });

  it('is never delayed: a post lands at once while a model hangs on the one before it', async () => {
    const carol = await person('Carol');
    const first = await posted(carol, `first ${randomUUID()}`);
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => (started = resolve));
    const hanging = stubModel(ordinary, { hang: true, started });
    const running = sweep([{ check: 'jev', model: hanging }], { timeoutMs: 2_000 });
    await modelStarted;

    const before = performance.now();
    const second = await posted(carol, `second ${randomUUID()}`);
    expect(performance.now() - before).toBeLessThan(1_000);
    expect(await history()).toEqual(expect.arrayContaining([first, second]));

    await running;
    const rows = await records(first);
    expect(rows.map((row) => [row.action, row.record.check, row.record.verdict])).toEqual([
      ['decision.rung0', 'rules', 'unsure'],
      ['decision.rung1', 'jev', 'unsure'],
    ]);
    expect(rows[1]!.record.answers.spam).toMatchObject({ value: null, failure: 'aborted' });
    expect(await checkReports(first)).toEqual([]);
  });

  it('runs the rules first, and a message they flag stays up and buys no model call', async () => {
    const dave = await person('Dave');
    const words = `Visit my shop for great deals ${randomUUID().slice(0, 8)}`;
    const model = stubModel(ordinary);
    const ids = [await posted(dave, words), await posted(dave, words), await posted(dave, words)];
    await sweep([{ check: 'openai', model }]);

    const third = await records(ids[2]!);
    expect(third).toHaveLength(1);
    expect(third[0]!.record).toMatchObject({
      rung: 0,
      check: 'rules',
      verdict: 'flagged',
      answers: { spam: { value: 'a2', confidence: 1, reason: 'repeat' } },
    });
    // The two before it were not flagged by a rule, so the model saw them; the third it never saw.
    expect(model.calls.map((req) => req.item)).toEqual([words, words]);
    expect(model.calls).toHaveLength(2);
    expect(await checkReports(ids[2]!)).toEqual([
      {
        check_name: 'rules',
        reason: 'spam',
        note: 'Posted these same words 3 times today. Nothing was hidden.',
      },
    ]);

    // Watch-only: the message is still there, its author is not held, and still posts.
    expect(await history()).toEqual(expect.arrayContaining(ids));
    const state = await pool.query(
      `SELECT e.removed_at,m.muted_until FROM entries e JOIN members m ON m.id=e.author_member_id
       WHERE e.id=$1`,
      [ids[2]]
    );
    expect(state.rows[0]).toEqual({ removed_at: null, muted_until: null });
    await posted(dave, `still here ${randomUUID()}`);
  });

  it('runs Jev and an OpenAI-format model side by side, hints in the queue, and compares them with moderators', async () => {
    const erin = await person('Erin');
    const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
    const stubFetch: FetchLike = async (url, init) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      seen.push({ url, body });
      const json = url.endsWith('/systemone')
        ? {
            model: 'typesafe/jev-test',
            answers: { spam: { choice: 'a2', confidence: 0.9 } },
            usage: { input_tokens: 100 },
          }
        : {
            choices: [{ message: { role: 'assistant', content: '{"spam":"a1"}' } }],
            usage: { prompt_tokens: 100, completion_tokens: 10 },
          };
      return { ok: true, status: 200, json: async () => json };
    };
    const { models } = decisionSettings(
      {
        COMMUNITY_DECISIONS_JEV_KEY: 'jev-key',
        COMMUNITY_DECISIONS_JEV_PRICE: '0.5',
        COMMUNITY_DECISIONS_OPENAI_KEY: 'openai-key',
        COMMUNITY_DECISIONS_OPENAI_BASE_URL: 'http://models.test/v1',
        COMMUNITY_DECISIONS_OPENAI_MODEL: 'test-model-1',
      },
      { paidArmed: true, fetch: stubFetch }
    );
    const text = `Cheap watches, today only ${randomUUID().slice(0, 8)}`;
    const entryId = await posted(erin, text);
    await sweep(models);

    const rows = await records(entryId);
    expect(rows.map((row) => [row.record.rung, row.record.check, row.record.verdict])).toEqual([
      [0, 'rules', 'unsure'],
      [1, 'jev', 'flagged'],
      [1, 'openai', 'fine'],
    ]);
    const jev = rows[1]!.record;
    expect(jev).toMatchObject({
      modelId: 'typesafe/jev-test',
      useCase: 'community.post',
      costMicroUsd: 50,
    });
    expect(jev.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows.every((row) => row.record.policyVersion.length === 16)).toBe(true);
    // The post went only as Jev's `state`, never into a question.
    expect(seen.every((c) => JSON.stringify(c.body).includes(text))).toBe(true);
    const jevCall = seen.find((c) => c.url.endsWith('/systemone'))!;
    expect(jevCall.body.state).toEqual({ item: text, context: { author: 'person', reply: false } });
    expect(JSON.stringify(jevCall.body.questions)).not.toContain('Cheap watches');
    // The OpenAI-format bridge asked twice (no logprobs) and both agreed.
    expect(seen.filter((c) => c.url.endsWith('/chat/completions'))).toHaveLength(2);

    expect(await checkReports(entryId)).toEqual([
      {
        check_name: 'jev',
        reason: 'spam',
        note: 'Jev thinks this is spam (90% sure). Nothing was hidden.',
      },
    ]);
    const queue = await expectStatus(await call(scoped('/reports'), 'GET', ownerCookie), 200);
    const report = (queue.reports as CommunityWireReport[]).find((r) => r.entryId === entryId)!;
    expect(report).toMatchObject({ source: 'check', checkName: 'jev', reporter: null });
    expect(report.checks?.map((h) => [h.check, h.verdict, h.finding])).toEqual([
      ['jev', 'flagged', 'spam'],
      ['openai', 'fine', null],
      ['rules', 'unsure', null],
    ]);

    // A moderator says it was fine: the model that agreed scores, the one that flagged does not.
    await expectStatus(
      await call(`${scoped(`/reports/${report.id}/resolve`)}`, 'POST', ownerCookie, {
        action: 'dismiss',
      }),
      200
    );
    const comparison = await expectStatus(
      await call('/api/v1/host/decisions', 'GET', ownerCookie),
      200
    );
    const figures = comparison.models as Array<Record<string, unknown>>;
    expect(figures.find((f) => f.check === 'openai' && f.modelId === 'test-model-1')).toMatchObject(
      {
        modelId: 'test-model-1',
        judged: 1,
        agreed: 1,
        agreement: 1,
      }
    );
    expect(
      figures.find((f) => f.check === 'jev' && f.modelId === 'typesafe/jev-test')
    ).toMatchObject({
      modelId: 'typesafe/jev-test',
      judged: 1,
      agreed: 0,
      agreement: 0,
      costMicroUsd: 50,
    });
    // Host authority only: a member of a space cannot read it.
    expect(
      (await call('/api/v1/host/decisions', 'GET', erin.cookie)).status
    ).toBeGreaterThanOrEqual(401);

    const metrics = await call('/metrics', 'GET', ownerCookie);
    expect(metrics.status).toBe(200);
    const text30 = await metrics.text();
    expect(text30).toContain(
      'community_decision_agreement_ratio_30d{check="openai",model="test-model-1"} 1'
    );
    expect(text30).toContain(
      'community_decision_cost_usd_30d{check="jev",model="typesafe/jev-test"} 0.00005'
    );
  });

  it('asks about the space’s rules by number, and files a broken rule as a hint', async () => {
    const harry = await person('Harry');
    const entryId = await posted(harry, `Buy my course ${randomUUID().slice(0, 8)}`);
    await pool.query(
      'UPDATE communities SET rules_text=$2,rules_version=rules_version+1 WHERE id=$1',
      [communityId, 'Be kind.\n\n- Be kind to everyone\n- No selling']
    );
    try {
      const model = stubModel(() => ({
        spam: { value: 'a1', confidence: 0.9 },
        conduct: { value: 'r2', confidence: 0.8 },
      }));
      await sweep([{ check: 'openai', model }]);
      const asked = model.calls[0]!;
      const conduct = asked.questions.conduct;
      expect(conduct?.kind === 'choice' && Object.keys(conduct.labels)).toEqual(['r0', 'r1', 'r2']);
      expect(asked.rules).toContain('2. No selling');
      expect(await checkReports(entryId)).toEqual([
        {
          check_name: 'openai',
          reason: 'other',
          note: 'stub-model-1 thinks this breaks rule 2 (80% sure). Nothing was hidden.',
        },
      ]);
    } finally {
      await pool.query('UPDATE communities SET rules_text=NULL WHERE id=$1', [communityId]);
    }
  });

  it('stops calling a model at its daily cap and records unsure instead', async () => {
    const frank = await person('Frank');
    const today = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events WHERE action='decision.rung1'
         AND decision->>'check'='jev' AND NOT (decision ? 'skipped')
         AND created_at >= (now() AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC'`
    );
    const a = await posted(frank, `one ${randomUUID()}`);
    const b = await posted(frank, `two ${randomUUID()}`);
    const model = stubModel(ordinary);
    const told: string[] = [];
    await sweep([{ check: 'jev', model }], {
      dailyCallCap: today.rows[0]!.n + 1,
      concurrency: 1,
      onCapReached: (check) => told.push(check),
    });
    expect(model.calls).toHaveLength(1);
    expect(told).toEqual(['jev']);
    const [first, second] = [await records(a), await records(b)];
    expect(first[1]!.record).toMatchObject({ check: 'jev', verdict: 'fine' });
    expect(second[1]!.record).toMatchObject({
      check: 'jev',
      verdict: 'unsure',
      skipped: 'cap-reached',
    });
  });

  it('never sends a private channel’s message to a model', async () => {
    const created = await expectStatus(
      await call(scoped('/channels'), 'POST', ownerCookie, {
        name: `quiet-${randomUUID().slice(0, 6)}`,
        visibility: 'private',
      }),
      201
    );
    const quiet = (created.channel as { id: string }).id;
    const body = await expectStatus(
      await call(scoped(`/channels/${quiet}/entries`), 'POST', ownerCookie, {
        text: `just us ${randomUUID()}`,
        idempotencyKey: randomUUID(),
      }),
      201
    );
    const entryId = (body.entry as { id: string }).id;
    const model = stubModel(spammy);
    await sweep([{ check: 'jev', model }]);
    expect(model.calls).toHaveLength(0);
    expect((await records(entryId)).map((row) => row.record.check)).toEqual(['rules']);
  });

  it('keeps at most five open check reports against one person, and still records the rest', async () => {
    const kim = await person('Kim');
    const words = `Same pitch again and again ${randomUUID().slice(0, 8)}`;
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) ids.push(await posted(kim, words));
    await sweep([]);
    // The third and every later copy trip the repeat rule: seven flags, five reports.
    const flagged = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
       WHERE action='decision.rung0' AND next_state='flagged' AND subject_id=ANY($1::text[])`,
      [ids]
    );
    expect(flagged.rows[0]!.n).toBe(7);
    const filed = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM reports WHERE source='check' AND entry_id=ANY($1::uuid[])",
      [ids]
    );
    expect(filed.rows[0]!.n).toBe(5);
  });

  it('flags a fast poster by the rate rule', async () => {
    const lee = await person('Lee');
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) ids.push(await posted(lee, `quick ${i} ${randomUUID()}`));
    await sweep([]);
    const last = await records(ids[9]!);
    expect(last[0]!.record.answers.spam).toMatchObject({ value: 'a2', reason: 'rate' });
    expect((await checkReports(ids[9]!))[0]?.note).toBe(
      'Posted 10 messages in one minute. Nothing was hidden.'
    );
  });

  it('never checks, or pays for, one message twice when two sweeps race', async () => {
    const gina = await person('Gina');
    const entryId = await posted(gina, `race ${randomUUID()}`);
    const model = stubModel(spammy);
    await Promise.all([sweep([{ check: 'jev', model }]), sweep([{ check: 'jev', model }])]);
    expect(model.calls.filter((req) => String(req.item).startsWith('race'))).toHaveLength(1);
    expect((await records(entryId)).map((row) => row.action)).toEqual([
      'decision.rung0',
      'decision.rung1',
    ]);
    expect(await checkReports(entryId)).toHaveLength(1);
  });

  it('keeps records content-free, exportable, and without the input hash once the author is erased', async () => {
    const ivy = await person('Ivy');
    const entryId = await posted(ivy, `Ivy's words ${randomUUID()}`);
    await sweep([{ check: 'jev', model: stubModel(spammy) }]);
    const raw = await pool.query(
      `SELECT id,community_id,actor_member_id,actor_kind,action,subject_id,prior_state,next_state,
         changed_fields,created_at,decision FROM audit_events
       WHERE subject_id=$1 AND action LIKE 'decision.%'`,
      [entryId]
    );
    for (const row of raw.rows) {
      expect(JSON.stringify(row.decision)).not.toContain("Ivy's words");
      // The line an owner export writes for it reads back under the archive schema.
      CommunityExportAuditEventRowSchema.parse({
        ...row,
        created_at: row.created_at.toISOString(),
      });
    }

    expect(await eraseMembership(pool, communityId, ivy.memberId, { log: () => {} })).toBe(
      'erased'
    );
    const after = await records(entryId);
    expect(after).toHaveLength(2);
    for (const row of after) {
      expect(row.record.inputHash).toBeUndefined();
      expect(row.record.verdict).toBeTruthy();
    }
  });
});
