/** Actual Claude runtime constructor and session pump; only the external SDK transport is fake. */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { createTestDb } from '@dorkos/test-utils/db';
import { ClaudeCodeRuntime } from '../claude-code-runtime.js';
import { wrapSdkQuery } from './sdk-scenarios.js';
import { initConfigManager } from '../../../core/config-manager.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import {
  registerTestHomes,
  clearTestHomes,
} from '../../../core/agent-identity/__tests__/agent-home-fixture.js';
import { SessionEventStore } from '../../../session/session-event-store.js';
import { SessionStateProjector } from '../../../session/session-state-projector.js';
import { feedProjector } from '../../../session/session-event-normalizer.js';
import { latestClaudeRoomServerFailure } from '../../../session/history/latest-room-failure.js';
import { initBoundary } from '../../../../lib/boundary.js';
import { runInDispatch } from '../../../../lib/dispatch-context.js';
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
let scratch: string | undefined;
let runtime: ClaudeCodeRuntime | undefined;
afterEach(async () => {
  await runtime?.endSessionsWhere(() => true);
  runtime = undefined;
  clearTestHomes();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});
it('produces the strict failed-room witness and actual billing facts through the real constructor and pump', async () => {
  scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), '4328-runtime-boundary-')));
  await initBoundary(scratch);
  const home = path.join(scratch, 'agent');
  const root = path.join(scratch, 'account');
  const dorkHome = path.join(scratch, 'dork');
  await Promise.all([home, root, dorkHome].map((dir) => mkdir(dir, { recursive: true })));
  vi.stubEnv('DORK_HOME', dorkHome);
  vi.stubEnv('CLAUDE_CONFIG_DIR', root);
  for (const name of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
    vi.stubEnv(name, '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('No network in runtime constructor oracle');
    })
  );
  const config = initConfigManager(dorkHome);
  config.setDot('runtimes.claudeCode.accounts', [
    { id: 'actual-account', label: 'Fixture', path: root },
  ]);
  config.setDot('runtimes.claudeCode.defaultAccount', 'actual-account');
  registerTestHomes([home]);
  await writeFile(
    path.join(root, '.claude.json'),
    JSON.stringify({ oauthAccount: { accountUuid: randomUUID(), organizationUuid: randomUUID() } })
  );
  const id = randomUUID();
  const notice = 'API Error: upstream unavailable';
  async function* sdk() {
    yield {
      type: 'system',
      subtype: 'init',
      session_id: id,
      cwd: home,
      apiKeySource: 'oauth',
      tools: [],
      mcp_servers: [],
      slash_commands: [],
      skills: [],
      plugins: [],
    } as unknown as SDKMessage;
    yield {
      type: 'assistant',
      error: 'server_error',
      isApiErrorMessage: true,
      message: { role: 'assistant', content: [{ type: 'text', text: notice }] },
    } as unknown as SDKMessage;
    yield {
      type: 'result',
      subtype: 'error_during_execution',
      session_id: id,
      errors: [notice],
      is_error: true,
    } as unknown as SDKMessage;
  }
  vi.mocked(query, { partial: true }).mockImplementation(() => wrapSdkQuery(sdk()));
  const db = createTestDb();
  runtimeRegistry.setDb(db);
  runtime = new ClaudeCodeRuntime(dorkHome, home);
  runtimeRegistry.register(runtime);
  runtime.setSessionSettings(runtimeRegistry);
  await runtimeRegistry.persistSessionRuntime(
    id,
    'claude-code',
    { kind: 'room', externalAuthor: false },
    home
  );
  const events = new SessionEventStore(db);
  const projector = new SessionStateProjector(id);
  projector.enablePersistence(events, 'record');
  await runInDispatch(
    { dispatchId: 'actual-constructor-dispatch', origin: 'room', entryId: 'prior-entry' },
    () =>
      feedProjector(
        projector,
        runtime!.sendMessage(id, 'Original prior work', {
          cwd: home,
          forAgent: home,
          permissionMode: 'plan',
          accountHint: 'actual-account',
        }),
        {
          userMessage: 'Original prior work',
          roomMessage: { roomId: 'room', entryId: 'prior-entry' },
        }
      )
  );
  expect(query).toHaveBeenCalled();
  expect(latestClaudeRoomServerFailure(events.readLatestTurnStrict(id), 'room')).toMatchObject({
    dispatchId: 'actual-constructor-dispatch',
    entryId: 'prior-entry',
  });
  expect(runtime.readFailedSeatAuthority(id)).toMatchObject({
    accountId: 'actual-account',
    root,
    inference: 'own-account',
    billing: 'subscription',
  });
});
