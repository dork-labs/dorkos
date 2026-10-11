/**
 * `GET /api/agents/:id/heartbeat` (spec `heartbeats` §7.6): what the Heartbeat
 * page reads, over a real heartbeat store and a real HEARTBEAT.md on disk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createTestDb } from '@dorkos/test-utils/db';
import { HeartbeatStatusSchema } from '@dorkos/shared/heartbeat-schemas';
import { createHeartbeatRouter } from '../heartbeats.js';
import { HeartbeatStore } from '../../services/heartbeats/heartbeat-store.js';
import { heartbeatStatus } from '../../services/heartbeats/heartbeat-status.js';

const target = swappableServer();
let root: string;
let store: HeartbeatStore;
let enabled: boolean;
let owner: boolean;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'heartbeat-route-'));
  await mkdir(join(root, '.dork'), { recursive: true });
  store = new HeartbeatStore(createTestDb());
  enabled = true;
  owner = true;
  const agent = { id: 'agent-juno', name: 'Juno', runtime: 'doe', projectPath: root };
  const app = express();
  app.use(
    '/api/agents/:id/heartbeat',
    createHeartbeatRouter({
      isOwner: () => owner,
      status: (agentId, viewerIsOwner) =>
        heartbeatStatus({
          viewerIsOwner,
          agent: agentId === agent.id ? agent : undefined,
          store,
          runner: { nextBeatAt: () => new Date('2026-10-12T15:00:00Z') },
          enabled,
          runtimeRegistered: (runtime) => runtime === 'doe',
          isAgent: (id) => id.startsWith('agent-'),
        }),
    })
  );
  target.mount(app);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('GET /api/agents/:id/heartbeat', () => {
  it('answers how the agent wakes, its next beat, its last beats and what is held for people', async () => {
    await writeFile(
      join(root, '.dork', 'HEARTBEAT.md'),
      '---\nwake: timed\n---\n- Watch invoices.'
    );
    store.insertBeat({
      id: 'b1',
      agentId: 'agent-juno',
      startedAt: '2026-10-12T14:00:00Z',
      kind: 'pulse',
      wake: 'timer',
    });
    store.finishBeat('b1', {
      outcome: 'worked',
      summary: 'Answered Dorian.',
      turnSessionId: 'beat-chat-1',
    });
    const held = {
      agentId: 'agent-juno',
      beatId: 'b1',
      rung: 'dm' as const,
      text: 'Acme paid.',
      key: 'k',
      about: null,
      urgent: 0,
      roomId: null,
      deliverAfter: '2026-10-13T13:00:00Z',
      state: 'held' as const,
      createdAt: '2026-10-12T14:00:00Z',
    };
    store.insertOutbox({ ...held, id: 'o1', toAccount: 'acct-owner' });
    store.insertOutbox({ ...held, id: 'o2', toAccount: 'agent-otto' });

    const res = await request(target.server).get('/api/agents/agent-juno/heartbeat');
    expect(res.status).toBe(200);
    const body = HeartbeatStatusSchema.parse(res.body);
    expect(body).toMatchObject({
      enabled: true,
      wake: 'timed',
      nextBeatAt: '2026-10-12T15:00:00.000Z',
      skippedReason: null,
    });
    expect(body.lastBeats).toMatchObject([
      { id: 'b1', outcome: 'worked', summary: 'Answered Dorian.', sessionId: 'beat-chat-1' },
    ]);
    expect(body.held).toMatchObject([{ id: 'o1', text: 'Acme paid.' }]);

    // Anyone else sees that something is held, not what it says, nor the chat.
    owner = false;
    const member = HeartbeatStatusSchema.parse(
      (await request(target.server).get('/api/agents/agent-juno/heartbeat')).body
    );
    expect(member.held).toMatchObject([{ id: 'o1', text: null }]);
    expect(member.lastBeats[0]!.sessionId).toBeNull();
  });

  it('says why the settings at the top of HEARTBEAT.md do not read, and shows the last good ones', async () => {
    store.patchState('agent-juno', { lastValidFrontmatter: JSON.stringify({ wake: 'timed' }) });
    await writeFile(join(root, '.dork', 'HEARTBEAT.md'), '---\nwake: often\n---\n- Watch.');
    const res = await request(target.server).get('/api/agents/agent-juno/heartbeat');
    expect(res.body.fileError).toMatch(/^wake: /);
    expect(res.body.wake).toBe('timed');
  });

  it('says why it does not beat when heartbeats are off, and wakes on events with no file', async () => {
    enabled = false;
    const res = await request(target.server).get('/api/agents/agent-juno/heartbeat');
    expect(res.body).toMatchObject({
      enabled: false,
      wake: 'events',
      skippedReason: 'Heartbeats are off.',
    });
  });

  it('answers 404 for an agent that does not exist', async () => {
    const res = await request(target.server).get('/api/agents/nobody/heartbeat');
    expect(res.status).toBe(404);
  });
});
