/**
 * `GET /api/links/target` over HTTP (DOR-5046): the generic capability mount
 * behind the real API chain, with the real session read rule. A chat that is
 * not there and a person's chat an agent may not read answer the same 404,
 * byte for byte, so the answer never tells one from the other.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';

import { initConfigManager } from '../../services/core/config-manager.js';

// The real config and the real session gate. Sign-in is off, so a request
// from this computer passes the gate.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-link-target-'));
initConfigManager(configDir);
afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { composeRegistry } from '../../services/core/capabilities/index.js';
import type { AgentIdentity } from '../../services/core/agent-identity/index.js';
import {
  initSessionVisibility,
  resetSessionVisibility,
} from '../../services/audit/session-visibility.js';
import { RoomError } from '../../services/rooms/room-errors.js';
import { linkDomain } from '../../services/core/links/link-capabilities.js';
import { createDorkLinkLookups } from '../../services/core/links/link-lookups.js';
import { createCapabilityHttpRoutes } from '../capability-http.js';

const PERSONS_CHAT = '0e5b3c1a-2222-4aaa-8bbb-000000000002';
const MISSING_CHAT = '0e5b3c1a-9999-4aaa-8bbb-000000000009';

const ANA: AgentIdentity = {
  agentPath: '/agents/ana',
  displayName: 'Ana',
  createdAt: '2026-11-24T12:00:00.000Z',
};

const registry = composeRegistry([linkDomain], {
  logger: noopLogger,
  linkDeps: {
    lookups: createDorkLinkLookups({
      db: createTestDb(),
      // No rooms in this test: every room caller is refused.
      rooms: { getRoom: () => null, readEntry: () => null },
      roomCaller: () => {
        throw new RoomError('UNIDENTIFIED_CALLER', 'No rooms here.');
      },
      chatExists: async (id) => id === PERSONS_CHAT,
    }),
  },
});

/** Who the chain resolved: nobody (the person at this computer), or Ana. */
let caller: AgentIdentity | undefined;
const server = listeningServer(
  honoGroupListener(
    {
      path: '/',
      routes: createCapabilityHttpRoutes({
        registry: () => registry,
        capabilities: linkDomain.capabilities,
      }),
    },
    {
      // Stands in for the identity the chain's agent middleware would resolve.
      before: (c, next) => {
        if (caller) c.set('agentIdentity', caller);
        return next();
      },
    }
  )
);

describe('GET /api/links/target', () => {
  beforeEach(() => {
    caller = undefined;
    initSessionVisibility(
      (ids) => new Map(ids.filter((id) => id === PERSONS_CHAT).map((id) => [id, 'participants']))
    );
  });

  afterEach(() => {
    resetSessionVisibility();
  });

  /** Ask for a link, as the app's `/r/` route does. */
  function target(uri: string) {
    return request(server).get('/api/links/target').query({ uri });
  }

  it('opens a person’s own chat for that person', async () => {
    const res = await target(`dork:chat:${PERSONS_CHAT}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'chat', sessionId: PERSONS_CHAT });
  });

  it('answers a missing chat and a chat the caller may not read with the same bytes', async () => {
    caller = ANA;
    const forbidden = await target(`dork:chat:${PERSONS_CHAT}`);
    const missing = await target(`dork:chat:${MISSING_CHAT}`);
    const malformed = await target('dork:acme/owl');

    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(forbidden.text).toBe(missing.text);
    expect(malformed.text).toBe(missing.text);
    expect(forbidden.headers['content-type']).toBe(missing.headers['content-type']);
    expect(forbidden.headers['content-length']).toBe(missing.headers['content-length']);
  });
});
