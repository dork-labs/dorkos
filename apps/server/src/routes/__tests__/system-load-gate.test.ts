/**
 * `/api/system/load-gate` (DOR-4209): only a person at this computer sees the
 * line of waiting heavy jobs or changes it, and each change is recorded.
 * Driven through the real `/api` chain, over a real load gate on a temp folder
 * with the machine held busy, so every job waits.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import type { LoadGateSettings } from '@dorkos/shared/config-schema';
import type { ApiEnv } from '../../http/api-chain.js';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { createLoadGate, type LoadGate } from '../../services/core/load-gate/load-gate.js';
import { fixedLoadSource } from '../../services/core/load-gate/load-source.js';
import { TicketQueue } from '../../services/core/load-gate/ticket-queue.js';
import { markIngress } from '../../services/core/remote/ingress-mark.js';
import { mountLoadGateRoutes } from '../system-load-gate.js';

const SETTINGS: LoadGateSettings = {
  enabled: true,
  maxLoad: 16,
  slots: 1,
  maxWaitMinutes: 60,
  hardCapMinutes: 240,
  heavyCommands: { add: [], remove: [] },
};
const UNKNOWN_ID = '0123456789abcdef';

const target = swappableServer();
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-load-gate-routes-config-'));
beforeAll(() => {
  initConfigManager(configDir);
});
afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
});

let dir: string;
let gate: LoadGate;
let stop: AbortController;
const audit = vi.fn();

/** A pause that lasts until the test stops the wait, so every job stays in line. */
const sleepUntilStopped = (_ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), {
      once: true,
    });
  });

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(async () => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-load-gate-routes-'));
  stop = new AbortController();
  gate = createLoadGate({
    config: () => SETTINGS,
    dir,
    loadSource: fixedLoadSource(99),
    sleep: sleepUntilStopped,
    log: () => {},
  });
  const router = new Hono<ApiEnv>();
  mountLoadGateRoutes(router, { gate: () => gate, audit });
  target.mount(honoGroupListener({ path: '/api/system', routes: router }));
  // Swallowed: each wait rejects once the test stops it.
  gate
    .waitForSlot(
      { job: 'pnpm', agentName: 'Scout', chatTitle: 'Fix login' },
      { signal: stop.signal }
    )
    .catch(() => {});
  await settle();
  // A job another DorkOS app on this computer queued: in the folder, not in this server's memory.
  new TicketQueue({ dir }).enqueue({ job: 'tsc' });
});

afterEach(() => {
  stop.abort();
  fs.rmSync(dir, { recursive: true, force: true });
});

const list = async () => (await request(target.server).get('/api/system/load-gate/waiting')).body;
const act = (id: string, action: string) =>
  request(target.server).post(`/api/system/load-gate/jobs/${id}/${action}`).send({});
/** Every mark in the folder, by name. */
const marks = () => fs.readdirSync(dir).filter((name) => /^(urgent|front|let-through)-/.test(name));

describe('GET /api/system/load-gate/waiting', () => {
  it('lists the waiting jobs for a person, naming only what this server queued', async () => {
    const response = await request(target.server).get('/api/system/load-gate/waiting');
    expect(response.status).toBe(200);
    const [mine, theirs] = response.body.jobs;
    expect(mine).toMatchObject({
      position: 1,
      ownedHere: true,
      agentName: 'Scout',
      chatTitle: 'Fix login',
      label: 'pnpm',
      urgent: false,
      front: false,
      letThrough: false,
    });
    expect(theirs).toMatchObject({ position: 2, ownedHere: false, label: 'tsc' });
    expect(theirs).not.toHaveProperty('agentName');
    expect(theirs).not.toHaveProperty('chatTitle');
  });
});

