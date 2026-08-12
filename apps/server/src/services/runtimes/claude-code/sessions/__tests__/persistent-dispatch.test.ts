/**
 * The composition: a claude-code message reaching a process that is already
 * running, and everything that must stay true when it does (spec
 * `persistent-session-runtime` §P3, task 3.10 / DOR-1175).
 *
 * Driven through `ClaudeCodeRuntime.sendMessage`, not through the pump, because
 * the thing under test IS the wiring. A test that drove the pump directly would
 * pass with `sendMessage` still hard-wired to `executeSdkQuery`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';

const optIn = vi.hoisted(() => ({ persistentSession: false }));

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
  CommandRegistryService: vi.fn().mockImplementation(() => ({
    getCommands: vi.fn().mockResolvedValue({ commands: [], lastScanned: '' }),
    invalidateCache: vi.fn(),
  })),
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
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { validateBoundaryOrDorkHome } from '../../../../../lib/boundary.js';
import { ClaudeCodeRuntime } from '../../claude-code-runtime.js';
import { FakeCli, resultMessage } from './fake-persistent-cli.js';

const CWD = '/projects/pump';
const mockedQuery = vi.mocked(query);
let cli: FakeCli;
let runtime: ClaudeCodeRuntime;
let sessionSeq = 0;

/** A fresh session id per case, so no two cases share a pump. */
function nextSession(): string {
  sessionSeq += 1;
  const id = `pump-session-${sessionSeq}`;
  runtime.ensureSession(id, { cwd: CWD, permissionMode: 'default' });
  return id;
}

/** Run one turn to completion and collect everything it said. */
async function turn(sessionId: string, content = 'hello'): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of runtime.sendMessage(sessionId, content, { cwd: CWD })) {
    events.push(event);
  }
  return events;
}

beforeEach(() => {
  optIn.persistentSession = false;
  cli = new FakeCli();
  mockedQuery.mockReset();
  mockedQuery.mockImplementation(cli.query as unknown as typeof query);
  vi.mocked(validateBoundaryOrDorkHome).mockResolvedValue(CWD);
  runtime = new ClaudeCodeRuntime('/tmp/dorkos-pump', CWD);
});

afterEach(() => {
  // Every process this case booted, closed — a leaked one would keep reading a
  // prompt stream for the rest of the file.
  for (const process of cli.processes) process.endStream();
});

describe('the opt-in decides which path a message takes', () => {
  it('starts a fresh process per message while the setting is off', async () => {
    const sessionId = nextSession();

    await turn(sessionId);
    await turn(sessionId);
    await turn(sessionId);

    // Three messages, three subprocesses: the resume-per-message path, byte for
    // byte. This is the case that goes red if the branch in `sendMessage` ever
    // stops honoring the flag.
    expect(cli.launches).toBe(3);
    expect(runtime.getSessionWarmth(sessionId)).toBe('cold');
  });

  it('runs ten consecutive turns on ONE process once the setting is on', async () => {
    optIn.persistentSession = true;
    const sessionId = nextSession();

    for (let i = 0; i < 10; i++) {
      const events = await turn(sessionId, `message ${i}`);
      expect(events.some((e) => e.type === 'done')).toBe(true);
    }

    // Process IDENTITY, not the absence of an error: one process object, and it
    // is the one that answered all ten turns. A composition that relaunched per
    // turn would still produce ten clean turns and would fail here.
    expect(cli.launches).toBe(1);
    expect(cli.processes[0]!.answered).toBe(10);
    expect(cli.processes[0]!.ended).toBe(false);
  });

  it('leaves a session that is already warm on the pump when the setting goes off', async () => {
    optIn.persistentSession = true;
    const sessionId = nextSession();
    await turn(sessionId);

    // The operator changes their mind mid-conversation.
    optIn.persistentSession = false;
    await turn(sessionId);

    // Still one process. The asymmetry is deliberate and documented: a session
    // mid-conversation does not have its process pulled out from under it, and
    // P5's comparison runs have to reap or restart to measure the other path.
    expect(cli.launches).toBe(1);
    expect(runtime.getSessionWarmth(sessionId)).toBe('warm');
  });

  it('takes the resume path again once the warm process has been given back', async () => {
    optIn.persistentSession = true;
    const sessionId = nextSession();
    await turn(sessionId);

    optIn.persistentSession = false;
    await runtime.reapSession(sessionId);
    expect(runtime.getSessionWarmth(sessionId)).toBe('cold');
    await turn(sessionId);

    // The reap dropped the pump, so the next message re-read the flag and found
    // it off: a second process, booted by the resume path.
    expect(cli.launches).toBe(2);
    expect(runtime.getSessionWarmth(sessionId)).toBe('cold');
  });
});

