/**
 * The `front-door` confirm-first bar on the mount (DOR-4978), with Security's
 * four conditions (t1j, 2026-11-25), each with its own test. Driven through
 * `mcp.add_global_server` (`POST /api/mcp-servers`) behind the real chain, a
 * real owner account, real sign-ins on each ingress and the real step-up routes.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { user } from '@dorkos/db';
import type { AccountIds } from '../../services/audit/account-ids.js';
import type { AuditLog } from '../../services/audit/audit-log.js';
import { initAuditTrail, resetAuditTrail } from '../../services/audit/audit-trail.js';
import { createHash } from 'node:crypto';
import {
  resetHeldStepUpsForTests,
  takeHeldStepUp,
} from '../../services/core/auth/step-up/step-up-holds.js';
import {
  CapabilityToolError,
  sealHeldState,
} from '../../services/core/capabilities/capability-definition.js';
import { logger } from '../../lib/logger.js';
import { globalMcpStoreRefusal } from '../../services/mesh/global-mcp/global-mcp-capability-support.js';
import type { RequestFacts } from '../../http/request-facts.js';
import { CONFIRM_ANOTHER_WAY } from '../front-door-step-up.js';
import { capabilityGroup } from '../../http/__tests__/capability-group.js';
import type { CredentialStore } from '../../services/core/credential-provider.js';
import { addGlobalServerCapability } from '../../services/mesh/global-mcp/global-mcp-write-capabilities.js';
import { globalMcpPersonDomain } from '../../services/mesh/global-mcp/global-mcp-person-capabilities.js';
import {
  GlobalMcpStore,
  GlobalMcpStoreError,
} from '../../services/mesh/global-mcp/global-mcp-store.js';
import { GlobalMcpToolLedger } from '../../services/mesh/global-mcp/global-mcp-tools.js';
import { frontDoorStepUpHarness } from './front-door-step-up-harness.js';

const PATH = '/api/mcp-servers';
const ENV_SECRET = 'made-up-env-secret-value';
const HEADER_SECRET = 'made-up-header-secret-value';

const home = mkdtempSync(path.join(tmpdir(), 'confirm-front-door-'));
const held = new Map<string, string>();
const secrets: CredentialStore = {
  put: async (name, secret) => (held.set(name, secret), `file:${name}`),
  get: async (name) => held.get(name) ?? null,
  delete: async (name) => void held.delete(name),
};
const store = new GlobalMcpStore(home, secrets);
const owner = frontDoorStepUpHarness(() => [
  capabilityGroup(globalMcpPersonDomain, {
    globalMcpPersonDeps: { store, ledger: new GlobalMcpToolLedger(home), agents: () => [] },
  }),
]);
afterAll(() => {
  resetAuditTrail();
  rmSync(home, { recursive: true, force: true });
});

/** Every row the audit trail was asked to keep, in order. */
let audited: Array<{ action: string; target?: unknown; outcome?: string; summary?: string }> = [];

let serial = 0;
/** A stdio server with a secret env value, under a fresh name. */
function server() {
  serial += 1;
  return {
    name: `made-up-${serial}`,
    enabled: true,
    connection: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@made-up/server@1.0.0'],
      env: { MADE_UP_TOKEN: ENV_SECRET },
    },
  };
}

/** Ask to add a server from one ingress, and return the held action's id. */
async function hold(body: object = server()): Promise<string> {
  const res = await owner.call('post', PATH).send(body);
  expect(res.status).toBe(428);
  return res.body.heldActionId as string;
}

/** The rows the confirm-first hold itself recorded. */
function confirmFirstRows() {
  return audited.filter((row) => row.action.startsWith('capability.confirm-first.'));
}

beforeEach(() => {
  resetHeldStepUpsForTests();
  audited = [];
  // The real audit trail's entry point, with a log that only keeps what it was sent.
  initAuditTrail({
    log: {
      record: (row: (typeof audited)[number]) => (audited.push(row), row),
    } as never as AuditLog,
    // Every account the trail resolves is one made-up actor.
    accounts: new Proxy({}, { get: () => () => 'made-up-actor' }) as AccountIds,
  });
});

