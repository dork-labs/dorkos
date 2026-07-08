import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createTerminalRouter } from '../terminal.js';
import {
  TerminalManager,
  type PtyLike,
  type SpawnPtyOptions,
} from '../../services/terminal/index.js';

/**
 * Terminal REST route tests. The routes are the auth-gated entry point that
 * mints PTY ids, so their validation + error mapping is covered: bad body 400,
 * boundary-escape cwd 403, over-cap 429, happy 201, and teardown 204.
 */

/** Minimal mock PTY so the routes never spawn a real shell. */
function mockSpawn(_opts: SpawnPtyOptions): PtyLike {
  return {
    pid: 1,
    onData() {},
    onExit() {},
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
}

describe('terminal routes', () => {
  let boundary: string;
  let app: Express;

  beforeEach(() => {
    boundary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term-route-')));
    const manager = new TerminalManager({
      spawn: mockSpawn,
      boundary,
      idleTimeoutMs: 60_000,
      maxTerminals: 1,
    });
    app = express();
    app.use(express.json());
    app.use('/api/terminal', createTerminalRouter(manager));
  });

  it('returns 400 for a missing/invalid body', async () => {
    const res = await request(app).post('/api/terminal').send({});
    expect(res.status).toBe(400);
  });

  it('returns 403 when cwd escapes the boundary', async () => {
    const res = await request(app).post('/api/terminal').send({ cwd: '/etc' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('OUTSIDE_BOUNDARY');
  });

  it('returns 201 with an id for a valid cwd', async () => {
    const res = await request(app).post('/api/terminal').send({ cwd: boundary });
    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe('string');
  });

  it('returns 429 once the concurrency cap is reached', async () => {
    await request(app).post('/api/terminal').send({ cwd: boundary }).expect(201);
    const res = await request(app).post('/api/terminal').send({ cwd: boundary });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('TERMINAL_LIMIT');
  });

  it('returns 204 on teardown (idempotent)', async () => {
    const created = await request(app).post('/api/terminal').send({ cwd: boundary });
    const id = created.body.id as string;
    await request(app).delete(`/api/terminal/${id}`).expect(204);
    // Deleting an unknown id is still a clean 204 (idempotent).
    await request(app).delete('/api/terminal/nonexistent').expect(204);
  });
});
