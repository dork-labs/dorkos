/**
 * The three account-rule routes (spec `flow-multiproject` §8.6): the read any
 * caller may make, and the two writes only a person may make.
 *
 * Projects are real git repositories in a temp folder that is the directory
 * boundary, so the registry, the boundary check and the canonical-path step all
 * run for real. The config is an in-memory stand-in holding the whole
 * `runtimes` section, so every assertion reads back what was actually written.
 *
 * @module routes/__tests__/runtimes-account-eligibility
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const state = vi.hoisted(() => ({
  runtimes: {} as Record<string, unknown>,
  sets: 0,
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => {
      if (key === 'auth') return { enabled: false };
      if (key === 'runtimes') return state.runtimes;
      return undefined;
    },
    set: (key: string, value: unknown) => {
      if (key === 'runtimes') {
        state.sets += 1;
        state.runtimes = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
      }
    },
  },
}));

vi.mock('../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import runtimesRouter from '../runtimes.js';
import { initBoundary } from '../../lib/boundary.js';
import { setAccountUsageStore } from '../../services/core/usage/current-usage-store.js';
import type { AccountUsageStore } from '../../services/core/usage/account-usage-store.js';

const emit = vi.fn(async () => undefined);
const app = express();
app.use(express.json());
app.locals.activityService = { emit };
app.use('/api/runtimes', runtimesRouter);
const server = listeningServer(app);

let tmp: string;
/** A repository whose folder name contains a dot, as real roots do. */
let dotted: string;
let other: string;
/** A folder in no repository. */
let loose: string;

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q', dir]);
}

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'acct-elig-routes-')));
  dotted = path.join(tmp, 'client.app');
  other = path.join(tmp, 'other');
  loose = path.join(tmp, 'loose');
  await fs.mkdir(dotted);
  await fs.mkdir(other);
  await fs.mkdir(loose);
  gitInit(dotted);
  gitInit(other);
  await initBoundary(tmp);
});

