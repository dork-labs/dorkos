/**
 * Contract: the person-only routes at this computer, once an owner exists and
 * no password is asked here (DOR-3330), on the fully composed server.
 *
 * A program on this computer can send a request with no headers at all, so
 * such a request is never the person: each route below refuses it, and the
 * ones a person reaches from the app ask for the one password step-up. After
 * the owner's step-up, the same request is the person and the bar lets it by
 * (the route may still refuse for its own reasons: an unknown id, a bad body).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PERSON_SESSION_REQUIRED_CODE } from '@dorkos/shared/person-session';

import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  stepUpAt,
  type ComposedServer,
} from './harness.js';

/** One person-only write, with a body its route accepts the shape of. */
interface PersonWrite {
  readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
}

const ID = 'not-a-real-id';

/** The routes an agent could use to approve its own work or widen its power. */
const PERSON_WRITES: readonly PersonWrite[] = [
  // Deciding an approval, including a standing yes.
  { method: 'POST', path: `/api/approvals/${ID}/grant`, body: { answer: 'always' } },
  { method: 'POST', path: `/api/approvals/${ID}/deny`, body: {} },
  { method: 'POST', path: `/api/approvals/${ID}/dismiss-suggestion`, body: {} },
  // Answering a chat's waiting tool call or question.
  { method: 'POST', path: `/api/sessions/${ID}/approve`, body: { toolCallId: 't' } },
  { method: 'POST', path: `/api/sessions/${ID}/deny`, body: { toolCallId: 't' } },
  { method: 'POST', path: `/api/sessions/${ID}/submit-answers`, body: { toolCallId: 't' } },
  // Raising what agents may do.
  { method: 'PUT', path: '/api/permissions/preset', body: { preset: 'trusted' } },
  { method: 'PATCH', path: '/api/permissions/defaults', body: {} },
  { method: 'POST', path: `/api/permissions/history/${ID}/undo`, body: {} },
  { method: 'PATCH', path: `/api/agents/${ID}/permissions`, body: {} },
  // Letting code into the server.
  { method: 'POST', path: `/api/extensions/${ID}/approve`, body: {} },
  { method: 'POST', path: `/api/extensions/${ID}/enable`, body: {} },
  { method: 'POST', path: '/api/extensions/trusted-sources', body: { source: 'x' } },
  // Granting itself an outside account.
  { method: 'POST', path: `/api/connectors/reviews/${ID}/decision`, body: { decision: 'approve' } },
  {
    method: 'POST',
    path: `/api/connectors/agent-requests/${ID}/decision`,
    body: { decision: 'approve' },
  },
  // Which agents may talk to which.
  {
    method: 'PUT',
    path: '/api/mesh/topology/access',
    body: { sourceNamespace: '*', targetNamespace: '*', action: 'allow' },
  },
];

describe('contract: the person-only routes at this computer, with an owner', () => {
  let server: ComposedServer | undefined;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };
  let person: Record<string, string> = {};

  /** Send one request; its status and JSON body. */
  async function send(
    write: PersonWrite,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(new URL(write.path, server!.baseUrl), {
      method: write.method,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(write.body ?? {}),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // Not every refusal is JSON; the status says enough.
    }
    return { status: res.status, json };
  }

  beforeAll(async () => {
    server = await bootComposedServer();
    const origin = { origin: server.baseUrl, 'content-type': 'application/json' };
    const signUp = await fetch(new URL('/api/auth/sign-up/email', server.baseUrl), {
      method: 'POST',
      headers: origin,
      body: JSON.stringify({ ...OWNER, name: 'Owner' }),
    });
    expect(signUp.status).toBe(200);
    // The owner's one step-up at this computer.
    person = await stepUpAt(server.baseUrl, OWNER.password);
  }, BOOT_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await server?.close();
  }, 30_000);

  it.each(PERSON_WRITES.map((write) => [`${write.method} ${write.path}`, write] as const))(
    'refuses %s with no headers and no session',
    async (_name, write) => {
      const res = await send(write);
      expect([401, 403]).toContain(res.status);
    }
  );

  it.each(PERSON_WRITES.map((write) => [`${write.method} ${write.path}`, write] as const))(
    'asks the app at this computer for the step-up on %s',
    async (_name, write) => {
      const res = await send(write, { origin: server!.baseUrl, 'x-client-id': 'window-1' });
      expect(res.status).toBe(401);
      expect(res.json.code).toBe(PERSON_SESSION_REQUIRED_CODE);
    }
  );

  it.each(PERSON_WRITES.map((write) => [`${write.method} ${write.path}`, write] as const))(
    'lets the owner’s session past the person bar on %s',
    async (_name, write) => {
      const res = await send(write, {
        origin: server!.baseUrl,
        'x-client-id': 'window-1',
        ...person,
      });
      expect(res.json.code).not.toBe(PERSON_SESSION_REQUIRED_CODE);
      expect(res.status).not.toBe(401);
    }
  );

  it.each(PERSON_WRITES.map((write) => [`${write.method} ${write.path}`, write] as const))(
    'refuses the owner’s cookie without the app’s proof on %s',
    async (_name, write) => {
      // A cookie reaches every port on this computer; the proof stays in the app.
      const res = await send(write, { origin: server!.baseUrl, cookie: person.cookie! });
      expect([401, 403]).toContain(res.status);
    }
  );

  it('asks the app for the step-up before its first chat message, so it is never agent work', async () => {
    const write: PersonWrite = {
      method: 'POST',
      path: `/api/sessions/${randomUUID()}/messages`,
      body: { content: 'hi' },
    };
    const asked = await send(write, { origin: server!.baseUrl, 'x-client-id': 'window-1' });
    expect(asked.status).toBe(401);
    expect(asked.json.code).toBe(PERSON_SESSION_REQUIRED_CODE);
    const proved = await send(write, {
      origin: server!.baseUrl,
      'x-client-id': 'window-1',
      ...person,
    });
    expect(proved.json.code).not.toBe(PERSON_SESSION_REQUIRED_CODE);
  });

  it('parks a task a header-less caller schedules, rather than arming it', async () => {
    const res = await send({
      method: 'POST',
      path: '/api/tasks',
      body: { name: 'probe', prompt: 'hi', cron: '0 0 1 1 *', cwd: '/tmp' },
    });
    if (res.status < 300) {
      expect(res.json.status).toBe('pending_approval');
    } else {
      expect([400, 401, 403, 404]).toContain(res.status);
    }
  });
});
