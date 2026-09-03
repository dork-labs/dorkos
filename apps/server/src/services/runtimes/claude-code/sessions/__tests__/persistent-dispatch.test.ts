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
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEvent, SessionStatus } from '@dorkos/shared/session-stream';
import type { StreamEvent } from '@dorkos/shared/types';

const optIn = vi.hoisted(() => ({ persistentSession: false }));

vi.mock('../../claude-config-dir.js', () => ({
  resolveActiveClaudeRoot: () => '/tmp/fake-claude',
  resolveLaunchAccountRoot: () => '/tmp/fake-claude',
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
  buildSystemPromptAppend: vi
    .fn()
    .mockResolvedValue({ text: '<env>test</env>', stable: '<env>test</env>' }),
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
// A class, not `vi.fn().mockImplementation(() => ({…}))` — the runtime `new`s
// this, and an arrow-function implementation is not constructible. That only
// surfaces on a message the launch resolver checks against the command list,
// i.e. one starting with `/`, so it stayed invisible until a `/compact` turn.
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
  // `interactive-handlers.ts` builds the rooms auto-allow gate from this at
  // launch (DOR-1229). Nothing here calls a rooms verb, so the resolver only has
  // to exist — but it must, or every launch on this path throws on the mock.
  createInSessionContextResolver: () => () => Promise.resolve(undefined),
}));
// One warm process at a time, so warming a second session reclaims the first's
// pump through the registry WITHOUT telling PersistentDispatch — the stale-bundle
// case a steer must survive without throwing (task 4.1 finding 2). Every other
// SESSIONS value is preserved.
vi.mock('../../../../../config/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../config/constants.js')>();
  return { ...actual, SESSIONS: { ...actual.SESSIONS, MAX_WARM_SESSIONS: 1 } };
});

import { query } from '@anthropic-ai/claude-agent-sdk';
import { validateBoundaryOrDorkHome } from '../../../../../lib/boundary.js';
import { feedProjector } from '../../../../session/session-event-normalizer.js';
import { SessionStateProjector } from '../../../../session/session-state-projector.js';
import { ClaudeCodeRuntime } from '../../claude-code-runtime.js';
import { STOP_ACK_TIMEOUT_MS } from '../bounded-control.js';
import { FakeCli, resultMessage, type FakeCliProcess } from './fake-persistent-cli.js';

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

/** Every word the model spoke on a turn's stream, in order. */
function spokenText(events: StreamEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === 'text_delta' ? [(event.data as { text: string }).text] : []
  );
}

/**
 * The `result` the CLI sends for a turn that was CUT SHORT — an error subtype
 * with an abort terminal reason. The CLI produces this shape for a stop it
 * acked AND for aborts nobody asked for, which is why the error-frame
 * suppression needs DorkOS's own stop record too (DOR-1320).
 */
