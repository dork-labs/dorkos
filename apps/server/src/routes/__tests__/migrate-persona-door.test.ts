/**
 * `POST /api/agents/current/migrate-persona` on the capability mount
 * (`agent.migrate_persona`, DOR-4978): a person's door. An agent, even for its
 * own home, and a program are refused before anything is written. Over real
 * folders on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { MiddlewareHandler } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { writeManifest } from '@dorkos/shared/manifest';
import { readConventionFile } from '@dorkos/shared/convention-files-io';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

import { initBoundary } from '../../lib/boundary.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { personaMoveGroup } from './persona-move-group.js';
import type { ApiEnv } from '../../http/api-chain.js';
import type { AgentIdentity } from '../../services/core/agent-identity/agent-identity-service.js';
import {
  clearTestHomes,
  registerEveryFolderAsHome,
} from '../../services/core/agent-identity/__tests__/agent-home-fixture.js';

const target = swappableServer();
let root: string;
let scout: string;

/** A registered agent with an old persona and no SOUL.md yet. */
function manifestOf(id: string, name: string): AgentManifest {
  return {
    id,
    name,
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-11-25T00:00:00.000Z',
    registeredBy: 'dorkos-ui',
    personaEnabled: true,
    persona: `${name}’s old persona.`,
    mcpServers: [],
    workspace: { mode: 'home' },
  };
}

/** Serve the doors, standing in for the chain having resolved `identity` when given. */
function serve(identity?: AgentIdentity) {
  const before: MiddlewareHandler<ApiEnv> = async (c, next) => {
    if (identity) c.set('agentIdentity', identity);
    await next();
  };
  return target.mount(honoGroupListener(personaMoveGroup(), { before }));
}

/** An agent's identity, as its token resolves. */
function as(home: string): AgentIdentity {
  return { agentPath: home, displayName: 'Scout', createdAt: '2026-11-25T00:00:00.000Z' };
}

beforeEach(async () => {
  registerEveryFolderAsHome();
  root = mkdtempSync(join(tmpdir(), 'agent-home-doors-'));
  // The real boundary and config, both inside the scratch folder.
  await initBoundary(root);
  initConfigManager(join(root, '.dork'));
  scout = join(root, 'scout');
  await writeManifest(scout, manifestOf('agent-scout', 'scout'));
});

afterEach(() => {
  clearTestHomes();
  rmSync(root, { recursive: true, force: true });
});

describe('POST /api/agents/current/migrate-persona', () => {
  it('refuses an agent, even for its own home, and a program, writing nothing', async () => {
    const agent = await request(serve(as(scout)))
      .post('/api/agents/current/migrate-persona')
      .query({ path: scout });
    const program = await request(serve())
      .post('/api/agents/current/migrate-persona')
      .query({ path: scout })
      .set('Authorization', 'Bearer some-key');
    for (const res of [agent, program]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('person_only');
    }
    expect(await readConventionFile(scout, 'SOUL.md')).toBeNull();
  });

  it('moves a person’s agent’s old persona into SOUL.md, once', async () => {
    const server = serve();
    const first = await request(server)
      .post('/api/agents/current/migrate-persona')
      .query({ path: scout });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ migrated: true });
    expect(await readConventionFile(scout, 'SOUL.md')).toContain('scout’s old persona.');
    const again = await request(server)
      .post('/api/agents/current/migrate-persona')
      .query({ path: scout });
    expect(again.body).toEqual({ migrated: false, reason: 'SOUL.md already exists' });
  });

  it('asks for the folder in the hand route’s words when none is sent', async () => {
    const res = await request(serve()).post('/api/agents/current/migrate-persona');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      code: 'invalid_request',
      detail: '`path`: Send the agent’s folder as `path`.',
    });
  });

  it('answers a folder outside the boundary in the hand route’s words', async () => {
    const res = await request(serve())
      .post('/api/agents/current/migrate-persona')
      .query({ path: tmpdir() });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'outside_boundary',
      detail: 'Pick a folder inside the ones DorkOS may use.',
    });
  });

  it('answers 404 for a folder no agent lives in', async () => {
    const res = await request(serve())
      .post('/api/agents/current/migrate-persona')
      .query({ path: root });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      code: 'not_found',
      detail: 'No agent is registered in that folder.',
    });
  });
});
