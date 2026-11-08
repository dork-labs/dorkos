import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { makeAppServerHarness } from './app-server-harness.js';
import { buildLoadOverrides } from '../app-server/thread-loader.js';
import { createAppServerTransport } from '../transport/app-server-transport.js';
import {
  CodexWritableMissingTargetsError,
  refuseMissingWritableTargets,
} from '../policy/writable-missing-targets.js';
import type { CodexFilePolicy } from '../policy/protected-profile.js';

afterEach(() => vi.unstubAllGlobals());

function platform(name: string) {
  vi.stubGlobal(
    'process',
    new Proxy(process, {
      get: (target, key) => (key === 'platform' ? name : Reflect.get(target, key)),
    })
  );
}

it.each([
  ['person', 'bypassPermissions'],
  ['credits', 'bypassPermissions'],
  ['person', 'acceptEdits'],
  ['credits', 'acceptEdits'],
] as const)('refuses %s %s before acquiring a process or binding a thread', async (home, mode) => {
  platform('linux');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-full-refusal-')));
  const cwd = path.join(root, 'project');
  const data = path.join(root, 'data');
  const person = path.join(root, 'home');
  for (const dir of [cwd, data, person]) fs.mkdirSync(dir);
  const h = makeAppServerHarness();
  const acquire = vi.spyOn(h.pool, 'acquire');
  const transport = createAppServerTransport({ pool: h.pool, connectorTools: () => undefined });
  const settings = { permissionMode: mode };
  try {
    const events: StreamEvent[] = [];
    const turn = h.request({
      sessionId: 'full-missing',
      cwd,
      settings,
      launch:
        home === 'person'
          ? { home }
          : {
              home,
              credits: {
                baseUrl: 'https://example.invalid',
                token: 'synthetic-never-sent',
                tokenId: 'synthetic-token-id',
                expiresAt: '2099-01-01T00:00:00Z',
                protocol: 'openai-responses',
              },
            },
      tools: {
        agentTokenEnv: {},
        managed: { servers: {}, env: {} },
        dorkosTools: null,
        connectorTools: null,
        filePolicy: {
          roots: { cwd, data, home: person, accounts: [], agentHomes: [], agentFolders: [cwd] },
          writable: [cwd],
        },
      },
    });
    for await (const event of transport.runTurn(turn)) events.push(event);
    expect(events.map((event) => event.type)).toEqual(['error', 'done']);
    expect(events[0]).toMatchObject({
      data: {
        code:
          mode === 'bypassPermissions'
            ? 'codex_full_missing_protected_targets'
            : 'codex_writable_missing_protected_targets',
        message: expect.stringContaining('protected files are missing'),
        details: expect.stringContaining(path.join(person, '.claude.json')),
      },
    });
    const recordMissing = vi.fn();
    expect(() =>
      buildLoadOverrides(turn, {
        threadKey: undefined,
        trust: undefined,
        realCwd: cwd,
        onMissingTargets: recordMissing,
      })
    ).toThrow(CodexWritableMissingTargetsError);
    expect(recordMissing).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(h.host.spawns).toEqual([]);
    expect(h.bindings).toEqual([]);
    expect(settings.permissionMode).toBe(mode);
    expect(fs.readdirSync(cwd).sort()).toEqual(['.claude', '.dork']);
    for (const dir of [data, person]) expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    await h.pool.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('sorts exact missing targets and refuses writable modes only on Linux', () => {
  platform('linux');
  expect(() =>
    refuseMissingWritableTargets({ permissionMode: 'bypassPermissions' }, ['/b', '/a', '/b'])
  ).toThrow(CodexWritableMissingTargetsError);
  try {
    refuseMissingWritableTargets({ permissionMode: 'bypassPermissions' }, ['/b', '/a', '/b']);
  } catch (error) {
    expect((error as CodexWritableMissingTargetsError).missingPaths).toEqual(['/a', '/b']);
  }
  for (const permissionMode of ['default'])
    expect(() => refuseMissingWritableTargets({ permissionMode }, ['/missing'])).not.toThrow();
  expect(() =>
    refuseMissingWritableTargets({ permissionMode: 'bypassPermissions' }, [])
  ).not.toThrow();
  platform('darwin');
  expect(() =>
    refuseMissingWritableTargets({ permissionMode: 'bypassPermissions' }, ['/missing'])
  ).not.toThrow();
});

it('checks cwd, grants and native temporary binds, while read-only targets stay masked', () => {
  platform('linux');
  const policy: CodexFilePolicy = {
    roots: {
      cwd: '/work/project',
      home: '/home/person',
      data: '/data',
      accounts: [],
      agentHomes: [],
      agentFolders: [],
    },
    writable: ['/work/grant'],
  };
  const edit = { permissionMode: 'acceptEdits' };
  for (const target of ['/work/project/.mcp.json', '/work/grant/.netrc', '/tmp/.netrc'])
    expect(() => refuseMissingWritableTargets(edit, [target], policy)).toThrow(
      CodexWritableMissingTargetsError
    );
  expect(() => refuseMissingWritableTargets(edit, ['/home/person/.netrc'], policy)).not.toThrow();
  expect(() =>
    refuseMissingWritableTargets(edit, ['/work/project-other/.netrc'], policy)
  ).not.toThrow();
  expect(() =>
    refuseMissingWritableTargets(
      { permissionMode: 'bypassPermissions' },
      ['/home/person/.netrc'],
      policy
    )
  ).toThrow(CodexWritableMissingTargetsError);
});