function abortedResult(userMessageUuid: string): SDKMessage {
  return {
    ...(resultMessage(userMessageUuid) as unknown as Record<string, unknown>),
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'aborted_streaming',
    errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
  } as unknown as SDKMessage;
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

describe('steerability is answered per session (DOR-1268)', () => {
  it('says NO on the resume path, which is how a default install ships', async () => {
    const sessionId = nextSession();

    // The reported bug in one line: the adapter declares `supportsSteer`, and a
    // session that starts a fresh process per message has nothing to push into.
    // Answered before any message, because the composer asks before the turn it
    // would steer is open.
    expect(runtime.canSteerSession(sessionId)).toBe(false);

    await turn(sessionId);
    expect(runtime.canSteerSession(sessionId)).toBe(false);
  });

  it('reports no-open-turn for a steer while a resume-path turn is in flight', async () => {
    const sessionId = nextSession();
    // A turn that has launched and not finished — precisely the moment the
    // composer offered a cut-in.
    cli.deferNextInit = true;
    const running = turn(sessionId, 'do the thing');
    await vi.waitFor(() => expect(cli.processes).toHaveLength(1));

    // The mechanism that would cut in is not under this session, so the receipt
    // is the SAME one an idle session gives. That collision is why the
    // dispatcher stopped reading this receipt as `session-idle`.
    const receipt = await runtime.deliverIntoTurn(sessionId, 'course-correct', {
      mode: 'steer',
      messageId: 'steer-resume',
    });
    expect(receipt).toEqual({ delivered: false, reason: 'no-open-turn' });
    expect(runtime.canSteerSession(sessionId)).toBe(false);

    cli.processes[0]!.reportReady();
    await running;
  });

  it('says YES once the opt-in is on, and keeps saying it while the process is held', async () => {
    optIn.persistentSession = true;
    const sessionId = nextSession();

    // True BEFORE the first message: the next turn will run on a held process,
    // so a turn opened here would be joinable.
    expect(runtime.canSteerSession(sessionId)).toBe(true);
    await turn(sessionId);
    expect(runtime.canSteerSession(sessionId)).toBe(true);

    // The operator changes their mind. A session already holding its process
    // keeps it — and keeps being steerable — until that process goes away.
    optIn.persistentSession = false;
    expect(runtime.canSteerSession(sessionId)).toBe(true);

    // Given back: the next message re-reads the flag and finds it off.
    await runtime.reapSession(sessionId);
    expect(runtime.canSteerSession(sessionId)).toBe(false);
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

  // Pins the interrupt-FAILURE escalation at exactly this seam. `interrupt()`
  // before `system/init` writes a control request to the subprocess and awaits
  // the CLI's response, so it HANGS in the healthy case and only REJECTS when
  // the stdin write fails because the process already died mid-boot (the SDK's
  // `request()` rejects on a failed `transport.write`; the `Cr` wrapper
  // re-throws). On that rejection the Stop escalates to a forceful `close()`,
  // exactly as the running path does — so a booting Stop crashes the pump the
  // same way a running Stop does when `interrupt()` rejects.
  //
  // CLOSED for the Stop path (DOR-1192, task 4.7, at the retirement/adoption
  // layer where it belongs): a boot that ends here produces error+done with NO
  // `turn_start`, and a queued row retires ONLY on `turn_start`
  // (`message-dispatcher.ts` `onTurnStart` → `store.remove`). So on its own the
  // stopped message's durable row is not retired and `adoptQueuedMessages` would
  // re-run it on the next `dispatchMessage`. A Stop now clears the DorkOS queue
  // (`clearQueuedMessages`, the sole caller, driven by the interrupt route BEFORE
  // the interrupt), which sweeps exactly this un-retired booting row, so nothing
  // is left to re-adopt. DOR-1192 is Stop-scoped: a boot that fails on its OWN
  // with no user Stop still leaves the row for `adoptQueuedMessages` to re-run —
  // that is desired crash recovery (the message never ran), not the bug. The
  // Stop-clears re-run is not observable HERE (this harness wires no
  // `MessageQueueStore`, and the fix sits above the pump/dispatch seam this test
  // drives); it is pinned at the retirement/adoption layer by
  // `message-dispatcher.test.ts` → 'a Stop during a booting first turn clears the
  // un-retired row so it does not re-run'.
  it('escalates to a forceful close when interrupt fails on a booting turn', async () => {
    const sessionId = nextSession();
    cli.deferNextInit = true;

    const booting = turn(sessionId, 'a mis-send during a failing boot');
    const process = await vi.waitFor(() => {
      expect(cli.launches).toBe(1);
      return cli.processes[0]!;
    });
    // The graceful interrupt rejects the way a dead-process control write does.
    process.interruptRejectsWith = new Error('control write failed: the process is gone');

    expect(await runtime.interruptQuery(sessionId)).toBe(true);
    // Graceful attempted, then escalated to the forceful close — one of each.
    expect(process.interrupts).toBe(1);
    expect(process.closed).toBe(1);

    // The close ends the booting process, so the turn settles rather than
    // hanging — and it settles as the Stop it was. This seam used to REJECT with
    // the raw `process-gone` launch failure, which `guardTurnErrors` one layer
    // up rendered as a turn error with a stack on it: a crash report for
    // something the operator did (DOR-1302; the settle is asserted in full,
    // through the projector, in that describe below).
    const events = await booting;
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    // And the pump still reports the death honestly where warmth is read: the
    // process really is gone, and the next message relaunches it.
    expect(runtime.getSessionWarmth(sessionId)).toBe('crashed');
  });

  // DOR-1320. The stop RECORD is a WeakSet keyed by query. On the resume path
  // one query is one turn, so it is per-turn for free; a pump runs many turns
  // on ONE query object, so without a per-turn clear a single Stop marks every
  // later turn on that warm process as stopped — and the error-frame
  // suppression it gates would swallow a genuine failure turns later.
  it('does not let one turn Stop suppress a LATER turn failure', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    const process = cli.processes[0]!;
    process.goSilent();

    // Turn 2: the person stops it, and the CLI acks and winds down.
    const stopped = turn(sessionId, 'stop this one');
    await vi.waitFor(() => expect(process.received).toHaveLength(2));
    expect(await runtime.interruptQuery(sessionId)).toBe(true);
    process.emit(abortedResult(process.received[1]!));
    const stoppedEvents = await stopped;
    expect(
      stoppedEvents.some((e) => e.type === 'error'),
      'the stopped turn kept an error frame'
    ).toBe(false);

    // Turn 3 on the SAME warm process genuinely fails, and its `result` carries
    // the same abort shape the CLI reuses. Nobody stopped this one.
    const failing = turn(sessionId, 'this one really breaks');
    await vi.waitFor(() => expect(process.received).toHaveLength(3));
    process.emit(abortedResult(process.received[2]!));
    const failedEvents = await failing;

    expect(
      failedEvents.some((e) => e.type === 'error'),
      'a Stop two turns ago silenced this failure'
    ).toBe(true);
  });
});

// DOR-1302. A Stop the CLI will not answer escalates to `query.close()`, and on
// the pump that close is a PROCESS DEATH: the same `onCrash` seam a real crash
// arrives on. Read as a crash it cost the operator twice — the turn they ended
// settled as a failure with a red frame on it, and the close spent one of the
// two lives in `SessionCrashRecovery`'s bound, so two Stops in a row made the
// THIRD message refuse with "This chat's agent keeps stopping".
//
// The escalation is driven here through a REFUSED interrupt rather than an
// unacked one. Both reach the same line (`interruptGivenQuery`: anything that is
// not an ack escalates), and a refusal reaches it without a three-second wall
// clock in a unit test — see the ack case at the bottom for why paying that bound
// is the unacked path's own cost and not this behavior's.
describe('a Stop that had to kill the process settles as the stop it was (DOR-1302)', () => {
  beforeEach(() => {
    optIn.persistentSession = true;
  });

  /**
   * Warm a session and leave its process unable to answer — the state every
   * case here needs, since a turn that answers itself is never stopped.
   */
  async function warmThenGoSilent(sessionId: string): Promise<FakeCliProcess> {
    await turn(sessionId);
    const process = cli.processes[0]!;
    process.goSilent();
    return process;
  }

  /**
   * Press Stop on the running turn with the CLI refusing to hear it, so the
   * Stop escalates to the forceful close.
   *
   * @param sessionId - The session whose live turn is being stopped
   * @param process - The process running it
   */
  async function stopWithAnUnhearableCli(
    sessionId: string,
    process: FakeCliProcess
  ): Promise<void> {
    process.interruptRejectsWith = new Error('control write failed: the process is gone');
    expect(await runtime.interruptQuery(sessionId), 'Stop did not reach the live turn').toBe(true);
  }

  /** Feed one turn's events through the real normalizer and projector. */
  async function project(
    sessionId: string,
    events: StreamEvent[]
  ): Promise<{ status: SessionStatus; stream: SessionEvent[] }> {
    const projector = new SessionStateProjector(sessionId);
    await feedProjector(
      projector,
      (async function* () {
        yield* events;
      })(),
      { userMessage: 'stop this one' }
    );
    return { status: projector.getStatus(), stream: projector.replayFrom(0) };
  }

  it('closes the open turn as interrupted, with no crash notice', async () => {
    const sessionId = nextSession();
    const process = await warmThenGoSilent(sessionId);

    const stopped = turn(sessionId, 'stop this one');
    await vi.waitFor(() => expect(process.received).toHaveLength(2));
    await stopWithAnUnhearableCli(sessionId, process);

    const events = await stopped;
    // The escalation really happened: this is the close path, not an ack.
    expect(process.interrupts).toBe(1);
    expect(process.closed).toBe(1);

    // The turn ends exactly once, and says it was cut short ON PURPOSE — the
    // reason plus DorkOS's own record of having asked, which is what keeps an
    // abort nobody requested settling as the failure it is.
    const status = events.find(
      (e) => e.type === 'session_status' && (e.data as { terminalReason?: string }).terminalReason
    );
    expect(status?.data).toMatchObject({ terminalReason: 'interrupted', stopWasRequested: true });
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(
      events.some((e) => e.type === 'error'),
      'the operator was shown a failure for a turn they ended themselves'
    ).toBe(false);

    // And that survives the wire: the same events through the real normalizer
    // and projector settle `interrupted`, which is what a cold hydrate reads.
    const projected = await project(sessionId, events);
    expect(projected.stream.at(-1)).toMatchObject({
      type: 'turn_end',
      terminalReason: 'interrupted',
    });
    expect(projected.status.lifecycle).toBe('interrupted');
    expect(projected.status.lastError).toBeNull();
  });

  // The STARTING phase, which the case above does not reach and which needed a
  // second seam. A Stop pressed while the first turn is still launching kills the
  // process before `system/init`, so the launch this dispatch is parked on
  // rejects: the window the windower settled correctly is never streamed, and
  // the refusal used to be rethrown for `guardTurnErrors` to render as a turn
  // error with a raw `process-gone` stack. The person pressed Stop and was shown
  // a crash. `explainRefusedDispatch` answers it as the resume path answers its
  // own version instead.
  //
  // The deferred boot is NEVER released here — that is the whole point. Calling
  // `reportReady()` first would let the pump reach `warm`, and the Stop would
  // then take the running path the case above already covers.
  it('settles a Stop pressed while the first turn is still launching', async () => {
    const sessionId = nextSession();
    cli.deferNextInit = true;

    const booting = turn(sessionId, 'a mis-send, stopped before it lands');
    const process = await vi.waitFor(() => {
      expect(cli.launches).toBe(1);
      return cli.processes[0]!;
    });
    // No `running` edge has fired, so the ordinary Stop path finds nothing and
    // this reaches the process through `bootingQuery` (DOR-1191).
    expect(runtime.getSessionWarmth(sessionId)).toBe('warming');
    await stopWithAnUnhearableCli(sessionId, process);
    expect(process.closed).toBe(1);

    // It settles instead of rejecting, and it settles as a stop.
    const events = await booting;
    const status = events.find(
      (e) => e.type === 'session_status' && (e.data as { terminalReason?: string }).terminalReason
    );
    expect(status?.data).toMatchObject({ terminalReason: 'interrupted', stopWasRequested: true });
    expect(
      events.some((e) => e.type === 'error'),
      'a Stop during launch was reported as a failure'
    ).toBe(false);
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);

    const projected = await project(sessionId, events);
    expect(projected.stream.at(-1)).toMatchObject({
      type: 'turn_end',
      terminalReason: 'interrupted',
    });
    expect(projected.status.lifecycle).toBe('interrupted');

    // And the session is not spent: the next message relaunches and answers.
    const next = await turn(sessionId, 'try again');
    expect(spokenText(next)).toEqual(['ok']);
    expect(cli.launches).toBe(2);
  });

  // The discriminating half. A rule that simply stopped calling deaths crashes
  // would pass the case above and lose the failure this one has to keep.
  it('still settles a death nobody asked for as the crash it is', async () => {
    const sessionId = nextSession();
    const process = await warmThenGoSilent(sessionId);

    const dying = turn(sessionId, 'this one dies on its own');
    await vi.waitFor(() => expect(process.received).toHaveLength(2));
    process.crash(new Error('killed mid-turn'));

    const events = await dying;
    expect(
      events.some((e) => e.type === 'error'),
      'a genuine crash lost its failure'
    ).toBe(true);
    const status = events.find(
      (e) => e.type === 'session_status' && (e.data as { terminalReason?: string }).terminalReason
    );
    expect(status, 'a crash claimed a terminal reason it never had').toBeUndefined();

    const projected = await project(sessionId, events);
    expect(projected.stream.at(-1)).toMatchObject({ type: 'turn_end', terminalReason: 'error' });
    expect(projected.status.lifecycle).toBe('error');
    // The pump reports the death honestly where warmth is read, and the next
    // message is a recovery relaunch.
    expect(runtime.getSessionWarmth(sessionId)).toBe('crashed');
  });

  // The second half of the bug, and the one a person actually met. The crash
  // bound allows ONE automatic relaunch, and only a COMPLETED turn resets it — a
  // stopped turn never completes. So two escalated Stops spent both lives and
  // the third message was refused, blaming the agent for the operator's own
  // Stops.
  it('does not spend the crash budget, so a third message after two Stops still runs', async () => {
    const sessionId = nextSession();

    for (const [index, attempt] of ['stop the first', 'stop the second'].entries()) {
      // Held at `system/init` so the process can be silenced BEFORE it reads
      // anything: a process left to itself answers the moment it reads, and the
      // turn would finish rather than be stopped.
      cli.deferNextInit = true;
      const stopped = turn(sessionId, attempt);
      const process = await vi.waitFor(() => {
        expect(cli.launches).toBe(index + 1);
        return cli.latest!;
      });
      process.goSilent();
      process.reportReady();
      await vi.waitFor(() => expect(process.received).toHaveLength(1));
      await stopWithAnUnhearableCli(sessionId, process);
      await stopped;
    }

    // Two Stops, two dead processes. The third message must be a relaunch, not
    // a refusal.
    const third = await turn(sessionId, 'still there?');
    expect(
      third.some(
        (e) =>
          e.type === 'error' &&
          (e.data as { message?: string }).message?.includes('keeps stopping') === true
      ),
      'DorkOS blamed the agent for two Stops the operator pressed'
    ).toBe(false);
    expect(spokenText(third)).toEqual(['ok']);
    // Three processes: the first two the Stops killed, and the one that answered.
    expect(cli.launches).toBe(3);
  });

  // Validation criterion 4, answered structurally rather than with a clock. The
  // bound is only ever PAID by an ack that never comes, and the one observable
  // cost of paying it is the escalation — so an acked Stop that closes nothing
  // is a Stop that did not wait. The elapsed check is the belt to that braces:
  // three seconds is the bound, and a healthy ack lands in microtasks.
  it('does not pay the ack bound when the CLI answers the Stop', async () => {
    const sessionId = nextSession();
    const process = await warmThenGoSilent(sessionId);

    const stopped = turn(sessionId, 'stop this one politely');
    await vi.waitFor(() => expect(process.received).toHaveLength(2));

    const askedAt = Date.now();
    expect(await runtime.interruptQuery(sessionId)).toBe(true);
    const ackMs = Date.now() - askedAt;

    expect(process.interrupts).toBe(1);
    expect(process.closed, 'an acked Stop escalated to a close it never needed').toBe(0);
    expect(ackMs).toBeLessThan(STOP_ACK_TIMEOUT_MS);
    // The process survived, so the CLI still gets to wind the turn down itself.
    expect(process.ended).toBe(false);
    process.emit(abortedResult(process.received[1]!));
    await stopped;
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
    vi.mocked(buildSystemPromptAppend).mockResolvedValue({
      text: '<env>MOVED</env>',
      stable: '<env>MOVED</env>',
    });

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

describe('deliverIntoTurn — a steer reaches the running turn (task 4.1)', () => {
  beforeEach(() => {
    optIn.persistentSession = true;
  });

  it('pushes the person’s words into the open turn, pristine, context out of band', async () => {
    const sessionId = nextSession();
    await turn(sessionId); // warms the process
    const process = cli.processes[0]!;
    process.goSilent();

    // A turn is opened and left running (goSilent). Wait until its message has
    // been READ — the window is open — before steering into it.
    const running = turn(sessionId, 'do the thing');
    await vi.waitFor(() => expect(process.received).toHaveLength(2));

    const receipt = await runtime.deliverIntoTurn(sessionId, 'please also check the tests', {
      mode: 'steer',
      messageId: 'steer-1',
      additionalContext: [
        { kind: 'queue_note', scope: 'per-turn', data: { composedDuringPrevTurn: true } },
      ],
    });
    expect(receipt).toEqual({ delivered: true });

    await vi.waitFor(() => expect(process.received).toHaveLength(3));
    // AC5: the person's words reach the model byte-for-byte, and the context
    // rides its own tagged block AHEAD of them (renderContextEntry is mocked to
    // `<kind>mock</kind>`) — never woven into what they typed.
    expect(process.inbox.at(-1)).toEqual({
      uuid: 'steer-1',
      content: '<queue_note>mock</queue_note>\n\nplease also check the tests',
    });

    // AC1 + AC4, end to end: the CLI coalesces the steer into the SAME turn and
    // answers with ONE result naming it, and the turn closes as ONE turn with
    // ONE terminal. A broken window correlation would strand this turn open and
    // hang the await.
    process.answer('steer-1');
    const events = await running;
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    // One process throughout: a steer opened no second turn and forced no
    // relaunch.
    expect(cli.launches).toBe(1);
  });

  it('reports no-open-turn on a warm idle session, without throwing', async () => {
    const sessionId = nextSession();
    await turn(sessionId); // warm, and now idle
    expect(runtime.getSessionWarmth(sessionId)).toBe('warm');

    const receipt = await runtime.deliverIntoTurn(sessionId, 'nobody to steer', {
      mode: 'steer',
      messageId: 'steer-1',
    });

    expect(receipt).toEqual({ delivered: false, reason: 'no-open-turn' });
    // Nothing was pushed: the warm process still holds only its first turn's one
    // message.
    expect(cli.processes[0]!.received).toHaveLength(1);
  });

  it('refuses a steer in the close gap and pushes nothing (finding 3)', async () => {
    const sessionId = nextSession();
    await turn(sessionId); // warms the process
    const process = cli.processes[0]!;
    process.goSilent();

    const running = turn(sessionId, 'do the thing');
    await vi.waitFor(() => expect(process.received).toHaveLength(2)); // window open

    // Enter the CLOSE GAP: hold the per-close accounting fetch so `endTurn` is
    // deferred. The `result` clears the open window synchronously, but the pump
    // stays RUNNING until the held fetch returns — up to ~8s in production. A
    // steer that gated on the pump's `'running'` state would push into this gap
    // and open a phantom SECOND turn while claiming `delivered`.
    process.holdControls = true;
    process.answer(process.received[1]!); // the result that closes the window
    await vi.waitFor(() => expect(process.parkedControls).toBeGreaterThan(0));

    // The pump still says 'running'; there is no window to join.
    expect(runtime.getSessionWarmth(sessionId)).toBe('running');

    const receipt = await runtime.deliverIntoTurn(sessionId, 'too late', {
      mode: 'steer',
      messageId: 'late-1',
    });

    // Gating on WINDOW openness, not the pump state: refused, and nothing pushed.
    expect(receipt).toEqual({ delivered: false, reason: 'no-open-turn' });
    expect(process.received).toHaveLength(2);

    // Release the fetch; the turn settles as exactly ONE turn.
    process.releaseControls();
    const events = await running;
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('degrades rather than throwing when the bundle points at a reaped pump (finding 2)', async () => {
    const a = nextSession();
    await turn(a);
    expect(runtime.getSessionWarmth(a)).toBe('warm');

    // Warming a second session reclaims A's warm pump (the ceiling is 1 here),
    // and the registry does it WITHOUT telling PersistentDispatch — so A's bundle
    // lingers, pointing at a spent pump whose every method throws.
    const b = nextSession();
    await turn(b);
    expect(runtime.getSessionWarmth(a)).toBe('cold');

    // A steer to A must degrade, never throw out of the must-not-throw contract.
    const receipt = await runtime.deliverIntoTurn(a, 'steer the reaped one', {
      mode: 'steer',
      messageId: 'reaped-1',
    });

    expect(receipt).toEqual({ delivered: false, reason: 'no-open-turn' });
  });

  // Purpose: the SAME reclaim-behind-this-class's-back as finding 2 above, but
  // asserting the log rather than the degrade. This exit used to be invisible
  // below `debug` — a session mid-flow paying for a fresh process boot with
  // nothing in the log explaining why (DOR-1323, flag-on run L-11). The first
  // turn (a genuine cold start) must NOT log it; only the relaunch that
  // follows the reclaim should.
  it('logs at info when a dispatch relaunches after the registry reclaimed this session (DOR-1323)', async () => {
    const { logger } = await import('../../../../../lib/logger.js');
    const a = nextSession();
    vi.mocked(logger.info).mockClear();
    await turn(a);
    expect(
      vi.mocked(logger.info).mock.calls.some(([msg]) => String(msg).includes('relaunching'))
    ).toBe(false);

    // Warming a second session reclaims A's warm pump (the ceiling is 1 here),
    // WITHOUT telling PersistentDispatch — A's bundle now points at a spent pump.
    const b = nextSession();
    await turn(b);
    expect(runtime.getSessionWarmth(a)).toBe('cold');

    vi.mocked(logger.info).mockClear();
    await turn(a, 'again, after the reclaim');

    expect(cli.launches).toBe(3);
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      '[persistent-dispatch] relaunching after the registry reaped this session',
      expect.objectContaining({ session: a })
    );
  });
});

describe('deliverIntoTurn — a stage reaches the transcript with no turn (task 4.2)', () => {
  beforeEach(() => {
    optIn.persistentSession = true;
  });

  it('warms a COLD session and appends, without running a turn (AC1, AC6)', async () => {
    const sessionId = nextSession();
    expect(runtime.getSessionWarmth(sessionId)).toBe('cold');

    const receipt = await runtime.deliverIntoTurn(sessionId, 'use the staging bucket', {
      mode: 'stage',
      messageId: 'stage-1',
    });
    expect(receipt).toEqual({ delivered: true });

    // AC6: a cold session warmed — exactly one process — and it is WARM (idle),
    // NOT running a turn. AC1: no turn ran, so nothing was answered and there is
    // no querying message on the process at all.
    expect(cli.launches).toBe(1);
    expect(runtime.getSessionWarmth(sessionId)).toBe('warm');
    const process = cli.processes[0]!;
    await vi.waitFor(() => expect(process.staged).toHaveLength(1));
    // The person's words reached the transcript pristine (no context bag here).
    expect(process.staged).toEqual([{ uuid: 'stage-1', content: 'use the staging bucket' }]);
    // AC1, the load-bearing half: a stage provokes NO turn — no result, no cost.
    expect(process.answered).toBe(0);
    expect(process.received).toHaveLength(0);
  });

  it('appends onto a WARM session without a new process or a turn (AC1)', async () => {
    const sessionId = nextSession();
    await turn(sessionId); // warms via a real turn
    expect(runtime.getSessionWarmth(sessionId)).toBe('warm');
    const process = cli.processes[0]!;
    const answeredBefore = process.answered;

    const receipt = await runtime.deliverIntoTurn(sessionId, 'attach this', {
      mode: 'stage',
      messageId: 'stage-1',
    });
    expect(receipt).toEqual({ delivered: true });

    await vi.waitFor(() => expect(process.staged).toHaveLength(1));
    // The warm process took it — no relaunch — and ran no turn for it.
    expect(cli.launches).toBe(1);
    expect(process.answered).toBe(answeredBefore);
    expect(runtime.getSessionWarmth(sessionId)).toBe('warm');
  });

  it('keeps the person’s words pristine and rides context out of band (ADR-0273)', async () => {
    const sessionId = nextSession();

    await runtime.deliverIntoTurn(sessionId, 'ship it', {
      mode: 'stage',
      messageId: 'stage-1',
      additionalContext: [
        { kind: 'queue_note', scope: 'per-turn', data: { composedDuringPrevTurn: true } },
      ],
    });

    const process = cli.processes[0]!;
    await vi.waitFor(() => expect(process.staged).toHaveLength(1));
    // The context rides its own tagged block AHEAD of the person's words
    // (renderContextEntry is mocked to `<kind>mock</kind>`) — never woven in.
    expect(process.staged[0]).toEqual({
      uuid: 'stage-1',
      content: '<queue_note>mock</queue_note>\n\nship it',
    });
  });

  it('lets a staged note be followed by a querying turn, in order (AC2)', async () => {
    const sessionId = nextSession();

    await runtime.deliverIntoTurn(sessionId, 'context first', {
      mode: 'stage',
      messageId: 'stage-1',
    });
    const process = cli.processes[0]!;
    await vi.waitFor(() => expect(process.staged).toHaveLength(1));

    // A real turn on the now-warm process. The staged note is already on the
    // transcript ahead of it; the SDK merges the two, which is its own contract.
    await turn(sessionId, 'now do the thing');

    // Same process throughout — the stage did not force a relaunch — and the
    // querying message ran a turn while the staged note stayed a bare append.
    expect(cli.launches).toBe(1);
    expect(process.staged).toEqual([{ uuid: 'stage-1', content: 'context first' }]);
    expect(process.inbox.at(-1)!.content).toBe('now do the thing');
    expect(process.answered).toBe(1);
  });

  // DOR-1294, through the composition rather than the windower. A staged note is
  // merged into the next querying message by the CLI, and the merged turn's one
  // `result` can name the STAGED id — an id the windower never saw, because a
  // stage opens no window. Unless the dispatcher tells the windower about it,
  // that result reads as one nobody sent, the dispatched window is left with no
  // result that can close it, and this turn never ends. Delete the
  // `noteStagedMessage` call in `PersistentDispatch.stage` and this hangs.
  it('closes the dispatched window when the result names the staged message', async () => {
    const sessionId = nextSession();

    await runtime.deliverIntoTurn(sessionId, 'context first', {
      mode: 'stage',
      messageId: 'stage-1',
    });
    const process = cli.processes[0]!;
    await vi.waitFor(() => expect(process.staged).toHaveLength(1));
    // The result is ours to time, so the merge can be modelled exactly.
    process.goSilent();

    const running = turn(sessionId, 'now do the thing');
    await vi.waitFor(() => expect(process.received).toHaveLength(1));

    // One turn, one result — and it names the note, not the message that ran.
    process.answer('stage-1');

    await vi.waitFor(() => expect(runtime.getSessionWarmth(sessionId)).toBe('warm'));
    const events = await running;
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(cli.launches).toBe(1);
  });

  it('appends two staged notes before one dispatch, in order (AC5)', async () => {
    const sessionId = nextSession();

    await runtime.deliverIntoTurn(sessionId, 'first note', { mode: 'stage', messageId: 'stage-1' });
    await runtime.deliverIntoTurn(sessionId, 'second note', {
      mode: 'stage',
      messageId: 'stage-2',
    });

    const process = cli.processes[0]!;
    await vi.waitFor(() => expect(process.staged).toHaveLength(2));
    expect(process.staged.map((m) => m.content)).toEqual(['first note', 'second note']);
    // Both onto the one warm process, and neither ran a turn.
    expect(cli.launches).toBe(1);
    expect(process.answered).toBe(0);
  });
});

// DOR-1307. Every case in the block above turns the opt-in ON, which is how the
// one path that starts a process for a staged message went untested with the
// setting in the state it ships in. With it OFF, "Add context" was warming a real
// CLI subprocess AND registering the session, so every later message ran on the
// pump and the composer started offering Steer — a session opting itself into an
// experiment nobody switched on. The opt-in stays OFF here (the file's
// `beforeEach` leaves it off), which is the whole point of the block.
describe('Add context starts nothing while the opt-in is off (DOR-1307)', () => {
  it('refuses a stage on a COLD session, launching nothing and registering nothing', async () => {
    const sessionId = nextSession();
    expect(runtime.getSessionWarmth(sessionId)).toBe('cold');

    const receipt = await runtime.deliverIntoTurn(sessionId, 'use the staging bucket', {
      mode: 'stage',
      messageId: 'stage-off-1',
    });

    // The refusal the server reads as "fold it into the next turn instead".
    expect(receipt).toEqual({ delivered: false, reason: 'unsupported' });
    // Not one process. This is the assertion the bug fails: it booted one here.
    expect(cli.launches).toBe(0);
    expect(cli.processes).toHaveLength(0);
    expect(runtime.getSessionWarmth(sessionId)).toBe('cold');
    // And no registry entry, which is the half that OUTLIVED the stage: any entry
    // makes `shouldDispatch` true forever after, so every later message runs on
    // the pump path. Both per-session answers read that registry, so both prove
    // it is still empty.
    expect(runtime.canStageSession(sessionId)).toBe(false);
    expect(runtime.canSteerSession(sessionId)).toBe(false);
  });

  it('leaves the NEXT message on the resume path', async () => {
    const sessionId = nextSession();

    await runtime.deliverIntoTurn(sessionId, 'a note', { mode: 'stage', messageId: 'stage-off-2' });
    await turn(sessionId, 'now do the thing');

    // ONE process — the turn's own, started and given back the way the resume
    // path always does. A stage that had warmed one would make this two, or make
    // the session `warm` afterwards.
    expect(cli.launches).toBe(1);
    expect(runtime.getSessionWarmth(sessionId)).toBe('cold');
    expect(runtime.canSteerSession(sessionId)).toBe(false);
  });

  it('starts no SECOND process while a resume-path turn is running', async () => {
    const sessionId = nextSession();
    // A turn that has launched and not finished — precisely when a person reaches
    // for Add context, and the moment the cold path would have raced a second
    // process onto the same session.
    cli.deferNextInit = true;
    const running = turn(sessionId, 'do the thing');
    await vi.waitFor(() => expect(cli.processes).toHaveLength(1));

    const receipt = await runtime.deliverIntoTurn(sessionId, 'also check the tests', {
      mode: 'stage',
      messageId: 'stage-off-3',
    });

    expect(receipt).toEqual({ delivered: false, reason: 'unsupported' });
    expect(cli.launches).toBe(1);
    // The running turn's own process never saw the staged words either — they
    // ride the NEXT dispatch, which the dispatcher owns (message-dispatcher.test).
    expect(cli.processes[0]!.staged).toHaveLength(0);

    cli.processes[0]!.reportReady();
    await running;
  });

  it('stages natively again the moment the operator opts in', async () => {
    const sessionId = nextSession();
    expect(runtime.canStageSession(sessionId)).toBe(false);

    optIn.persistentSession = true;
    expect(runtime.canStageSession(sessionId)).toBe(true);

    const receipt = await runtime.deliverIntoTurn(sessionId, 'now it can land', {
      mode: 'stage',
      messageId: 'stage-on-1',
    });
    expect(receipt).toEqual({ delivered: true });
    expect(cli.launches).toBe(1);
    await vi.waitFor(() => expect(cli.processes[0]!.staged).toHaveLength(1));
  });
});

// DOR-1235. A `/compact` turn produces no assistant output at all — the SDK
// compacts, the model has nothing left to say, and the turn closes on the
// boundary alone. The empty-stream guard used to read that as a dead stream, so
// a compaction that visibly worked reported "stopped unexpectedly". The verdict
// has to be the same one the resume path reaches (that half is pinned in
// `claude-code-runtime.test.ts`), which is why both paths now ask the same
// `messaging/empty-stream-guard.ts`.
describe('a compaction is not a silent turn (DOR-1235)', () => {
  beforeEach(() => {
    optIn.persistentSession = true;
  });

  /** The SDK's boundary, snake_case as it arrives on the stream. */
  const compactBoundary = (trigger: 'manual' | 'auto') =>
    ({
      type: 'system',
      subtype: 'compact_boundary',
      compact_metadata: { trigger, pre_tokens: 38234, post_tokens: 3035, duration_ms: 19707 },
      session_id: 'pump-compact',
      uuid: `boundary-${trigger}`,
    }) as never;

  /** Run one turn whose only answer is a compaction boundary. */
  async function compactingTurn(trigger: 'manual' | 'auto'): Promise<StreamEvent[]> {
    const sessionId = nextSession();
    await turn(sessionId);
    const process = cli.processes[0]!;
    process.goSilent();

    const running = turn(sessionId, trigger === 'manual' ? '/compact' : 'summarise the repo');
    await vi.waitFor(() => expect(process.received).toHaveLength(2));
    process.emit(compactBoundary(trigger));
    process.emit(resultMessage(process.received[1]!));
    return running;
  }

  it('does not call a successful /compact a crash', async () => {
    const events = await compactingTurn('manual');

    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'compact_boundary')?.data).toEqual({
      trigger: 'manual',
      preTokens: 38234,
      postTokens: 3035,
      durationMs: 19707,
    });
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });

  it('still reports a silent turn when the compaction was automatic', async () => {
    // An auto boundary is incidental: context pressure fired while the person
    // was waiting on an answer to something else, so a turn that compacts and
    // then says nothing still owes them one.
    const events = await compactingTurn('auto');

    expect(events.find((e) => e.type === 'compact_boundary')).toBeDefined();
    const error = events.find((e) => e.type === 'error');
    expect(error).toBeDefined();
    expect((error!.data as Record<string, unknown>).message).toContain('did not respond');
  });

  it('lets a failed compaction report its own reason, and nothing vaguer', async () => {
    // A compaction that cannot run fires NO boundary — just the resolving
    // status, which becomes `operation_progress` failed carrying the reason.
    // Neither content nor a typed error, so the turn used to collect a second,
    // vaguer verdict on top of the one already on screen.
    const sessionId = nextSession();
    await turn(sessionId);
    const process = cli.processes[0]!;
    process.goSilent();

    const running = turn(sessionId, '/compact');
    await vi.waitFor(() => expect(process.received).toHaveLength(2));
    process.emit({
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      session_id: 'pump-compact',
      uuid: 'compacting',
    } as never);
    process.emit({
      type: 'system',
      subtype: 'status',
      status: null,
      compact_result: 'failed',
      compact_error: 'context too large to summarize',
      session_id: 'pump-compact',
      uuid: 'compact-failed',
    } as never);
    process.emit(resultMessage(process.received[1]!));
    const events = await running;

    const failure = events.filter(
      (e) => e.type === 'operation_progress' && (e.data as { state?: string }).state === 'failed'
    );
    expect(failure).toHaveLength(1);
    expect(failure[0]!.data).toMatchObject({
      operation: 'compaction',
      error: 'context too large to summarize',
    });
    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });
});

describe('an elicitation-only turn is not a silent turn (DOR-1240)', () => {
  beforeEach(() => {
    optIn.persistentSession = true;
  });

  it('does not call an unanswered elicitation a crash', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    const process = cli.processes[0]!;
    process.goSilent();

    const running = turn(sessionId, 'ask the server for my token');
    await vi.waitFor(() => expect(process.received).toHaveLength(2));
    // An MCP server's elicitation reaches the SDK consumer via the `onElicitation`
    // option the launch resolver registers — real `interactive-handlers.ts`
    // code, which pushes `elicitation_prompt` straight onto `session.eventQueue`
    // and holds its returned promise open until a person answers. Nobody
    // answers here: the turn closes with nothing else said.
    void process.options.onElicitation?.(
      { serverName: 'test-server', message: 'Which environment?' },
      { signal: new AbortController().signal }
    );
    process.emit(resultMessage(process.received[1]!));
    const events = await running;

    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'elicitation_prompt')).toBeDefined();
    expect(events.find((e) => e.type === 'done')).toBeDefined();
  });
});

// DOR-1309. The SDK re-mints a session's canonical id mid-first-turn
// (`system/init`, ADR-0267), and `SessionStore` already resolves every id a
// session has ever answered to back to the ONE key it is stored under. This
// block proves `PersistentDispatch` and `SessionPumpRegistry` now agree with
// that resolution. Before the fix they kept their OWN raw-id keys, so a turn,
// a steer, or a stage under any id but the exact one the pump happened to be
// registered under spawned a SECOND process instead of reaching the first —
// the shape DOR-1312 measured live, and the root of DOR-1315's second-window
// steer and DOR-1318's stage-on-an-idle-session failure.
describe('a session keeps its ONE warm process across an SDK rekey (DOR-1309)', () => {
  beforeEach(() => {
    optIn.persistentSession = true;
  });

  it('(a) reaches the process turn 1 warmed when turn 2 arrives under the CANONICAL id', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    const canonical = runtime.getInternalSessionId(sessionId)!;
    // Sanity: an actual rekey happened, or this test proves nothing.
    expect(canonical).not.toBe(sessionId);

    const events = await turn(canonical, 'turn two, under the new id');

    expect(cli.launches).toBe(1);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(cli.processes[0]!.answered).toBe(2);
    expect(runtime.getSessionWarmth(sessionId)).toBe('warm');
    expect(runtime.getSessionWarmth(canonical)).toBe('warm');
  });

  it('(b) reaches the same process when a later turn arrives under a RETIRED id from an earlier rename', async () => {
    const sessionId = nextSession();
    await turn(sessionId); // process 1: sessionId -> canonical1 (the fake's default id)
    const canonical1 = runtime.getInternalSessionId(sessionId)!;
    expect(canonical1).not.toBe(sessionId);

    // The process dies; recovery relaunches under an id that renames AGAIN, so
    // canonical1 becomes a retired link in the chain rather than the session's
    // current id — the "second rename" DOR-774 describes.
    cli.nextSdkSessionId = 'sdk-session-persistent-2';
    cli.processes[0]!.crash(new Error('the CLI went away'));
    await vi.waitFor(() => expect(runtime.getSessionWarmth(sessionId)).toBe('crashed'));
    await turn(sessionId, 'recovering');
    const canonical2 = runtime.getInternalSessionId(sessionId)!;
    expect(canonical2).toBe('sdk-session-persistent-2');
    expect(cli.launches).toBe(2);

    // A turn under canonical1 — now RETIRED — must still reach process 2, not
    // spawn a third.
    const events = await turn(canonical1, 'addressed by the retired id');

    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(cli.launches).toBe(2);
    expect(cli.processes[1]!.answered).toBe(2);
    expect(runtime.getSessionWarmth(canonical1)).toBe('warm');
  });

  it('(c) lets a steer under the CANONICAL id join a turn open under the original id', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    const canonical = runtime.getInternalSessionId(sessionId)!;
    const process = cli.processes[0]!;
    process.goSilent();

    // The turn opens under the ORIGINAL id — the caller that started it never
    // learned the canonical id (e.g. a room binding that only ever holds the
    // first id it saw).
    const running = turn(sessionId, 'do the thing');
    await vi.waitFor(() => expect(process.received).toHaveLength(2));

    // A DIFFERENT caller — a browser tab that already has the canonical id
    // from an earlier 202 — steers under it. The bundle is filed under
    // `sessionId` (dispatch's own resolution always normalizes to the first
    // id a session was ever seen under), so this specifically exercises
    // `steer`'s OWN resolution, independent of `dispatch`'s.
    const receipt = await runtime.deliverIntoTurn(canonical, 'please also check the tests', {
      mode: 'steer',
      messageId: 'steer-canonical-1',
    });
    expect(receipt).toEqual({ delivered: true });

    await vi.waitFor(() => expect(process.received).toHaveLength(3));
    expect(process.inbox.at(-1)!.content).toBe('please also check the tests');

    process.answer('steer-canonical-1');
    const events = await running;
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(cli.launches).toBe(1);
  });

  it('(d) appends a stage under the canonical id onto the one warm process, instead of colliding with the ceiling (DOR-1318 shape)', async () => {
    // MAX_WARM_SESSIONS is mocked to 1 for this whole file, so a phantom
    // second pump for the SAME session — one that keys by the raw id instead
    // of resolving it — has nowhere to go but to reclaim (and kill) the real
    // one to clear room for its own duplicate. That is worse than an orphan:
    // it destroys the live conversation's process while staging a note onto it.
    const sessionId = nextSession();
    await turn(sessionId);
    const canonical = runtime.getInternalSessionId(sessionId)!;
    expect(cli.launches).toBe(1);

    const receipt = await runtime.deliverIntoTurn(canonical, 'use the staging bucket', {
      mode: 'stage',
      messageId: 'stage-canonical-1',
    });

    expect(receipt).toEqual({ delivered: true });
    expect(cli.launches).toBe(1);
    expect(cli.processes[0]!.ended).toBe(false);
    const process = cli.processes[0]!;
    await vi.waitFor(() => expect(process.staged).toHaveLength(1));

    // The staged id must have reached the LIVE windower, not a duplicate
    // `SessionBundle` built under the wrong key — `stage`'s OWN resolution,
    // not merely `shouldDispatch`'s (which only gates whether staging is
    // refused, not which bundle it lands on: `registry.acquire` returns the
    // real pump even for a duplicate bundle, since it resolves internally and
    // short-circuits on the existing entry — but that duplicate bundle's OWN
    // `SessionTurnWindows` is a dead object nothing ever feeds). Proved the
    // way DOR-1294's own test proves it: dispatch a real turn and let the CLI
    // merge the staged note into it, naming the STAGED id on the turn's ONE
    // result. A dead windower never learned 'stage-canonical-1', so that
    // result would read as "answered a message this session never sent",
    // open an unrelated runtime window, and leave the real turn stranded open
    // forever instead of settling as one clean turn.
    process.goSilent();
    const running = turn(sessionId, 'now do the thing');
    // Turn 1 already put one querying message through this process, so the
    // NEW turn's own message is the SECOND, not the first.
    await vi.waitFor(() => expect(process.received).toHaveLength(2));
    process.answer('stage-canonical-1');
    const events = await running;
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(cli.launches).toBe(1);
  });

  it('(e) reaps the one process whichever id names it, and (f) both ids read warmth identically', async () => {
    const sessionId = nextSession();
    expect(runtime.getSessionWarmth(sessionId)).toBe('cold');

    await turn(sessionId);
    const canonical = runtime.getInternalSessionId(sessionId)!;
    expect(canonical).not.toBe(sessionId);
    // (f): both ids agree while warm.
    expect(runtime.getSessionWarmth(sessionId)).toBe('warm');
    expect(runtime.getSessionWarmth(canonical)).toBe('warm');

    // (e): reap addressed by the CANONICAL id retires the one process.
    await runtime.reapSession(canonical);

    expect(cli.processes[0]!.ended).toBe(true);
    // (f), again: both ids agree once cold.
    expect(runtime.getSessionWarmth(sessionId)).toBe('cold');
    expect(runtime.getSessionWarmth(canonical)).toBe('cold');
  });

  it('(g) a turn under the canonical id while another is open under the original id neither orphans nor duplicates', async () => {
    const sessionId = nextSession();
    await turn(sessionId); // turn 1 — completes; the rename happens here
    const canonical = runtime.getInternalSessionId(sessionId)!;
    expect(canonical).not.toBe(sessionId);
    const process = cli.processes[0]!;
    process.goSilent();

    // Turn 2, left open, under the ORIGINAL id — a caller that has not learned
    // the canonical id yet.
    const turn2 = turn(sessionId, 'turn two, left open');
    await vi.waitFor(() => expect(process.received).toHaveLength(2));

    // Turn 3 arrives under the CANONICAL id while turn 2 is still open — the
    // same race DOR-1312 measured, one hop later. Pre-fix this spawned a
    // SECOND process under `canonical`, leaving turn 2's process an orphan
    // (DOR-1312's ~500MB-until-the-reaper) rather than settling into it. The
    // process is still silent from turn 2's setup, so turn 3's own message is
    // answered by hand once it lands.
    const events3Promise = turn(canonical, 'turn three, under the canonical id');
    await vi.waitFor(() => expect(process.received).toHaveLength(3));
    process.answer(process.received[2]!);
    const events3 = await events3Promise;

    expect(cli.launches).toBe(1);
    expect(events3.some((e) => e.type === 'done')).toBe(true);

    // Turn 2's stranded window settles (DOR-1294's existing backstop) rather
    // than hanging or leaking into turn 3.
    const events2 = await turn2;
    expect(events2.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('(h) canSteerSession/canStageSession stay true under BOTH ids once the flag goes off', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    const canonical = runtime.getInternalSessionId(sessionId)!;
    expect(canonical).not.toBe(sessionId);

    // The operator turns the experiment off mid-conversation. A session
    // already holding its process keeps the path (persistent-dispatch.ts's
    // module doc), and that has to be honest for EVERY id the session
    // answers to — `shouldDispatch` reads `registry.peek(sessionId)` WITHOUT
    // resolving first (it relies entirely on the registry's own resolution),
    // so a caller holding the canonical id would otherwise see the composer
    // silently fold a steer into the next turn instead of joining the live
    // one, the instant the flag is off (DOR-1268's class).
    optIn.persistentSession = false;

    expect(runtime.canSteerSession(sessionId)).toBe(true);
    expect(runtime.canSteerSession(canonical)).toBe(true);
    expect(runtime.canStageSession(sessionId)).toBe(true);
    expect(runtime.canStageSession(canonical)).toBe(true);
  });

  it('(i) settleOpenTurn addressed by the canonical id still ends a window left open under the original id (DOR-1295)', async () => {
    const sessionId = nextSession();
    await turn(sessionId); // turn 1 — completes; the rename happens here
    const canonical = runtime.getInternalSessionId(sessionId)!;
    expect(canonical).not.toBe(sessionId);
    const process = cli.processes[0]!;
    process.goSilent();

    // Turn 2, left open, under the ORIGINAL id — exactly the setup case (g)
    // uses, reused here to isolate `settleOpenTurn` from `dispatch` entirely:
    // `trigger-turn.ts` calls `settleOpenTurnBefore` with "the id the request
    // carried", which on turn 3's trigger is the CANONICAL id the client
    // learned from turn 1's 202 — a different id than the one the stranded
    // window's bundle is filed under.
    const turn2 = turn(sessionId, 'turn two, left open');
    await vi.waitFor(() => expect(process.received).toHaveLength(2));

    const settled = await runtime.settleOpenTurn(canonical);
    expect(settled, 'settleOpenTurn missed the window a different id left open').toBe(true);

    const events2 = await turn2;
    expect(events2.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('(j) Stop reaches a RELAUNCH still booting, addressed by the canonical id (DOR-1191)', async () => {
    // Reset to a KNOWN baseline first — an earlier case in this file (`what a
    // warm process must be re-checked for`) leaves this mock changed for the
    // rest of the suite, and this test needs an ACTUAL change between turn 1
    // and turn 2 to provoke a relaunch, not whatever value happened to leak in.
    const { buildSystemPromptAppend } = await import('../../messaging/context-builder.js');
    vi.mocked(buildSystemPromptAppend).mockResolvedValue({
      text: '<env>test</env>',
      stable: '<env>test</env>',
    });

    const sessionId = nextSession();
    await turn(sessionId);
    const canonical = runtime.getInternalSessionId(sessionId)!;
    expect(canonical).not.toBe(sessionId);
    expect(cli.launches).toBe(1);

    // A relaunch pin moves, so the NEXT dispatch tears the warm process down
    // and boots a fresh one — and this one's `system/init` is held, so it
    // parks in the booting window rather than reaching the model, exactly as
    // a cold session's very first turn does (DOR-1191). Dispatched under the
    // CANONICAL id, which is only possible because dispatch's own resolution
    // (case a) finds the right bundle to replace.
    vi.mocked(buildSystemPromptAppend).mockResolvedValue({
      text: '<env>MOVED-FOR-J</env>',
      stable: '<env>MOVED-FOR-J</env>',
    });
    cli.deferNextInit = true;

    const booting = turn(canonical, 'after the change, addressed by the canonical id');
    const process2 = await vi.waitFor(() => {
      expect(cli.launches).toBe(2);
      return cli.processes[1]!;
    });
    expect(runtime.getSessionWarmth(canonical)).toBe('warming');

    // Stop, addressed by the CANONICAL id — the same id the relaunch was
    // dispatched under. `bootingQuery` is reached only after the ordinary
    // Stop path (`session.activeQuery`) finds nothing, which it does not
    // during a boot; keyed by the raw id it would miss the bundle (filed
    // under `sessionId`, the session's stable map key) and report nothing to
    // stop — DOR-1191's whole point, reintroduced by the id mismatch.
    expect(
      await runtime.interruptQuery(canonical),
      'Stop could not reach the relaunch that was still booting'
    ).toBe(true);
    expect(process2.interrupts).toBe(1);

    process2.reportReady();
    const events = await booting;
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});

describe('a steer the CLI answers in a turn of its own (DOR-1314)', () => {
  beforeEach(() => {
    optIn.persistentSession = true;
  });

  it('carries the continuation inside the turn the person is watching', async () => {
    const sessionId = nextSession();
    await turn(sessionId); // warms the process
    const process = cli.processes[0]!;
    process.goSilent();

    const running = turn(sessionId, 'do the thing');
    await vi.waitFor(() => expect(process.received).toHaveLength(2));
    const receipt = await runtime.deliverIntoTurn(sessionId, 'also check the tests', {
      mode: 'steer',
      messageId: 'steer-1',
    });
    expect(receipt).toEqual({ delivered: true });
    await vi.waitFor(() => expect(process.received).toHaveLength(3));

    // The CLI ends the turn WITHOUT the steer — it queued the steer for a turn
    // of its own, which is what a live CLI does with a message pushed at the
    // tail of a turn (the DOR-1294 measurement, and every flag-on run in
    // DOR-1312). The window may not close here: a message this session sent is
    // still unanswered.
    process.answer(process.received[1]!, 'the first answer');
    // ...and then it runs that turn.
    process.say('here is what the tests say');
    process.answer('steer-1', 'and that is all of it');

    const events = await running;
    const said = spokenText(events);
    // The property: every word the CLI produced for this person reached the
    // stream they were watching. Before DOR-1314 the continuation opened a
    // synthetic runtime window that `PersistentDispatch` drained and dropped.
    expect(said).toContain('the first answer');
    expect(said).toContain('here is what the tests say');
    expect(said).toContain('and that is all of it');
    // And it is ONE turn, not two: a single terminal, and nothing was dropped.
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(cli.launches).toBe(1);
  });

  it('closes on the steer’s own result when the CLI coalesced it after all', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    const process = cli.processes[0]!;
    process.goSilent();

    const running = turn(sessionId, 'do the thing');
    await vi.waitFor(() => expect(process.received).toHaveLength(2));
    await runtime.deliverIntoTurn(sessionId, 'also check the tests', {
      mode: 'steer',
      messageId: 'steer-1',
    });
    await vi.waitFor(() => expect(process.received).toHaveLength(3));

    // One result, naming the steer: the CLI folded both messages into one turn.
    // Nothing is outstanding, so the turn ends immediately — no waiting for a
    // continuation that is never coming.
    process.answer('steer-1', 'both of them, answered together');

    const events = await running;
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('ends the turn anyway when the CLI never starts the steer’s turn', async () => {
    const sessionId = nextSession();
    await turn(sessionId);
    const process = cli.processes[0]!;
    process.goSilent();

    const running = turn(sessionId, 'do the thing');
    await vi.waitFor(() => expect(process.received).toHaveLength(2));
    await runtime.deliverIntoTurn(sessionId, 'never answered', {
      mode: 'steer',
      messageId: 'steer-1',
    });
    await vi.waitFor(() => expect(process.received).toHaveLength(3));

    // The dispatched message is answered and then the process says nothing at
    // all. Waiting on a continuation that never begins would hang the person's
    // turn, so the wait is bounded: the deferred result closes it.
    process.answer(process.received[1]!, 'the only answer');

    const events = await running;
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(spokenText(events)).toContain('the only answer');
  });
});

describe('what a drained runtime window is reported as (DOR-1314)', () => {
  beforeEach(() => {
    optIn.persistentSession = true;
  });

  it('says nothing louder than debug when the CLI only volunteered bookkeeping', async () => {
    const { logger } = await import('../../../../../lib/logger.js');
    const sessionId = nextSession();
    await turn(sessionId);
    const process = cli.processes[0]!;
    vi.mocked(logger.debug).mockClear();
    vi.mocked(logger.error).mockClear();

    // A `result` for a message nobody in this session ever sent, with nothing
    // held behind it: the window it opens carries the result and not one word.
    process.emit(resultMessage('a-message-nobody-dispatched'));

    await vi.waitFor(() => {
      expect(
        vi
          .mocked(logger.debug)
          .mock.calls.some((call) => String(call[0]).includes('content-free turn nobody asked for'))
      ).toBe(true);
    });
    // A warning here is noise that trains people to ignore the log.
    expect(vi.mocked(logger.error)).not.toHaveBeenCalled();
  });

  it('reports dropped model speech as an error, with a census of what it was', async () => {
    const { logger } = await import('../../../../../lib/logger.js');
    const sessionId = nextSession();
    await turn(sessionId);
    const process = cli.processes[0]!;
    vi.mocked(logger.error).mockClear();

    // The CLI speaks between turns and then names a message nobody sent. Those
    // words have no window to land in, so they are dropped — and dropping words
    // a person might have been owed is not a debug-level event.
    process.say('a continuation nobody asked for');
    process.emit(resultMessage('a-message-nobody-dispatched'));

    await vi.waitFor(() => {
      expect(
        vi
          .mocked(logger.error)
          .mock.calls.some((call) => String(call[0]).includes('dropped model output'))
      ).toBe(true);
    });
    const call = vi
      .mocked(logger.error)
      .mock.calls.find((entry) => String(entry[0]).includes('dropped model output'))!;
    expect(call[1]).toMatchObject({
      sessionId,
      dropped: 2,
      content: 1,
      census: { stream_event: 1, result: 1 },
    });
  });
});
