/**
 * `knownSessionCwd` answers only from what the server already holds: the
 * runtime's live binding, then the durable native binding. Never a guess
 * (DOR-4844).
 */
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { sessionMetadata, sessionNativeBindings, type Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { createTestDb } from '@dorkos/test-utils/db';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { knownSessionCwd } from '../resolve-read-cwd.js';

const RUNTIME = 'known-cwd-fake';
let db: Db;
let runtime: FakeAgentRuntime;

beforeEach(() => {
  db = createTestDb();
  runtimeRegistry.setDb(db);
  runtime = new FakeAgentRuntime(RUNTIME);
  runtime.getInternalSessionId.mockReturnValue(undefined);
  runtimeRegistry.register(runtime);
});

function bind(sessionId: string, opts: { runtime?: string; nativeCwd?: string } = {}) {
  const at = new Date().toISOString();
  db.insert(sessionMetadata)
    .values({ sessionId, runtime: opts.runtime ?? RUNTIME, createdAt: at })
    .run();
  if (opts.nativeCwd)
    db.insert(sessionNativeBindings)
      .values({ sessionId, runtime: opts.runtime ?? RUNTIME, cwd: opts.nativeCwd, createdAt: at })
      .run();
}

it('the live binding of a running chat wins over the stored one', async () => {
  const id = randomUUID();
  bind(id, { nativeCwd: '/demo/stored' });
  runtime.getSessionCwd = vi.fn((sessionId: string) =>
    sessionId === id ? '/demo/live' : undefined
  );
  expect(await knownSessionCwd(id)).toBe('/demo/live');
});

it('falls back to the stored binding when nothing is running', async () => {
  const id = randomUUID();
  bind(id, { nativeCwd: '/demo/stored' });
  runtime.getSessionCwd = vi.fn(() => undefined);
  expect(await knownSessionCwd(id)).toBe('/demo/stored');
});

it('a chat reached by its first id finds the folder under its current id', async () => {
  const first = randomUUID();
  const current = randomUUID();
  bind(first);
  bind(current, { nativeCwd: '/demo/stored' });
  runtime.getInternalSessionId.mockImplementation((id) => (id === first ? current : undefined));
  expect(await knownSessionCwd(first)).toBe('/demo/stored');
});

it('a runtime that is not registered still reads the stored binding', async () => {
  const id = randomUUID();
  bind(id, { runtime: 'not-registered-here', nativeCwd: '/demo/stored' });
  expect(await knownSessionCwd(id)).toBe('/demo/stored');
});

it('answers null rather than a default when the server holds no folder', async () => {
  const id = randomUUID();
  bind(id);
  expect(await knownSessionCwd(id)).toBeNull();
});
