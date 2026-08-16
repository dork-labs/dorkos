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

  // Pins the interrupt-FAILURE escalation at exactly this seam. `interrupt()`
  // before `system/init` writes a control request to the subprocess and awaits
  // the CLI's response, so it HANGS in the healthy case and only REJECTS when
  // the stdin write fails because the process already died mid-boot (the SDK's
  // `request()` rejects on a failed `transport.write`; the `Cr` wrapper
  // re-throws). On that rejection the Stop escalates to a forceful `close()`,
  // exactly as the running path does — so a booting Stop crashes the pump the
  // same way a running Stop does when `interrupt()` rejects.
  //
  // KNOWN GAP (deferred, owned by the message-dispatcher layer): a boot that
  // ends here produces error+done with NO `turn_start`, and a queued row retires
  // ONLY on `turn_start` (`message-dispatcher.ts` `onTurnStart` → `store.remove`).
  // So the stopped message's durable row is not retired and `adoptQueuedMessages`
  // re-runs it on the next `dispatchMessage`. That re-run is NOT observable here
  // (this harness wires no `MessageQueueStore`) and cannot be fixed at the
  // pump/dispatch seam, which sits below retirement and never sees the queue —
  // the fix belongs in the retirement/adoption layer and is tracked separately.
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

    // The close ends the booting process, so the turn settles as a failure
    // rather than hanging. A first-turn launch rejection surfaces raw at the
    // runtime layer — `guardTurnErrors` one layer up (`trigger-turn.ts`) turns
    // it into the error+done pair a person sees, exactly as on any other
    // first-turn launch failure — so at THIS seam it rejects.
    await expect(booting).rejects.toMatchObject({ reason: 'process-gone' });
    // And the pump reports the crash honestly, the same as a running Stop whose
    // interrupt rejected and escalated to close.
    expect(runtime.getSessionWarmth(sessionId)).toBe('crashed');
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
