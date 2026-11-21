/**
 * The writes-back switch's routes (DOR-4794): owner only, offered only for apps whose changes stay
 * inside the team's own workspace (Linear today), and refused for any other app before anyone is
 * asked to confirm (Security, Must 1). Turning it off is always allowed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import {
  connections,
  connectorProviderInstances,
  createDb,
  eq,
  runMigrations,
  type Db,
} from '@dorkos/db';
import { initConfigManager } from '../../services/core/config-manager.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { createConnectorWritesBackRoutes } from '../connector-writes-back.js';

const OWNER = { kind: 'local_install', installationId: 'install-a' } as const;
const NOW = '2026-11-19T12:00:00.000Z';
const fixtureTarget = swappableServer();
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-writes-back-'));
beforeAll(() => {
  initConfigManager(configDir);
});
afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('writes-back routes', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    db.insert(connectorProviderInstances)
      .values({
        id: 'provider-a',
        type: 'fake',
        mode: 'byo',
        displayName: 'Fake',
        custody: 'self-host',
        capabilityJson: '{}',
        ownerKind: 'local_install',
        ownerId: OWNER.installationId,
        status: 'available',
        createdAt: NOW,
        updatedAt: NOW,
      })
      .run();
    for (const [id, toolkit] of [
      ['tracker', 'linear'],
      ['mail', 'gmail'],
    ] as const) {
      db.insert(connections)
        .values({
          id,
          providerInstanceId: 'provider-a',
          externalAccountRef: `ref-${id}`,
          toolkit,
          label: 'Work',
          status: 'active',
          createdAt: NOW,
          updatedAt: NOW,
        })
        .run();
    }
  });

  function app() {
    return fixtureTarget.mount(
      honoGroupListener({
        path: '/api/connectors',
        routes: createConnectorWritesBackRoutes({
          db,
          resolveOwner: () => OWNER,
          loginEnabled: () => false,
          trustedOrigins: () => ['http://localhost:4242'],
          now: () => new Date(NOW),
        }),
      })
    );
  }

  const column = (id: string) =>
    db.select().from(connections).where(eq(connections.id, id)).get()?.writesBackUnasked;

  it('says which apps the switch is offered for', async () => {
    const tracker = await request(app()).get('/api/connectors/connections/tracker/writes-back');
    expect(tracker.body).toMatchObject({ supported: true, writesBackUnasked: false });
    const mail = await request(app()).get('/api/connectors/connections/mail/writes-back');
    expect(mail.body).toMatchObject({ supported: false });
  });

  it('turns it on for Linear', async () => {
    await request(app())
      .put('/api/connectors/connections/tracker/writes-back')
      .send({ writesBackUnasked: true, confirmsNoOutsideSync: true })
      .expect(200);
    expect(column('tracker')).toBe(true);
  });

  // Red without the app list: a Gmail write is a send, and the switch would let it run unasked.
  it('refuses to turn it on for Gmail, and changes nothing', async () => {
    const res = await request(app())
      .put('/api/connectors/connections/mail/writes-back')
      .send({ writesBackUnasked: true, confirmsNoOutsideSync: true })
      .expect(422);
    expect(res.body.code).toBe('writes_back_unsupported_app');
    expect(column('mail')).toBe(false);
  });

  it('still lets the owner turn it off for an app off the list', async () => {
    db.update(connections).set({ writesBackUnasked: true }).where(eq(connections.id, 'mail')).run();
    await request(app())
      .put('/api/connectors/connections/mail/writes-back')
      .send({ writesBackUnasked: false })
      .expect(200);
    expect(column('mail')).toBe(false);
  });

  it('refuses an agent', async () => {
    await request(app())
      .put('/api/connectors/connections/tracker/writes-back')
      .set('X-DorkOS-Agent', 'agent-a')
      .send({ writesBackUnasked: true, confirmsNoOutsideSync: true })
      .expect(403);
    expect(column('tracker')).toBe(false);
  });
});