describe('Security’s four conditions for the front-door bar (DOR-4978, t1j)', () => {
  it('1. the bar is declared in the definition, never read from the input', async () => {
    expect(addGlobalServerCapability.confirmFirst?.bar).toBe('front-door');
    // A body that names another bar changes nothing: the hold and confirm record the declared one.
    const named = { ...server(), bar: 'account-owner', confirmFirst: { bar: 'account-owner' } };
    const done = await owner.confirm(await hold(named));
    expect(done.body).toMatchObject({ ok: true, status: 201 });
    const bars = confirmFirstRows().map((row) => /\(bar: ([a-z-]+)\)/.exec(row.summary ?? '')?.[1]);
    expect(bars).toEqual(['front-door', 'front-door']);
  });

  it.each(['own-tunnel', 'wifi'] as const)(
    '2. held at this computer, a confirmation over %s with the same session is refused, and nothing is written',
    async (via) => {
      const body = server();
      const id = await hold(body);
      const res = await owner
        .call('post', `/api/step-up/${id}/password`, via)
        .set('Cookie', owner.currentCookie('direct'))
        .send({ password: 'made-up-correct-horse-battery' });
      // The desk's session is refused off this computer before the confirm route runs.
      expect(res.status).toBe(401);
      expect(res.body.ok).not.toBe(true);
      expect(store.has(body.name)).toBe(false);
    }
  );

  it('2. the confirming request runs the bar on its own: the same session from Wi-Fi writes nothing', async () => {
    const body = server();
    const id = await hold(body);
    const action = takeHeldStepUp(id)!;
    // The real owner and the very session that asked: only the ingress fails.
    const result = await action.commit({
      headers: {},
      peerAddress: '192.0.2.10',
      forwardedAddress: '192.0.2.10',
      connectionEncrypted: false,
      ingress: 'wifi',
      user: {
        userId: owner.db().select().from(user).get()!.id,
        credential: 'cookie',
        sessionId: action.sessionId!,
      },
      agentIdentity: undefined,
      method: 'POST',
    });
    expect(result).toMatchObject({ status: 403, body: { code: 'operator_only' } });
    expect(store.has(body.name)).toBe(false);
  });

  it('2. the asking request runs the bar on its own: nothing is held from Wi-Fi', async () => {
    const body = server();
    const res = await owner.call('post', PATH, 'wifi').send(body);
    // Refused before any route, as the hand route was: this path acts only at this computer.
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('not_from_wifi');
    expect(res.body.heldActionId).toBeUndefined();
    expect(confirmFirstRows()).toEqual([]);
    expect(store.has(body.name)).toBe(false);
  });

  it('2. held and confirmed at this computer, it runs once', async () => {
    const body = server();
    const done = await owner.confirm(await hold(body));
    expect(done.body).toMatchObject({ ok: true, status: 201, result: { name: body.name } });
    expect(store.has(body.name)).toBe(true);
  });

  it('3. a secret in an env value or a header reaches no 428, sheet or audit row', async () => {
    const remote = {
      name: `made-up-remote-${serial}`,
      enabled: true,
      connection: {
        transport: 'http',
        url: 'https://mcp.example.test/made-up',
        headers: { Authorization: `Bearer ${HEADER_SECRET}` },
      },
    };
    const answers = [];
    for (const body of [server(), remote]) {
      const res = await owner.call('post', PATH).send(body);
      expect(res.status).toBe(428);
      const sheet = await owner.call('get', `/api/step-up/${res.body.heldActionId}`);
      answers.push(res.body, sheet.body);
      await owner.confirm(res.body.heldActionId as string);
    }
    const said = JSON.stringify([answers, audited]);
    expect(said).not.toContain(ENV_SECRET);
    expect(said).not.toContain(HEADER_SECRET);
    // The sentence names the server and its package, never an address or a program.
    expect(JSON.stringify(answers)).toContain(`Add ${remote.name} for all your agents.`);
  });

  it('4. the hold and the confirm are each audited with the capability id and the bar, never the input', async () => {
    const body = server();
    await owner.confirm(await hold(body));
    const rows = confirmFirstRows();
    expect(rows.map((row) => [row.action, row.target, row.outcome])).toEqual([
      ['capability.confirm-first.held', { type: 'capability', id: 'mcp.add_global_server' }, 'ok'],
      [
        'capability.confirm-first.confirmed',
        { type: 'capability', id: 'mcp.add_global_server' },
        'ok',
      ],
    ]);
    for (const row of rows) expect(row.summary).toContain('(bar: front-door)');
    const recorded = JSON.stringify(rows);
    for (const word of [body.name, ENV_SECRET, 'MADE_UP_TOKEN', '@made-up/server', 'npx']) {
      expect(recorded).not.toContain(word);
    }
  });

  it.each([
    ['an agent', { 'X-DorkOS-Agent': 'made-up-agent-token' }],
    ['a program with a key', { Authorization: 'Bearer dork_made_up' }],
  ])('no agent path: %s is refused person_only, and nothing is held', async (_who, headers) => {
    const body = server();
    const res = await owner.call('post', PATH).set(headers).send(body);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('person_only');
    expect(res.body.heldActionId).toBeUndefined();
    expect(store.has(body.name)).toBe(false);
  });
});

