/**
 * The owner's sign-in on a Wi-Fi device not let run agents (DOR-5070) gives an agent no work
 * (Security, 2026-11-25): every promise is an agent's, and a change or a Not yet can wake it, so
 * the promise doors refuse that device `person_only` with one fixed sentence. A real owner account
 * backs the check, as the Wi-Fi hold reads it; `todo-promises.test.ts` keeps the install with no
 * owner, where the same Wi-Fi request is no held device and behaves as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { todos, user, eq, type Db } from '@dorkos/db';
import { initAuth } from '../../services/core/auth/index.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { capabilityGroup } from '../../http/__tests__/capability-group.js';
import { todoPromiseWriteDomain } from '../../services/todos/todo-write-capabilities.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { TodoPromiseService, TodoPromiseStore } from '../../services/todos/index.js';
import { TodoConfirm } from '../../services/todos/notice/todo-confirm.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import type { CapabilityRequestFacts } from '../../services/core/capabilities/index.js';

const fixtureTarget = swappableServer();
const fixtureServer = fixtureTarget.server;

/** The one sentence a held device reads, whatever it asked. */
const HELD = 'Give an agent work at this computer, or let this device run agents.';

describe("an agent's promise from a held Wi-Fi device", () => {
  let db: Db;
  let service: TodoPromiseService;
  let confirm: TodoConfirm;
  let authHome: string;

  beforeEach(() => {
    db = createTestDb();
    authHome = mkdtempSync(join(tmpdir(), 'dorkos-promises-held-'));
    // The real config and auth stores, in a throwaway home: the host guard reads the one, the
    // Wi-Fi hold the other.
    initConfigManager(authHome);
    initAuth(db, authHome);
    db.insert(user)
      .values({
        id: 'user_owner',
        name: 'Owner',
        email: 'owner@promises.test',
        createdAt: new Date(1),
        updatedAt: new Date(1),
      })
      .run();
    service = new TodoPromiseService({ store: new TodoPromiseStore(db) });
    confirm = new TodoConfirm({
      store: new TodoPromiseStore(db),
      reopen: (actor, id, note) => service.update(actor, id, { state: 'open', note, from: 'kept' }),
      wakeNow: (id) => service.wakeNow(id),
    });
    const deps = {
      // The production checks: each reads the mount's own answer for the request.
      isOwner: (facts: CapabilityRequestFacts) => facts.accountOwner,
      personProven: (facts: CapabilityRequestFacts) => facts.ownerProven,
      ownerExists: () => true,
      confirm,
      service,
    };
    const app = honoGroupListener(
      [capabilityGroup(todoPromiseWriteDomain, { todoPromiseWriteDeps: deps })],
      {
        // Stand in for the Wi-Fi listener and the session gate: the owner's own sign-in, on a
        // Wi-Fi device they did not let run agents.
        before: (c, next) => {
          markIngress(c.env.incoming, 'wifi');
          c.set('user', {
            userId: 'user_owner',
            credential: 'cookie',
            sessionId: 'phone',
            route: 'wifi',
          });
          return next();
        },
      }
    );
    fixtureTarget.mount(app);
  });

  afterEach(() => {
    service.stop();
    rmSync(authHome, { recursive: true, force: true });
  });

  function power(id: string) {
    return db
      .select({ authority: todos.authority, marks: todos.authorityMarks })
      .from(todos)
      .where(eq(todos.id, id))
      .get();
  }

  it('is refused closing, reopening or moving one', async () => {
    const given = service.create(
      'agent-ana',
      { what: 'Ship it' },
      { kind: 'person', proven: true }
    );
    const dueAt = new Date(Date.now() + 86_400_000).toISOString();
    for (const change of [
      { state: 'dropped', note: 'Not needed' },
      { state: 'open', dueAt },
    ]) {
      const res = await request(fixtureServer).patch(`/api/todo-promises/${given.id}`).send(change);
      expect(res.status, JSON.stringify(change)).toBe(403);
      expect(res.body).toMatchObject({ code: 'person_only', detail: HELD });
    }
    expect(service.get(given.id)).toMatchObject({ state: 'open', dueAt: null });
    expect(power(given.id)).toEqual({ authority: 'person', marks: '{}' });
  });

  it('is refused answering whether a kept one was kept: its Not yet would wake the agent', async () => {
    const kept = service.create('agent-ana', { what: 'Send the deck', to: 'owner' });
    service.update({ kind: 'agent', agentId: 'agent-ana' }, kept.id, { state: 'kept' });
    expect(confirm.ask(kept.id)).toBe(true);
    for (const answer of ['not-yet', 'yes']) {
      const res = await request(fixtureServer)
        .put(`/api/todo-promises/${kept.id}/confirmation`)
        .send({ answer });
      expect(res.status, answer).toBe(403);
      expect(res.body).toMatchObject({ code: 'person_only', detail: HELD });
    }
    expect(service.get(kept.id)).toMatchObject({ state: 'kept', confirmState: 'asked' });
  });
});