describe('a person’s actions', () => {
  it('marks a job urgent, ahead of the normal ones, and records it', async () => {
    const theirs = (await list()).jobs[1];
    const response = await act(theirs.id, 'urgent');
    expect(response.status).toBe(200);
    expect(response.body.jobs.map((job: { id: string }) => job.id)[0]).toBe(theirs.id);
    expect(response.body.jobs[0]).toMatchObject({ urgent: true, position: 1 });
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0]![0]).toEqual({
      action: 'load-gate.urgent',
      operation: 'modify',
      outcome: 'ok',
      target: { type: 'load-gate-job', id: theirs.id },
      summary: 'Marked a waiting heavy job urgent',
      source: { surface: 'app' },
    });
  });

  it('moves a job to the front, ahead of an urgent one too', async () => {
    const [mine, theirs] = (await list()).jobs;
    await act(theirs.id, 'urgent');
    const response = await act(mine.id, 'front');
    expect(response.status).toBe(200);
    expect(response.body.jobs[0]).toMatchObject({ id: mine.id, front: true });
    expect(audit.mock.calls[1]![0]).toMatchObject({
      action: 'load-gate.move-to-front',
      summary: 'Moved Scout’s waiting heavy job to the front of the line',
    });
  });

  it('lets a job through, and the job runs on its next check', async () => {
    const [mine] = (await list()).jobs;
    const response = await act(mine.id, 'let-through');
    expect(response.status).toBe(200);
    expect(response.body.jobs[0]).toMatchObject({ id: mine.id, letThrough: true });
    expect(audit.mock.calls[0]![0]).toMatchObject({
      action: 'load-gate.let-through',
      target: { type: 'load-gate-job', id: mine.id },
      summary: 'Let Scout’s waiting heavy job run now',
    });
  });

  it('refuses an id that cannot be a job’s, writing nothing', async () => {
    const response = await act('NOT-A-JOB', 'urgent');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('invalid_id');
    expect(marks()).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it('answers 404 for a job that is not waiting, writing nothing', async () => {
    const response = await act(UNKNOWN_ID, 'let-through');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('not_found');
    expect(marks()).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe('who can reach the line at all', () => {
  /** Server source outside tests that names the list or an action, by file. */
  function callers(): string[] {
    const src = path.resolve(__dirname, '../..');
    const files = fs.readdirSync(src, { recursive: true }) as string[];
    return files
      .filter((file) => file.endsWith('.ts') && !file.includes('__tests__'))
      .filter((file) =>
        /\.(waitingJobs|letThrough|markUrgent|moveToFront)\(|waitingLineForPerson\(/.test(
          fs.readFileSync(path.join(src, file), 'utf8')
        )
      )
      .map((file) => file.split(path.sep).join('/'))
      .sort();
  }

  it('is read and changed only by the gate itself and the person’s routes: no agent tool', () => {
    expect(callers().filter((file) => !file.startsWith('services/core/load-gate/'))).toEqual([
      'routes/system-load-gate.ts',
    ]);
  });
});

describe('anyone but a person at this computer', () => {
  it.each([
    ['an agent', { 'x-dorkos-agent': 'agent-a' }],
    ['another site', { origin: 'https://elsewhere.example' }],
  ])('refuses %s on every route, and nothing changes', async (_who, headers) => {
    const [mine] = (await list()).jobs;
    const before = await list();
    const read = await request(target.server).get('/api/system/load-gate/waiting').set(headers);
    expect(read.status).not.toBe(200);
    expect(read.body).not.toHaveProperty('jobs');
    for (const action of ['let-through', 'urgent', 'front']) {
      const response = await request(target.server)
        .post(`/api/system/load-gate/jobs/${mine.id}/${action}`)
        .set(headers)
        .send({});
      expect(response.status, action).not.toBe(200);
    }
    expect(marks()).toEqual([]);
    expect(await list()).toEqual(before);
    expect(audit).not.toHaveBeenCalled();
  });

  it('refuses another device on every route, and nothing changes', async () => {
    const before = await list();
    const [mine] = before.jobs;
    // The real mark the tunnel puts on a request from a phone or another computer.
    const router = new Hono<ApiEnv>();
    mountLoadGateRoutes(router, { gate: () => gate, audit });
    const listener = honoGroupListener({ path: '/api/system', routes: router });
    target.mount((incoming, response) => {
      markIngress(incoming, 'managed');
      listener(incoming, response);
    });
    const read = await request(target.server).get('/api/system/load-gate/waiting');
    expect([401, 403]).toContain(read.status);
    expect(read.body).not.toHaveProperty('jobs');
    for (const action of ['let-through', 'urgent', 'front']) {
      const response = await request(target.server)
        .post(`/api/system/load-gate/jobs/${mine.id}/${action}`)
        .send({});
      expect([401, 403], action).toContain(response.status);
    }
    expect(marks()).toEqual([]);
    expect(gate.waitingJobs().map((job) => job.id)).toEqual(
      before.jobs.map((job: { id: string }) => job.id)
    );
    expect(audit).not.toHaveBeenCalled();
  });
});