describe('warmth is answered honestly', () => {
  beforeEach(() => {
    optIn.persistentSession = true;
  });

  it('reports warm between turns and cold once the process is given back', async () => {
    const sessionId = nextSession();
    expect(runtime.getSessionWarmth(sessionId)).toBe('cold');

    await turn(sessionId);
    expect(runtime.getSessionWarmth(sessionId)).toBe('warm');

    await runtime.reapSession(sessionId);
    // A reaped process is gone and the conversation is untouched, which is what
    // `cold` means. The person cannot tell.
    expect(runtime.getSessionWarmth(sessionId)).toBe('cold');
  });

  it('reports a crash with no turn open, and says nothing on the session stream', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    expect(runtime.getSessionWarmth(sessionId)).toBe('warm');

    // The idle process dies with nobody watching.
    cli.processes[0]!.crash(new Error('the CLI went away'));
    await vi.waitFor(() => {
      expect(runtime.getSessionWarmth(sessionId)).toBe('crashed');
    });

    // And that is the ONLY place it is visible. Minting a turn for a session
    // where nothing was running would report a failure that never happened —
    // the phantom turn task 3.6's acceptance forbids.
    const events = await turn(sessionId, 'still there?');
    const starts = events.filter((e) => e.type === 'done');
    expect(starts).toHaveLength(1);
    // The relaunch is the recovery, and it is the second process — not a third,
    // which is what a crash handled twice would produce.
    expect(cli.launches).toBe(2);
  });

  it('a message after a mid-turn crash resumes on a new process', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    const first = cli.processes[0]!;
    first.goSilent();

    const hanging = turn(sessionId, 'this one dies');
    // Wait until the process has READ the second message, not until it has
    // answered one — it answered the first turn already, so an `answered === 1`
    // wait passes before this turn's window even opens and the case would
    // quietly become "a crash between turns" instead.
    await vi.waitFor(() => {
      expect(first.received).toHaveLength(2);
    });
    first.crash(new Error('killed mid-turn'));

    const events = await hanging;
    // The open turn closes as a failure rather than hanging: an error, then
    // exactly one terminal.
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);

    const recovered = await turn(sessionId, 'try again');
    expect(recovered.some((e) => e.type === 'done')).toBe(true);
    expect(cli.launches).toBe(2);
  });
});

describe('Stop reaches a turn, never a process that is merely warm', () => {
  beforeEach(() => {
    optIn.persistentSession = true;
  });

  it('finds nothing to interrupt on a warm idle session, and leaves the process alone', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    const process = cli.processes[0]!;
    expect(runtime.getSessionWarmth(sessionId)).toBe('warm');

    // The person presses Stop when nothing is running.
    const interrupted = await runtime.interruptQuery(sessionId);

    // Honest "there was nothing to stop". The alternative is not cosmetic:
    // `interruptQuery` escalates to `close()` when `interrupt()` rejects, so a
    // `true` here means a healthy warm subprocess was destroyed and the session
    // reports `crashed` — a person pressing Stop on an idle chat losing the
    // agent they were about to talk to.
    expect(interrupted, 'Stop claimed it interrupted a turn that was not running').toBe(false);
    expect(process.closed, 'Stop reached for the forceful close on an idle process').toBe(0);
    expect(process.ended).toBe(false);
    expect(runtime.getSessionWarmth(sessionId)).toBe('warm');
  });

  it('finds nothing to interrupt once the process has been given back', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    await runtime.reapSession(sessionId);

    expect(await runtime.interruptQuery(sessionId)).toBe(false);
    expect(runtime.getSessionWarmth(sessionId)).toBe('cold');
  });

  it('still reaches a turn that IS running', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    const process = cli.processes[0]!;
    process.goSilent();

    const running = turn(sessionId, 'this one is live');
    await vi.waitFor(() => {
      expect(process.received).toHaveLength(2);
    });

    // The discriminating half: a guard that simply never armed `activeQuery`
    // would pass both cases above and fail here.
    expect(await runtime.interruptQuery(sessionId), 'Stop could not reach a live turn').toBe(true);

    process.answer(process.received[1]!);
    await running;
  });

  // DOR-1191. The first turn of a cold session passes warming -> warm ->
  // running, and only reaches running once `system/init` arrives — up to
  // INIT_TIMEOUT_MS later. `session.activeQuery` arms on that running edge, so a
  // Stop pressed while the process is still booting used to find nothing and do
  // nothing: exactly when someone Stops a mis-send. It must reach the booting
  // turn through the live query the pump already holds.
  it('reaches a first turn that is still booting', async () => {
    const sessionId = nextSession();
    // The process boots but holds `system/init`, so the first turn parks in the
    // launch window rather than reaching the model.
    cli.deferNextInit = true;

    const booting = turn(sessionId, 'a mis-send, stopped before it lands');
    const process = await vi.waitFor(() => {
      expect(cli.launches).toBe(1);
      return cli.processes[0]!;
    });
    // The pump is warming: no turn has reached the model, so warmth is not yet
    // `running` and the ordinary Stop path (`session.activeQuery`) is empty.
    expect(runtime.getSessionWarmth(sessionId)).toBe('warming');

    // The person presses Stop while the mis-send is still booting.
    expect(
      await runtime.interruptQuery(sessionId),
      'Stop could not reach a turn that was still booting'
    ).toBe(true);
    // And it actually reached the process, through the same graceful interrupt
    // the running path uses — not a bookkeeping `true` that stopped nothing.
    expect(process.interrupts).toBe(1);

    // Let the (now-interrupted) boot finish so the hanging turn settles rather
    // than leaking into the next case.
    process.reportReady();
    const events = await booting;
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});

