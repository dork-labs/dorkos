/**
 * The "Found on this computer" routes (spec `claude-account-ui` §7.4), on a
 * real config file. The carve-out's folder listing, comparable form and default
 * folder are pointed at a temp home, so nothing here ever scans a real home.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';

const fake = vi.hoisted(() => ({ home: '' }));

// The carve-out's three answers, pointed at the temp home instead of the OS one.
vi.mock('../../services/runtimes/claude-code/claude-config-dir.js', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../services/runtimes/claude-code/claude-config-dir.js')
    >();
  const accounts = await import('../../services/core/usage/runtime-accounts.js');
  return {
    ...real,
    listClaudeAccountFolderCandidates: () => real.listClaudeAccountFolderCandidates(fake.home),
    canonicalClaudeAccountPath: (dir: string) => accounts.canonicalAccountPath(dir, fake.home),
    claudeDefaultAccountFolder: (config: unknown) => ({
      path: accounts.defaultAccountFolder('claude-code', config, fake.home).path!,
      warnings: [],
    }),
  };
});
vi.mock('../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  logError: (err: unknown) => ({ err: String(err) }),
}));

import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import runtimesRouter from '../runtimes.js';
import { OPERATOR_COOKIE_REQUIRED_CODE } from '../../lib/caller-authority.js';

const app = express();
app.use(express.json());
app.use('/api/runtimes', runtimesRouter);
const server = listeningServer(app);

let dorkHome: string;

/** Make `<home>/<name>` holding `projects/`. */
function accountFolder(name: string): string {
  const dir = path.join(fake.home, name);
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true });
  return dir;
}

/** The dismissed list as the file on disk holds it. */
function dismissedOnDisk(): unknown {
  const file = JSON.parse(fs.readFileSync(path.join(dorkHome, 'config.json'), 'utf-8')) as {
    runtimes: { claudeCode: { dismissedFolders?: unknown } };
  };
  return file.runtimes.claudeCode.dismissedFolders;
}

function dismiss(dir: string) {
  return request(server)
    .post('/api/runtimes/claude-code/accounts/found/dismiss')
    .send({ path: dir });
}

beforeEach(() => {
  fake.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dork-found-route-home-')));
  dorkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-found-route-dork-'));
  fs.writeFileSync(path.join(dorkHome, 'config.json'), JSON.stringify({}), 'utf-8');
  initConfigManager(dorkHome);
});

afterEach(() => {
  fs.rmSync(fake.home, { recursive: true, force: true });
  fs.rmSync(dorkHome, { recursive: true, force: true });
});

describe('GET /api/runtimes/claude-code/accounts/found', () => {
  it('lists the unregistered folders in the injected home, never the machine default', async () => {
    accountFolder('.claude');
    const second = accountFolder('.claude2');

    const res = await request(server).get('/api/runtimes/claude-code/accounts/found');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      folders: [
        {
          path: second,
          name: '.claude2',
          lastUsedAt: expect.any(String),
          orgManaged: false,
          orgMarker: null,
        },
      ],
    });
  });
});

describe('GET …/found when the default account is another folder', () => {
  it('offers ~/.claude, which is then neither the default nor registered', async () => {
    accountFolder('.claude');
    const other = accountFolder('.claude2');
    configManager.setDot('runtimes.claudeCode.defaultAccount', other);

    const res = await request(server).get('/api/runtimes/claude-code/accounts/found');

    expect(res.body.folders.map((f: { name: string }) => f.name)).toEqual(['.claude']);
  });
});

describe('POST /api/runtimes/claude-code/accounts/found/dismiss', () => {
  it('keeps two dismissals in a row, and the folders stop being offered', async () => {
    const a = accountFolder('.claude2');
    const b = accountFolder('.claude3');

    expect((await dismiss(a)).status).toBe(204);
    expect((await dismiss(b)).status).toBe(204);

    expect(dismissedOnDisk()).toEqual([a, b]);
    const res = await request(server).get('/api/runtimes/claude-code/accounts/found');
    expect(res.body.folders).toEqual([]);
  });

  it('does not add a folder twice', async () => {
    const a = accountFolder('.claude2');

    await dismiss(a);
    const again = await dismiss(a);

    expect(again.status).toBe(204);
    expect(dismissedOnDisk()).toEqual([a]);
  });

  it('answers 204 for a folder already registered, and writes nothing', async () => {
    const a = accountFolder('.claude2');
    configManager.setDot('runtimes.claudeCode.accounts', [{ id: 'work', path: a, label: null }]);

    const res = await dismiss(a);

    expect(res.status).toBe(204);
    expect(configManager.get('runtimes').claudeCode.dismissedFolders).toEqual([]);
  });

  it('refuses a folder the list does not offer, and a body with no path', async () => {
    accountFolder('.claude2');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dork-found-outside-'));
    try {
      expect((await dismiss(outside)).status).toBe(400);
      expect(
        (await request(server).post('/api/runtimes/claude-code/accounts/found/dismiss').send({}))
          .status
      ).toBe(400);
      expect(configManager.get('runtimes').claudeCode.dismissedFolders).toEqual([]);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a signed-out caller while login is on, and writes nothing', async () => {
    const a = accountFolder('.claude2');
    configManager.setDot('auth.enabled', true);

    const res = await dismiss(a);

    // The more specific answer: sign in first (the cookie bar runs before the agent bar).
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(OPERATOR_COOKIE_REQUIRED_CODE);
    expect(configManager.get('runtimes').claudeCode.dismissedFolders).toEqual([]);
  });

  it('refuses a caller that names itself an agent', async () => {
    const a = accountFolder('.claude2');

    const res = await request(server)
      .post('/api/runtimes/claude-code/accounts/found/dismiss')
      .set('X-DorkOS-Agent', 'some-token')
      .send({ path: a });

    expect(res.status).toBe(403);
    expect(configManager.get('runtimes').claudeCode.dismissedFolders).toEqual([]);
  });
});
