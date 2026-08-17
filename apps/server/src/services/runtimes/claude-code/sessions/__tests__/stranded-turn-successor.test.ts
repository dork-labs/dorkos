/**
 * A turn that outlived its window must not poison the turn that replaces it
 * (DOR-1295).
 *
 * DOR-1294 gave the windower a backstop: a dispatch that finds a window still
 * open ABANDONS it — one synthetic error `result`, one `turn_end` — so a session
 * whose `result` went somewhere else can still run another turn. That fixed the
 * wedge and created this one. The abandonment happens INSIDE the successor's
 * dispatch, and the successor's `turn_start` is minted before its generator is
 * ever pulled (`feedProjector`), so the stranded turn's terminal always landed
 * AFTER the successor's turn had opened: the healthy turn settled `error`, and
 * the durable rows came out as one mongrel set spanning both turns.
 *
 * Driven end to end — `triggerTurn` → `ClaudeCodeRuntime.sendMessage` → a real
 * {@link SessionStateProjector} with a recording store — because the bug is in
 * the ORDER two layers reach one projector, and no layer can show it alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionEvent } from '@dorkos/shared/session-stream';

const optIn = vi.hoisted(() => ({ persistentSession: true }));

vi.mock('../../claude-config-dir.js', () => ({
  resolveActiveClaudeRoot: () => '/tmp/fake-claude',
  resolveClaudeRootSet: () => ['/tmp/fake-claude'],
  claudeConfigDirEnv: (root: string) => ({ CLAUDE_CONFIG_DIR: root }),
  describeClaudeCodeAccounts: () => ({
    resolvedAccount: '/tmp/fake-claude',
    inherited: false,
    accounts: [],
  }),
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  renameSession: vi.fn(),
  forkSession: vi.fn(),
  getSessionInfo: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
  logError: (err: unknown) => ({ error: String(err) }),
}));
vi.mock('../../messaging/context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn().mockResolvedValue('<env>test</env>'),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));
vi.mock('../../tooling/tool-filter.js', () => ({
  resolveToolConfig: vi.fn().mockReturnValue({ tasks: true, relay: true, mesh: true }),
}));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));
vi.mock('../../../../relay/relay-state.js', () => ({ isRelayEnabled: () => false }));
vi.mock('../../../../tasks/task-state.js', () => ({ isTasksEnabled: () => false }));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => {
      if (key === 'runtimes') return { claudeCode: { ...optIn } };
      return { tasksTools: true, relayTools: true, meshTools: true, adapterTools: true };
    }),
  },
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/projects/pump'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/projects/pump'),
  getBoundary: vi.fn().mockReturnValue('/projects'),
  initBoundary: vi.fn().mockResolvedValue('/projects'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {},
}));
vi.mock('../../tooling/command-registry.js', () => ({
  CommandRegistryService: class {
    getCommands = vi.fn().mockResolvedValue({ commands: [], lastScanned: '' });
    invalidateCache = vi.fn();
  },
}));
vi.mock('../../../../core/event-fan-out.js', () => ({
  eventFanOut: { broadcast: vi.fn(), addClient: vi.fn(), clientCount: 0 },
}));
vi.mock('../../../../../lib/dork-home.js', () => ({
  resolveDorkHome: vi.fn().mockReturnValue('/tmp/dorkos-pump'),
}));
vi.mock('../../../../marketplace/installed-scanner.js', () => ({
  listEnabledPluginNames: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../messaging/plugin-activation.js', () => ({
  buildClaudeAgentSdkPluginsArray: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../../../core/credential-env.js', () => ({
  resolveClaudeCredentialEnv: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../../../core/agent-identity/index.js', () => ({
  resolveAgentTokenEnv: vi.fn().mockResolvedValue({}),
  AGENT_TOKEN_ENV_VAR: 'DORKOS_AGENT_TOKEN',
  createInSessionContextResolver: () => () => Promise.resolve(undefined),
}));
// The neutral context bag shells out for git status; this turn is about turn
// ORDER, and a real repo probe would only make it slower and flakier.
vi.mock('../../../../session/context-assembler.js', () => ({
  assembleAdditionalContext: vi.fn().mockResolvedValue([]),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { validateBoundaryOrDorkHome } from '../../../../../lib/boundary.js';
import { ClaudeCodeRuntime } from '../../claude-code-runtime.js';
import { SessionStateProjector } from '../../../../session/session-state-projector.js';
import type { SessionEventStore } from '../../../../session/session-event-store.js';
import { triggerTurn, type TriggerTurnDeps } from '../../../../session/trigger-turn.js';
import { FakeCli, type FakeCliProcess } from './fake-persistent-cli.js';

const CWD = '/projects/pump';
const CLIENT_ID = 'client-1';
const mockedQuery = vi.mocked(query);

let cli: FakeCli;
let runtime: ClaudeCodeRuntime;
let flushed: SessionEvent[][];
let recordingStore: SessionEventStore;

/** A store that only remembers what each turn flushed, in flush order. */
function makeRecordingStore(): SessionEventStore {
  return {
    appendTurn: (_sessionId: string, events: SessionEvent[]) => {
      flushed.push(events);
    },
    readAll: () => [],
    maxSeq: () => 0,
    trim: () => {},
  } as unknown as SessionEventStore;
}

