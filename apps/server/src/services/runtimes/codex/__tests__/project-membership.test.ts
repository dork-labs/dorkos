import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { expect, it, vi } from 'vitest';
import { initBoundary } from '../../../../lib/boundary.js';
import { resolveSessionCwdOrNull } from '../../../session/resolution/resolve-read-cwd.js';
import { CodexRuntime } from '../codex-runtime.js';
import { CodexThreadMap } from '../thread-map.js';
import { ScriptedCodexTransport } from './fixtures/scripted-transport.js';

it('opens saved and native Codex chats listed through both spellings of their project', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'dorkos-codex-project-membership-'));
  const db = createTestDb();
  try {
    const directory = await realpath(temp);
    const project = path.join(directory, 'app');
    const alias = path.join(directory, 'linked-app');
    const sibling = path.join(directory, 'application');
    const codexHome = path.join(directory, 'codex-home');
    const rollouts = path.join(codexHome, 'sessions');
    await mkdir(project);
    await mkdir(sibling);
    await mkdir(rollouts, { recursive: true });
    await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await initBoundary(directory);
    vi.stubEnv('CODEX_HOME', codexHome);
    vi.stubEnv('DORK_HOME', path.join(directory, 'dork-home'));

    const persisted = {
      id: '0195bfa1-e000-7000-8000-000000000001',
      cwd: project,
      title: 'Saved chat',
    };
    const native = [
      { id: '0195bfa1-e000-7000-8000-000000000002', cwd: project, title: 'Native chat' },
      { id: '0195bfa1-e000-7000-8000-000000000003', cwd: alias, title: 'Native alias chat' },
      { id: '0195bfa1-e000-7000-8000-000000000004', cwd: sibling, title: 'Other chat' },
    ];
    for (const { id, cwd, title } of native) {
      const records = [
        {
          type: 'session_meta',
          timestamp: '2026-01-01T00:00:00Z',
          payload: { id, cwd },
        },
        {
          type: 'response_item',
          timestamp: '2026-01-01T00:00:01Z',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: title }],
          },
        },
      ];
      await writeFile(
        path.join(rollouts, 'rollout-2026-01-01T00-00-00-' + id + '.jsonl'),
        records.map((record) => JSON.stringify(record)).join('\n')
      );
    }

    const threadMap = new CodexThreadMap(db);
    threadMap.setThreadId(persisted.id, 'saved-thread', persisted.cwd, { title: persisted.title });
    const saved = threadMap.getRecord(persisted.id);
    const runtime = new CodexRuntime({
      defaultCwd: project,
      threadMap,
      transport: new ScriptedCodexTransport(() => {
        throw new Error('Reading a saved chat must not start a Codex turn');
      }),
      resolveBinary: async () => null,
    });
    await runtime.hydrateSessions();

    const expected = [persisted, ...native.slice(0, 2)];
    for (const requested of [project, alias]) {
      const sessions = await runtime.listSessions(requested);
      expect(sessions).toHaveLength(expected.length);
      expect(sessions).toEqual(
        expect.arrayContaining(expected.map((session) => expect.objectContaining(session)))
      );
    }
    await expect(runtime.listSessions(sibling)).resolves.toMatchObject([native[2]]);

    for (const session of expected) {
      const sessionCwd = await resolveSessionCwdOrNull(runtime, session.id, alias);
      expect(sessionCwd).toBe(session.cwd);
      await expect(runtime.getSession(session.cwd, session.id)).resolves.toMatchObject(session);
    }
    await expect(runtime.getMessageHistory(alias, native[1]!.id)).resolves.toMatchObject([
      { role: 'user', content: 'Native alias chat' },
    ]);
    expect(threadMap.getRecord(persisted.id)).toEqual(saved);
    await runtime.shutdown();
  } finally {
    vi.unstubAllEnvs();
    db.$client.close();
    await rm(temp, { recursive: true, force: true });
  }
});
