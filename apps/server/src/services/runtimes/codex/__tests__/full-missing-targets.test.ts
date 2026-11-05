import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { makeAppServerHarness } from './app-server-harness.js';
import { buildLoadOverrides } from '../app-server/thread-loader.js';
import { createAppServerTransport } from '../transport/app-server-transport.js';
import {
  CodexFullMissingTargetsError,
  refuseMissingFullTargets,
} from '../policy/full-missing-targets.js';

afterEach(() => vi.unstubAllGlobals());

function platform(name: string) {
  vi.stubGlobal(
    'process',
    new Proxy(process, {
      get: (target, key) => (key === 'platform' ? name : Reflect.get(target, key)),
    })
  );
}

it.each(['person', 'credits'] as const)(
  'refuses %s Full before acquiring a process or binding a thread',
  async (home) => {
    platform('linux');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-full-refusal-')));
    const cwd = path.join(root, 'project');
    const data = path.join(root, 'data');
    const person = path.join(root, 'home');
    for (const dir of [cwd, data, person]) fs.mkdirSync(dir);
    const h = makeAppServerHarness();
    const acquire = vi.spyOn(h.pool, 'acquire');
    const transport = createAppServerTransport({ pool: h.pool, connectorTools: () => undefined });
    const settings = { permissionMode: 'bypassPermissions' };
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
          code: 'codex_full_missing_protected_targets',
          message:
            'Codex can’t use Full access while protected files are missing. Choose Ask, then retry.',
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
      ).toThrow(CodexFullMissingTargetsError);
      expect(recordMissing).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
      expect(h.host.spawns).toEqual([]);
      expect(h.bindings).toEqual([]);
      expect(settings.permissionMode).toBe('bypassPermissions');
      for (const dir of [cwd, data, person]) expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      await h.pool.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);

it('sorts exact missing targets and refuses Full only on Linux', () => {
  platform('linux');
  expect(() =>
    refuseMissingFullTargets({ permissionMode: 'bypassPermissions' }, ['/b', '/a', '/b'])
  ).toThrow(CodexFullMissingTargetsError);
  try {
    refuseMissingFullTargets({ permissionMode: 'bypassPermissions' }, ['/b', '/a', '/b']);
  } catch (error) {
    expect((error as CodexFullMissingTargetsError).missingPaths).toEqual(['/a', '/b']);
  }
  for (const permissionMode of ['default', 'acceptEdits'])
    expect(() => refuseMissingFullTargets({ permissionMode }, ['/missing'])).not.toThrow();
  expect(() => refuseMissingFullTargets({ permissionMode: 'bypassPermissions' }, [])).not.toThrow();
  platform('darwin');
  expect(() =>
    refuseMissingFullTargets({ permissionMode: 'bypassPermissions' }, ['/missing'])
  ).not.toThrow();
});