/** The confirming request's facts: the real owner and the very session that asked, over `ingress`. */
function confirmingVia(sessionId: string, ingress: RequestFacts['ingress']): RequestFacts {
  return {
    headers: {},
    peerAddress: '127.0.0.1',
    forwardedAddress: '127.0.0.1',
    connectionEncrypted: true,
    ingress,
    user: { userId: owner.db().select().from(user).get()!.id, credential: 'cookie', sessionId },
    agentIdentity: undefined,
    method: 'POST',
  } as RequestFacts;
}

describe('Security’s follow-ups (DOR-4978, t1j)', () => {
  it('a confirm must come the way its ask came: held here, the same session over the tunnel is refused by that check', async () => {
    const body = server();
    const action = takeHeldStepUp(await hold(body))!;
    const result = await action.commit(confirmingVia(action.sessionId!, 'own-tunnel'));
    // This check's own sentence, so neither the session gate nor the front-door bar refused it.
    expect(result).toMatchObject({ status: 403, body: { detail: CONFIRM_ANOTHER_WAY } });
    expect(store.has(body.name)).toBe(false);
  });

  it('held over the owner’s own tunnel, a confirm over the same tunnel runs', async () => {
    const body = server();
    const res = await owner.call('post', PATH, 'own-tunnel').send(body);
    expect(res.status).toBe(428);
    const done = await owner.confirm(res.body.heldActionId as string, 'own-tunnel');
    expect(done.body).toMatchObject({ ok: true, status: 201 });
    expect(store.has(body.name)).toBe(true);
  });

  it('the sheet names only the server and the runner’s package', async () => {
    const body = server();
    const res = await owner.call('post', PATH).send({
      ...body,
      connection: { ...body.connection, args: ['-y', '@made-up/server@1.0.0', '--made-up-arg'] },
    });
    const sheet = (await owner.call('get', `/api/step-up/${res.body.heldActionId}`)).body;
    expect(sheet.notes).toEqual([`Server: ${body.name}`, 'Package: @made-up/server@1.0.0']);
    expect(JSON.stringify(sheet)).not.toMatch(/npx|made-up-arg|MADE_UP_TOKEN/);
  });

  it('logs a store refusal by its code alone, never its message', () => {
    const debug = vi.spyOn(logger, 'debug');
    const message = 'made-up /made/up/agents-folder/run.sh MADE_UP_ENV_NAME';
    expect(() => globalMcpStoreRefusal(new GlobalMcpStoreError('unsafe_env', message))).toThrow(
      CapabilityToolError
    );
    const logged = JSON.stringify(debug.mock.calls);
    expect(logged).toContain('unsafe_env');
    for (const word of ['/made/up/agents-folder', 'run.sh', 'MADE_UP_ENV_NAME']) {
      expect(logged).not.toContain(word);
    }
    debug.mockRestore();
  });

  it('the held state is a keyed hash that never reaches the caller, and a change refuses the write', async () => {
    const body = server();
    await owner.confirm(await hold(body));
    const fingerprint = store.fingerprint(body.name);
    // Keyed: not the plain hash of what it seals.
    const sealed = sealHeldState(fingerprint);
    expect(sealed).not.toBe(createHash('sha256').update(fingerprint).digest('base64url'));
    expect(sealed).not.toBe(createHash('sha256').update(fingerprint).digest('hex'));
    const asked = await owner.call('put', `${PATH}/${body.name}`).send(body);
    expect(asked.status).toBe(428);
    const sheet = (await owner.call('get', `/api/step-up/${asked.body.heldActionId}`)).body;
    for (const value of [fingerprint, sealed]) {
      expect(JSON.stringify([asked.body, sheet])).not.toContain(value);
    }
    // Changed while the sheet was up: refused, and the change is kept.
    await store.patch(body.name, { excludedAgents: ['made-up-agent'] });
    const done = await owner.confirm(asked.body.heldActionId as string);
    expect(done.body).toMatchObject({
      ok: true,
      status: 412,
      result: { code: 'precondition_failed' },
    });
    expect(store.list().find((s) => s.name === body.name)!.excludedAgents).toEqual([
      'made-up-agent',
    ]);
  });
});