/** The runtime-neutral port `triggerTurn` takes, over the real runtime. */
function turnDeps(): TriggerTurnDeps {
  return {
    acquireLock: () => true,
    releaseLock: () => {},
    sendMessage: (sid, text, o) => runtime.sendMessage(sid, text, o),
    interruptQuery: (sid) => runtime.interruptQuery(sid),
    getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
    rekeyProjector: () => {},
    getCapabilities: () => runtime.getCapabilities(),
    settleOpenTurn: (sid) => runtime.settleOpenTurn(sid),
  };
}

beforeEach(() => {
  optIn.persistentSession = true;
  flushed = [];
  recordingStore = makeRecordingStore();
  cli = new FakeCli();
  mockedQuery.mockReset();
  mockedQuery.mockImplementation(cli.query as unknown as typeof query);
  vi.mocked(validateBoundaryOrDorkHome).mockResolvedValue(CWD);
  runtime = new ClaudeCodeRuntime('/tmp/dorkos-pump', CWD);
});

afterEach(() => {
  for (const process of cli.processes) process.endStream();
});

/**
 * Warm the session's process with one ordinary turn, then stop it answering —
 * the state the wedge needs, and the only way to reach the process object
 * before it has read anything.
 */
async function warmThenGoSilent(sessionId: string): Promise<FakeCliProcess> {
  for await (const _event of runtime.sendMessage(sessionId, 'warm up', { cwd: CWD })) {
    // drained, not asserted: this turn only exists to boot the process
  }
  const process = cli.processes[0]!;
  process.goSilent();
  return process;
}

describe('a stranded turn settles before its successor opens (DOR-1295)', () => {
  it('leaves the successor clean and gives the abandoned turn its own rows', async () => {
    const sessionId = 'stranded-successor';
    runtime.ensureSession(sessionId, { cwd: CWD, permissionMode: 'default' });
    const process = await warmThenGoSilent(sessionId);

    const projector = new SessionStateProjector(sessionId);
    projector.enablePersistence(recordingStore, 'record');
    const deps = turnDeps();

    // Turn 1 is dispatched and the CLI never answers it: the window stays open
    // and its feed stays live — the DOR-1294 strand, exactly.
    const first = triggerTurn({
      sessionId,
      clientId: CLIENT_ID,
      content: 'first',
      cwd: CWD,
      messageId: 'm1',
      projector,
      deps,
      queueWaitMs: 5,
    });
    await vi.waitFor(() => expect(process.received).toContain('m1'));
    // It is working, visibly — and it will never finish.
    process.say('thinking about it');
    await first;
    expect(projector.getStatus().lifecycle).toBe('streaming');

    // Turn 2 arrives while turn 1 is still open — the same-client queue bound
    // has elapsed, which is how a person's next message reaches a wedged
    // session in production.
    const second = triggerTurn({
      sessionId,
      clientId: CLIENT_ID,
      content: 'second',
      cwd: CWD,
      messageId: 'm2',
      projector,
      deps,
      queueWaitMs: 5,
    });
    await vi.waitFor(() => expect(process.received).toContain('m2'));
    // A perfectly healthy answer to the turn the person is watching.
    process.answer('m2', 'here you go');
    await second;

    await vi.waitFor(() => expect(flushed).toHaveLength(2));

    // (a) The successor settled on its OWN terms — no latched error from the
    // turn it replaced.
    const status = projector.getStatus();
    expect(status.lifecycle).toBe('idle');

    // (b) Two turns, two row sets, each whole. The poisoned shape was ONE set
    // spanning both — `turn_start` of the successor with the stranded turn's
    // error and `turn_end` — after which the successor's own `turn_end` had no
    // open turn left to flush.
    const [strandedRows, successorRows] = flushed as [SessionEvent[], SessionEvent[]];
    expect(strandedRows[0]).toMatchObject({ type: 'turn_start', userMessage: 'first' });
    expect(strandedRows.at(-1)).toMatchObject({ type: 'turn_end', terminalReason: 'error' });
    expect(successorRows[0]).toMatchObject({ type: 'turn_start', userMessage: 'second' });
    expect(successorRows.at(-1)).toMatchObject({ type: 'turn_end' });
    expect(successorRows.at(-1)).not.toMatchObject({ terminalReason: 'error' });
    // Nothing of the successor's may appear in the stranded turn's rows, and
    // nothing of the stranded turn's in the successor's.
    expect(successorRows.some((event) => event.type === 'error')).toBe(false);

    // (c) …and the abandoned turn is the one that carries the failure.
    expect(strandedRows.some((event) => event.type === 'error')).toBe(true);
  });
});
