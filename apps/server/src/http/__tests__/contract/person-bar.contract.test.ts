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
import { readFileSync } from 'node:fs';
import path from 'node:path';
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
  // Confirming a Claude sign-in, and the lists DorkOS must never use (DOR-3245).
  { method: 'POST', path: `/api/runtimes/claude-code/signins/${ID}/accept`, body: {} },
  {
    method: 'POST',
    path: '/api/runtimes/claude-code/signins/organizations',
    body: { orgId: '22222222-2222-4222-8222-222222222222', label: 'Excluded' },
  },
  { method: 'POST', path: '/api/runtimes/claude-code/signins/folders', body: { accountId: ID } },
];

describe('contract: the person-only routes at this computer, with an owner', () => {
  let server: ComposedServer | undefined;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };
  let person: Record<string, string> = {};
  let apiKey = '';

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
    // A key, as the CLI holds one: a program, never the person.
    const minted = await fetch(new URL('/api/auth/api-key/create', server.baseUrl), {
      method: 'POST',
      headers: { ...origin, ...person },
      body: JSON.stringify({ name: 'cli' }),
    });
    expect(minted.status).toBe(200);
    apiKey = ((await minted.json()) as { key: string }).key;
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

  it('asks the app for the step-up before scheduling a task, and arms nothing', async () => {
    const write: PersonWrite = {
      method: 'POST',
      path: '/api/tasks',
      body: { name: 'probe', prompt: 'hi', cron: '0 0 1 1 *', cwd: '/tmp' },
    };
    const asked = await send(write, { origin: server!.baseUrl, 'x-client-id': 'window-1' });
    expect(asked.status).toBe(401);
    expect(asked.json.code).toBe(PERSON_SESSION_REQUIRED_CODE);
    // A program is never asked; its task is refused or parked for approval, never armed.
    const bare = await send(write);
    if (bare.status < 300) expect(bare.json.status).toBe('pending_approval');
    else expect([400, 401, 403]).toContain(bare.status);
  });

  it('lets only the person change what a chat may do', async () => {
    const write: PersonWrite = {
      method: 'PATCH',
      path: `/api/sessions/${randomUUID()}`,
      body: { permissionMode: 'bypassPermissions' },
    };
    expect((await send(write)).status).toBe(403);
    const app = await send(write, { origin: server!.baseUrl, 'x-client-id': 'window-1' });
    expect(app.json.code).toBe(PERSON_SESSION_REQUIRED_CODE);
    // Refused; an agent that cannot be named does not even learn the chat exists.
    const agent = await send(write, { 'x-dorkos-agent': 'not-a-real-token' });
    expect([403, 404]).toContain(agent.status);
    const owner = await send(write, { origin: server!.baseUrl, ...person });
    expect([401, 403]).not.toContain(owner.status);
  });

  it('keeps the local MCP token from a program', async () => {
    for (const verb of ['rotate-token', 'reveal-token']) {
      const res = await send({ method: 'POST', path: `/api/config/mcp/${verb}`, body: {} });
      expect([401, 403]).toContain(res.status);
    }
  });

  describe('package sources and the CLI', () => {
    const add: PersonWrite = {
      method: 'POST',
      path: '/api/marketplace/sources',
      body: { name: 'probe', source: 'https://example.com/marketplace', enabled: true },
    };

    it.each([
      ['with a key', { authorization: 'Bearer KEY' }],
      ['with no key', {}],
    ])('tells the CLI %s exactly where in the app to add one, never a bare 401', async (_l, h) => {
      const headers = Object.fromEntries(
        Object.entries(h).map(([k, v]) => [k, v.replace('KEY', apiKey)])
      );
      const res = await send(add, headers);
      expect(res.status).toBe(403);
      expect(res.json).toEqual({
        error:
          'Adding a marketplace needs you signed in. In the DorkOS app, open Marketplace sources and click Add marketplace source.',
        code: 'marketplace_source_needs_app',
      });
    });

    it('asks the app for the step-up, and lets the owner’s session by', async () => {
      const asked = await send(add, { origin: server!.baseUrl, 'x-client-id': 'window-1' });
      expect(asked.json.code).toBe(PERSON_SESSION_REQUIRED_CODE);
      const owner = await send(add, { origin: server!.baseUrl, ...person });
      expect(owner.json.code).not.toBe('marketplace_source_needs_app');
      expect(owner.json.code).not.toBe(PERSON_SESSION_REQUIRED_CODE);
    });
  });

  describe('operator-only settings (C4)', () => {
    const configFile = () => path.join(server!.dorkHome, 'config.json');

    it('refuses a keyed caller an operator-only setting and writes nothing', async () => {
      const before = readFileSync(configFile());
      const res = await send(
        { method: 'PATCH', path: '/api/config', body: { tunnel: { authtoken: 'planted' } } },
        { authorization: `Bearer ${apiKey}` }
      );
      expect(res.status).toBe(403);
      expect(res.json.error).toBe('Only a person can change those settings');
      expect(['operator_only_config', 'operator_cookie_required']).toContain(res.json.code);
      expect(readFileSync(configFile()).equals(before)).toBe(true);
    });

    it('refuses a mixed patch whole, and writes nothing', async () => {
      const before = readFileSync(configFile());
      const res = await send(
        {
          method: 'PATCH',
          path: '/api/config',
          body: { ui: { theme: 'dark' }, tunnel: { authtoken: 'planted' } },
        },
        { authorization: `Bearer ${apiKey}` }
      );
      expect(res.status).toBe(403);
      expect(readFileSync(configFile()).equals(before)).toBe(true);
    });

    it('lets the owner’s session make the same change', async () => {
      const res = await send(
        {
          method: 'PATCH',
          path: '/api/config',
          body: { ui: { theme: 'dark' }, tunnel: { authtoken: 'planted' } },
        },
        { origin: server!.baseUrl, ...person }
      );
      expect(res.status).toBe(200);
      expect(JSON.parse(readFileSync(configFile(), 'utf8')).tunnel.authtoken).toBe('planted');
    });
  });
});