afterAll(async () => {
  setAccountUsageStore(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  emit.mockClear();
  state.sets = 0;
  state.runtimes = {
    claudeCode: {
      accounts: [
        { id: 'work', path: '/claude-work', label: 'Work', onlyProjects: null },
        { id: 'personal', path: '/claude-personal', label: null, onlyProjects: null },
      ],
      defaultAccountOnlyProjects: null,
      projectAccounts: {},
    },
  };
  setAccountUsageStore({
    listAccounts: () => [
      { id: 'work', label: 'Work', color: '#111111', implicit: false, routable: true },
      { id: 'personal', label: null, color: '#222222', implicit: false, routable: true },
      { id: 'default', label: 'Main', color: '#333333', implicit: true, routable: true },
    ],
    usageOfAccount: () => ({ state: 'ok', windows: [] }),
  } as unknown as AccountUsageStore);
});

function claudeCode(): Record<string, unknown> {
  return state.runtimes.claudeCode as Record<string, unknown>;
}

type Row = {
  id: string;
  allowedByAccount: boolean;
  allowedByProject: boolean;
  eligible: boolean;
};

function row(body: { accounts: Row[] }, id: string): Row {
  const found = body.accounts.find((r) => r.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
}

describe('GET /api/runtimes/claude-code/account-eligibility — the launch it would make', () => {
  // Purpose: the picker's "Default" row names what the ladder will actually
  // bill in this project, not the default before the rules apply.
  it('names the next account that may work here when Main may not', async () => {
    claudeCode().defaultAccountOnlyProjects = [other];
    const res = await request(server)
      .get('/api/runtimes/claude-code/account-eligibility')
      .query({ project: dotted });
    expect(res.status).toBe(200);
    expect(res.body.launch).toMatchObject({ ok: true, accountId: 'work' });
  });

  // Purpose: when nothing may work here, the answer is the refusal sentence.
  it('says why a launch would be refused when no account may work here', async () => {
    claudeCode().defaultAccountOnlyProjects = [other];
    claudeCode().projectAccounts = { [dotted]: { allow: [] } };
    const res = await request(server)
      .get('/api/runtimes/claude-code/account-eligibility')
      .query({ project: dotted });
    expect(res.body.launch).toEqual({
      ok: false,
      message: expect.stringMatching(/^No account is allowed to work in /),
    });
  });
});

describe('GET /api/runtimes/claude-code/account-eligibility', () => {
  it("judges every account by both rules for the folder's project", async () => {
    claudeCode().projectAccounts = { [dotted]: { allow: ['work', 'default'] } };
    (claudeCode().accounts as Record<string, unknown>[])[0].onlyProjects = [other];

    const res = await request(server)
      .get('/api/runtimes/claude-code/account-eligibility')
      .query({ project: path.join(dotted) });

    expect(res.status).toBe(200);
    expect(res.body.project).toEqual({ root: dotted, name: expect.any(String) });
    expect(res.body.allow).toEqual(['work', 'default']);
    // Work: the project allows it, its own rule keeps it to `other`.
    expect(row(res.body, 'work')).toMatchObject({
      allowedByAccount: false,
      allowedByProject: true,
      eligible: false,
    });
    // Personal: free itself, not on the project's list.
    expect(row(res.body, 'personal')).toMatchObject({
      allowedByAccount: true,
      allowedByProject: false,
      eligible: false,
    });
    expect(row(res.body, 'default')).toMatchObject({
      allowedByAccount: true,
      allowedByProject: true,
      eligible: true,
    });
  });

  it('answers for no project when none is named: a kept account is not eligible', async () => {
    (claudeCode().accounts as Record<string, unknown>[])[0].onlyProjects = [dotted];

    const res = await request(server).get('/api/runtimes/claude-code/account-eligibility');

    expect(res.status).toBe(200);
    expect(res.body.project).toBeNull();
    expect(res.body.allow).toBeNull();
    expect(row(res.body, 'work')).toMatchObject({
      allowedByAccount: false,
      allowedByProject: true,
      eligible: false,
    });
    expect(row(res.body, 'personal')).toMatchObject({ eligible: true });
    expect(row(res.body, 'default')).toMatchObject({ eligible: true });
  });

  it('a folder in no repository is also no project', async () => {
    const res = await request(server)
      .get('/api/runtimes/claude-code/account-eligibility')
      .query({ project: loose });
    expect(res.status).toBe(200);
    expect(res.body.project).toBeNull();
  });
});

describe('PUT /api/runtimes/claude-code/project-accounts', () => {
  it('sets a rule under a root containing a dot, as one key, and records it', async () => {
    const res = await request(server)
      .put('/api/runtimes/claude-code/project-accounts')
      .send({ project: dotted, allow: ['work'] });

    expect(res.status).toBe(200);
    const stored = claudeCode().projectAccounts as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual([dotted]);
    expect(stored[dotted]).toEqual({ allow: ['work'] });
    expect(row(res.body, 'personal')).toMatchObject({ eligible: false });
    expect(row(res.body, 'work')).toMatchObject({ eligible: true });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'config.accounts_updated',
        actorType: 'user',
        resourceType: 'project',
        resourceId: dotted,
        summary: expect.stringContaining('may use only Work'),
        metadata: { project: dotted, allow: ['work'] },
      })
    );
  });

  it('removes a rule with null, keeping other projects', async () => {
    claudeCode().projectAccounts = {
      [dotted]: { allow: ['work'] },
      [other]: { allow: ['personal'] },
    };
    const res = await request(server)
      .put('/api/runtimes/claude-code/project-accounts')
      .send({ project: dotted, allow: null });

    expect(res.status).toBe(200);
    expect(claudeCode().projectAccounts).toEqual({ [other]: { allow: ['personal'] } });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringContaining('may use every account again') })
    );
  });

  it('a subfolder names its project', async () => {
    const sub = path.join(dotted, 'src');
    await fs.mkdir(sub, { recursive: true });
    const res = await request(server)
      .put('/api/runtimes/claude-code/project-accounts')
      .send({ project: sub, allow: ['default'] });
    expect(res.status).toBe(200);
    expect(claudeCode().projectAccounts).toEqual({ [dotted]: { allow: ['default'] } });
  });

  it('answers 400 for an unknown account id and writes nothing', async () => {
    const res = await request(server)
      .put('/api/runtimes/claude-code/project-accounts')
      .send({ project: dotted, allow: ['work', 'ghost'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('unknown_account');
    expect(state.sets).toBe(0);
    expect(emit).not.toHaveBeenCalled();
  });

  it('answers 404 for a folder that is not a project and writes nothing', async () => {
    const res = await request(server)
      .put('/api/runtimes/claude-code/project-accounts')
      .send({ project: loose, allow: ['work'] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_a_project');
    expect(state.sets).toBe(0);
  });

  it('refuses an agent with 403 and writes nothing', async () => {
    const res = await request(server)
      .put('/api/runtimes/claude-code/project-accounts')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ project: dotted, allow: ['work'] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('operator_only_config');
    expect(state.sets).toBe(0);
    expect(claudeCode().projectAccounts).toEqual({});
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('PUT /api/runtimes/claude-code/accounts/:id/only-projects', () => {
  it("keeps a registry row to projects, keeping the row's other fields", async () => {
    const res = await request(server)
      .put('/api/runtimes/claude-code/accounts/work/only-projects')
      .send({ projects: [path.join(dotted, 'src'), other] });

    expect(res.status).toBe(200);
    expect(res.body.onlyProjects.map((p: { root: string }) => p.root)).toEqual([dotted, other]);
    const rows = claudeCode().accounts as Record<string, unknown>[];
    expect(rows[0]).toEqual({
      id: 'work',
      path: '/claude-work',
      label: 'Work',
      onlyProjects: [dotted, other],
    });
    expect(rows[1].onlyProjects).toBeNull();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'config.accounts_updated',
        resourceType: 'account',
        resourceId: 'work',
        summary: expect.stringContaining('Work is now only for'),
      })
    );
  });

  // Purpose: a project the rule already names is kept when its folder is gone,
  // so re-saving the dialog never drops it or refuses the whole save.
  it('keeps a project the rule already names whose folder is gone', async () => {
    const gone = path.join(tmp, 'unplugged');
    (claudeCode().accounts as Record<string, unknown>[])[0].onlyProjects = [gone];
    const res = await request(server)
      .put('/api/runtimes/claude-code/accounts/work/only-projects')
      .send({ projects: [gone, dotted] });

    expect(res.status).toBe(200);
    const rows = claudeCode().accounts as Record<string, unknown>[];
    expect(rows[0].onlyProjects).toEqual([gone, dotted]);
  });

  it("writes Main's rule for `default`", async () => {
    const res = await request(server)
      .put('/api/runtimes/claude-code/accounts/default/only-projects')
      .send({ projects: [other] });
    expect(res.status).toBe(200);
    expect(claudeCode().defaultAccountOnlyProjects).toEqual([other]);
    expect((claudeCode().accounts as Record<string, unknown>[]).map((r) => r.onlyProjects)).toEqual(
      [null, null]
    );
  });

  it('frees an account with null', async () => {
    (claudeCode().accounts as Record<string, unknown>[])[0].onlyProjects = [other];
    const res = await request(server)
      .put('/api/runtimes/claude-code/accounts/work/only-projects')
      .send({ projects: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ onlyProjects: null });
    expect((claudeCode().accounts as Record<string, unknown>[])[0].onlyProjects).toBeNull();
  });

  it('answers 400 for a folder that is not a project and writes nothing', async () => {
    const res = await request(server)
      .put('/api/runtimes/claude-code/accounts/work/only-projects')
      .send({ projects: [other, loose] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('not_a_project');
    expect(state.sets).toBe(0);
  });

  it('answers 404 for an unknown account', async () => {
    const res = await request(server)
      .put('/api/runtimes/claude-code/accounts/ghost/only-projects')
      .send({ projects: [other] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('unknown_account');
    expect(state.sets).toBe(0);
  });

  it('refuses an agent with 403 and writes nothing', async () => {
    const res = await request(server)
      .put('/api/runtimes/claude-code/accounts/default/only-projects')
      .set('x-dorkos-agent', 'agent-token-abc')
      .send({ projects: [other] });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('operator_only_config');
    expect(state.sets).toBe(0);
    expect(claudeCode().defaultAccountOnlyProjects).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });
});