describe('what a warm process must be re-checked for', () => {
  beforeEach(() => {
    optIn.persistentSession = true;
  });

  it('replaces the process when a pin the SDK cannot set live has moved', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    expect(cli.launches).toBe(1);

    // `systemPromptAppend` is a relaunch pin: a warm process cannot be moved
    // onto a new system prompt, so riding it would run every later turn under
    // the old one.
    const { buildSystemPromptAppend } = await import('../../messaging/context-builder.js');
    vi.mocked(buildSystemPromptAppend).mockResolvedValue('<env>MOVED</env>');

    await turn(sessionId, 'after the change');

    expect(cli.launches).toBe(2);
    expect(cli.processes[0]!.ended).toBe(true);
    expect(cli.processes[1]!.options.systemPrompt).toMatchObject({ append: '<env>MOVED</env>' });
  });

  it('moves a live pin on the running process instead of replacing it', async () => {
    const sessionId = nextSession();
    await turn(sessionId);

    await runtime.updateSession(sessionId, { model: 'claude-opus-4-6' });
    await turn(sessionId, 'on the new model');

    // Same process, moved onto the new model. A composition that relaunched
    // here would throw away a warm prompt cache for a change the SDK can make
    // in place.
    expect(cli.launches).toBe(1);
    expect(cli.processes[0]!.liveSets).toContain('setModel:claude-opus-4-6');
  });

  it('refuses a turn outside the boundary WITHOUT costing the session its process', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    expect(runtime.getSessionWarmth(sessionId)).toBe('warm');

    vi.mocked(validateBoundaryOrDorkHome).mockRejectedValueOnce(new Error('outside the boundary'));
    const events: StreamEvent[] = [];
    for await (const event of runtime.sendMessage(sessionId, 'go somewhere else', {
      cwd: '/etc',
    })) {
      events.push(event);
    }

    expect(events.some((e) => e.type === 'error')).toBe(true);
    // The gate is asked BEFORE the pin comparison for exactly this reason: cwd
    // is a relaunch pin, so a refusal reached after the comparison would have
    // torn the warm process down on its way to saying no.
    expect(cli.launches).toBe(1);
    expect(runtime.getSessionWarmth(sessionId)).toBe('warm');
  });
});

describe('a turn nobody asked for', () => {
  beforeEach(() => {
    optIn.persistentSession = true;
  });

  it('cannot close the turn a person is actually watching', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    const process = cli.processes[0]!;
    process.goSilent();

    // A message the person sent, deliberately left unanswered...
    const watching = turn(sessionId, 'my actual message');
    await vi.waitFor(() => {
      expect(process.received).toHaveLength(2);
    });
    // ...and then the CLI answers something DorkOS never sent, while that turn
    // is open. Correlation is by id: this `result` names a message this session
    // never dispatched, so it gets a window of its own and the person's window
    // stays open. Answer the real one afterwards and the turn closes on ITS
    // result, once.
    process.emit(resultMessage('a-message-nobody-dispatched'));
    process.emit({ type: 'stream_event', event: { type: 'ping' } } as never);
    process.answer(process.received[1]!, 'the real answer');

    const events = await watching;
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(
      events.some((e) => e.type === 'text_delta'),
      "the person's turn carried its own answer"
    ).toBe(true);
    expect(cli.launches).toBe(1);
  });
});
