import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { agents, createDb, runMigrations, sessionMetadata, type Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { recordTurnLevels } from '../../core/turn-power/turn-levels.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { composeRegistry } from '../../core/capabilities/index.js';
import { roomsDomain } from '../room-capabilities.js';
import { agentLookupFor, createRoomHarness, outcomeRunner } from './room-test-harness.js';

const AGENT_PATH = '/agents/river';
const AT = '2026-11-20T12:00:00.000Z';
let home: string | undefined;
const handles: Db[] = [];

afterEach(() => {
  for (const db of handles.splice(0)) if (db.$client.open) db.$client.close();
  vi.useRealTimers();
  if (home) rmSync(home, { recursive: true, force: true });
});

it('keeps an accepted waiting handoff readable after rebuilding the service over its database', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(AT));
  home = mkdtempSync(join(tmpdir(), 'handoff-restart-'));
  const file = join(home, 'rooms.sqlite');
  const lookup = agentLookupFor({
    [AGENT_PATH]: { id: 'river-agent', name: 'river', responseMode: 'mention-only' },
  });
  const open = (runner = outcomeRunner(() => ({ text: null }))) => {
    const db = createDb(file);
    handles.push(db);
    runMigrations(db);
    runtimeRegistry.setDb(db);
    return createRoomHarness({ db, agents: lookup, runner });
  };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runner = outcomeRunner(() => ({ text: null }));
  const run = runner.run.bind(runner);
  let attempts = 0;
  runner.run = async (request) => {
    attempts += 1;
    await held;
    return run(request);
  };
  const first = open(runner);
  first.db
    .insert(agents)
    .values({
      id: 'river-agent',
      name: 'river',
      runtime: 'claude-code',
      projectPath: AGENT_PATH,
      registeredAt: AT,
      updatedAt: AT,
    })
    .run();
  first.db
    .insert(sessionMetadata)
    .values({
      sessionId: 'draft-chat',
      runtime: 'claude-code',
      agentPath: AGENT_PATH,
      launchOrigin: 'interactive',
      createdAt: AT,
    })
    .run();
  const runtime = new FakeAgentRuntime('claude-code');
  runtime.getCapabilities.mockReturnValue(CLAUDE_CODE_CAPABILITIES);
  const recorder = recordTurnLevels(runtime, () => 'bypassPermissions');
  for await (const event of recorder.sendMessage('draft-chat', 'Draft work')) void event;
  const room = first.service.createRoom(
    {
      kind: 'channel',
      title: 'Ledger',
      members: [],
      agentPaths: [AGENT_PATH],
    },
    first.human
  );
  const author = first.authors.resolveAgent(AGENT_PATH, 'River');
  first.service.post(room.id, { authorId: first.human, text: 'Room context' });
  const input = {
    roomId: room.id,
    author,
    text: 'A waiting draft',
    verbatim: false,
    callerSessionId: 'draft-chat',
  };
  first.service.handoffs.initializeDurable(() => {});
  try {
    await first.service.handoffs.handOff(input);
    await vi.waitFor(() => expect(attempts).toBe(1));
    const receipt = await first.service.handoffs.handOff(input);
    const id = receipt.handoffId as string;
    expect(id).toEqual(expect.any(String));
    expect(first.service.handoffs.outcomes.read(id, author.id)).toMatchObject({
      status: 'pending',
      waiting: 'queued',
    });

    // A second connection and entirely new service retain no process-local handoff maps.
    const reopened = open();
    const registry = composeRegistry([roomsDomain], {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      roomDeps: { rooms: reopened.service },
    });
    const recovered = await registry.invoke(
      'rooms.handoff_status',
      { handoffId: id },
      {
        identity: { agentPath: AGENT_PATH, displayName: 'River', createdAt: AT },
        sessionId: 'draft-chat',
        retryChannel: 'mcp-argument',
      }
    );
    expect(recovered).toMatchObject({ status: 'pending', waiting: 'queued' });
    expect(reopened.service.handoffs.outcomes.read(id, 'another-author').status).toBe('unknown');
  } finally {
    release();
    await first.service.handoffs.idle();
    await first.service.triggersIdle();
  }
});
