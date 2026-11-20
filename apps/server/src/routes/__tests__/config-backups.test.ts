/**
 * Settings → Backups routes (DOR-4253) through the real request chain: a
 * person at this computer lists, removes and moves older copies; an agent, an
 * approval token or another site is refused before anything is read; a Move
 * stays inside the directory boundary; a symlink is never followed. Real files
 * in a throwaway data folder; made-up data only.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { honoGroupListener } from '../../http/__tests__/hono-group-listener.js';
import { initBoundary } from '../../lib/boundary.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import { createConfigBackupsRoutes } from '../config-backups.js';

const server = swappableServer();
let root: string;
let home: string;
let backups: string;
let inside: string;
let outside: string;
/** Stands in for `/Volumes`, where macOS mounts external drives. */
let volumes: string;

const OLDER = 'dork-20260901-daily.db';
const OLDER_PRE = 'dork-20260815-101500-pre-0042_add_notes.db';
const MANAGED = 'dork-auto-20261119-daily.db';

/** A real, small SQLite copy. */
function sqliteCopy(file: string): void {
  const db = new Database(file);
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  db.prepare('INSERT INTO notes (body) VALUES (?)').run('made-up row');
  db.close();
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'config-backups-')));
  home = path.join(root, 'boundary', 'dork-home');
  backups = path.join(home, 'backups');
  inside = path.join(root, 'boundary', 'saved');
  outside = path.join(root, 'past-the-boundary');
  volumes = path.join(root, 'Volumes');
  for (const dir of [backups, inside, outside, volumes]) fs.mkdirSync(dir, { recursive: true });
  vi.stubEnv('DORK_HOME', home);
  initConfigManager(home);
  configManager.set('auth', { enabled: false });
  await initBoundary(path.join(root, 'boundary'));
  server.mount(
    honoGroupListener({
      path: '/api/config/backups',
      routes: createConfigBackupsRoutes({ volumesRoot: volumes }),
    })
  );
  for (const name of [OLDER, OLDER_PRE, MANAGED]) sqliteCopy(path.join(backups, name));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('refuses every caller that is not a person', () => {
  const callers: Array<[string, Record<string, string>]> = [
    ['an agent', { 'x-dorkos-agent': 'agent-token' }],
    ['an approval token', { 'x-dorkos-approval': 'approval-token' }],
    ['another site', { origin: 'https://other.example' }],
    ['a program credential', { authorization: 'Bearer some-key' }],
  ];

  it.each(callers)('%s cannot list', async (_who, headers) => {
    const res = await request(server.server).get('/api/config/backups').set(headers);
    expect(res.status).toBe(403);
  });

  it.each(callers)('%s cannot remove or move, and nothing changes', async (_who, headers) => {
    const removed = await request(server.server)
      .delete(`/api/config/backups/${OLDER}`)
      .set(headers);
    const moved = await request(server.server)
      .post(`/api/config/backups/${OLDER}/move`)
      .set(headers)
      .send({ destination: inside });
    expect(removed.status).toBe(403);
    expect(moved.status).toBe(403);
    expect(fs.existsSync(path.join(backups, OLDER))).toBe(true);
    expect(fs.readdirSync(inside)).toEqual([]);
  });
});

describe('a person at this computer', () => {
  it('lists every copy with kind, management, size, time and the total', async () => {
    const res = await request(server.server).get('/api/config/backups');
    expect(res.status).toBe(200);
    expect(res.body.folder).toBe(backups);
    expect(res.body.copies.map((c: { name: string }) => c.name)).toEqual([
      MANAGED,
      OLDER,
      OLDER_PRE,
    ]);
    expect(res.body.copies[1]).toMatchObject({
      name: OLDER,
      kind: 'daily',
      managed: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      busy: false,
    });
    expect(res.body.totalBytes).toBeGreaterThan(0);
  });

  it('removes an older copy', async () => {
    const res = await request(server.server).delete(`/api/config/backups/${OLDER}`);
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(backups, OLDER))).toBe(false);
  });

  it('cannot remove a copy DorkOS manages', async () => {
    const res = await request(server.server).delete(`/api/config/backups/${MANAGED}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('managed');
    expect(fs.existsSync(path.join(backups, MANAGED))).toBe(true);
  });

  it('cannot reach outside the backup folder by name', async () => {
    sqliteCopy(path.join(home, 'dork.db'));
    for (const name of ['..%2Fdork.db', '%2E%2E', 'dork.db', 'notes.db']) {
      const res = await request(server.server).delete(`/api/config/backups/${name}`);
      expect(res.status).toBe(404);
    }
    expect(fs.existsSync(path.join(home, 'dork.db'))).toBe(true);
  });

  it('never follows a symlink in the backup folder', async () => {
    const target = path.join(inside, 'precious.db');
    sqliteCopy(target);
    fs.symlinkSync(target, path.join(backups, 'dork-20260903-daily.db'));
    const listed = await request(server.server).get('/api/config/backups');
    expect(listed.body.copies.map((c: { name: string }) => c.name)).not.toContain(
      'dork-20260903-daily.db'
    );
    expect(
      (await request(server.server).delete('/api/config/backups/dork-20260903-daily.db')).status
    ).toBe(404);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('moves an older copy into a folder inside the boundary, checked, original gone', async () => {
    const res = await request(server.server)
      .post(`/api/config/backups/${OLDER_PRE}/move`)
      .send({ destination: inside });
    expect(res.status).toBe(200);
    expect(res.body.destinationPath).toBe(path.join(inside, OLDER_PRE));
    expect(fs.existsSync(path.join(inside, OLDER_PRE))).toBe(true);
    expect(fs.existsSync(path.join(backups, OLDER_PRE))).toBe(false);
  });

  it('refuses a destination outside the boundary, and keeps the original', async () => {
    const res = await request(server.server)
      .post(`/api/config/backups/${OLDER}/move`)
      .send({ destination: outside });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('destination_outside');
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(backups, OLDER))).toBe(true);
  });

  it('refuses a symlinked destination that leads outside the boundary', async () => {
    const link = path.join(inside, 'link-out');
    fs.symlinkSync(outside, link);
    const res = await request(server.server)
      .post(`/api/config/backups/${OLDER}/move`)
      .send({ destination: link });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('destination_outside');
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(fs.existsSync(path.join(backups, OLDER))).toBe(true);
  });

  it('cannot move a copy DorkOS manages', async () => {
    const res = await request(server.server)
      .post(`/api/config/backups/${MANAGED}/move`)
      .send({ destination: inside });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('managed');
    expect(fs.readdirSync(inside)).toEqual([]);
    expect(fs.existsSync(path.join(backups, MANAGED))).toBe(true);
  });

  it('lists and acts on nothing when the backup folder is a link', async () => {
    const real = path.join(root, 'real-backups');
    fs.renameSync(backups, real);
    fs.symlinkSync(real, backups);
    const listed = await request(server.server).get('/api/config/backups');
    expect(listed.body.copies).toEqual([]);
    expect((await request(server.server).delete(`/api/config/backups/${OLDER}`)).status).toBe(404);
    const moved = await request(server.server)
      .post(`/api/config/backups/${OLDER}/move`)
      .send({ destination: inside });
    expect(moved.status).toBe(404);
    expect(fs.existsSync(path.join(real, OLDER))).toBe(true);
    expect(fs.readdirSync(inside)).toEqual([]);
  });

  it('refuses the data folder itself and any folder inside it', async () => {
    const inData = path.join(home, 'kept-aside');
    fs.mkdirSync(inData);
    for (const destination of [home, inData]) {
      const res = await request(server.server)
        .post(`/api/config/backups/${OLDER}/move`)
        .send({ destination });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('destination_in_data_folder');
    }
    expect(fs.readdirSync(inData)).toEqual([]);
    expect(fs.existsSync(path.join(backups, OLDER))).toBe(true);
  });

  it('follows a link to a folder inside the boundary, and writes to the real folder', async () => {
    const link = path.join(root, 'boundary', 'link-to-saved');
    fs.symlinkSync(inside, link);
    const res = await request(server.server)
      .post(`/api/config/backups/${OLDER}/move`)
      .send({ destination: link });
    expect(res.status).toBe(200);
    expect(res.body.destinationPath).toBe(path.join(inside, OLDER));
    expect(fs.existsSync(path.join(inside, OLDER))).toBe(true);
    expect(fs.existsSync(path.join(backups, OLDER))).toBe(false);
  });

  it('refuses a link that points into the data folder', async () => {
    const inData = path.join(home, 'kept-aside');
    fs.mkdirSync(inData);
    const link = path.join(root, 'boundary', 'link-into-data');
    fs.symlinkSync(inData, link);
    const res = await request(server.server)
      .post(`/api/config/backups/${OLDER}/move`)
      .send({ destination: link });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('destination_in_data_folder');
    expect(fs.readdirSync(inData)).toEqual([]);
    expect(fs.existsSync(path.join(backups, OLDER))).toBe(true);
  });

  it('accepts a folder on an external drive, outside the boundary', async () => {
    const drive = path.join(volumes, 'Backup Drive', 'dorkos');
    fs.mkdirSync(drive, { recursive: true });
    const res = await request(server.server)
      .post(`/api/config/backups/${OLDER}/move`)
      .send({ destination: drive });
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(drive, OLDER))).toBe(true);
    expect(fs.existsSync(path.join(backups, OLDER))).toBe(false);
  });

  it('refuses the volumes folder itself, the filesystem root and system folders', async () => {
    for (const destination of [volumes, '/', '/etc']) {
      const res = await request(server.server)
        .post(`/api/config/backups/${OLDER}/move`)
        .send({ destination });
      expect(res.status, destination).toBe(400);
      expect(res.body.code, destination).toBe('destination_outside');
    }
    expect(fs.existsSync(path.join(backups, OLDER))).toBe(true);
  });

  it('refuses a drive entry that is a link back to the system disk', async () => {
    // macOS lists the start-up disk under /Volumes as a link to `/`.
    fs.symlinkSync('/', path.join(volumes, 'Macintosh HD'));
    const res = await request(server.server)
      .post(`/api/config/backups/${OLDER}/move`)
      .send({ destination: path.join(volumes, 'Macintosh HD') });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('destination_outside');
    expect(fs.existsSync(path.join(backups, OLDER))).toBe(true);
  });

  it('keeps the original when the copy fails its check', async () => {
    fs.writeFileSync(path.join(backups, 'dork-20260904-daily.db'), 'not a database at all');
    const res = await request(server.server)
      .post('/api/config/backups/dork-20260904-daily.db/move')
      .send({ destination: inside });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('verify_failed');
    expect(fs.existsSync(path.join(backups, 'dork-20260904-daily.db'))).toBe(true);
    expect(fs.readdirSync(inside)).toEqual([]);
  });
});
