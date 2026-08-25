import { afterAll, afterEach, beforeEach, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeConformance } from '@dorkos/test-utils';
import { wrapSdkQuery, sdkError, sdkSimpleText, sdkCompaction } from './sdk-scenarios.js';

// Purpose: ClaudeCodeRuntime must clear the SAME shared conformance gate as
// the stateless TestModeRuntime (spec additional-agent-runtimes, task 1.5).
// The SDK is fully mocked — this suite must NEVER require the real `claude`
// binary. Mock preamble mirrors claude-code-runtime.test.ts.

/**
 * The hermetic Claude ACCOUNT this suite reads and watches, filled in at module
 * scope below.
 *
 * A holder object rather than a bare string because `vi.mock` factories are
 * hoisted above every import: the mock can only close over something that
 * exists before `node:fs` does, and it reads `.root` lazily, by which time
 * module scope has created the directory.
 */
const account = vi.hoisted(() => ({ root: '' }));

/**
 * The per-session persistent-process opt-in, as this suite drives it.
 *
 * Off for every case but the two warmth ones. That is not a convenience: with
 * it on, every OTHER case would run against a process that outlives its turn,
 * and the one-shot SDK double below would read as a crash the moment its stream
 * ended. The warmth cases turn it on themselves, and swap in a double that
 * behaves like a CLI that stays up.
 */
const persistent = vi.hoisted(() => ({ on: false }));

// The account resolver is the ONLY thing standing between this suite and the
// developer's real Claude Code history, and unmocked it does not stand there at
// all: `resolveClaudeRootSet()` unconditionally includes `~/.claude` plus
// whatever `$CLAUDE_CONFIG_DIR` names, so `subscribeSessionList` attached
// chokidar to every real account on the machine — hundreds of project
// directories and gigabytes of transcripts. Tearing those watchers down took
// 10-24s on a working macOS box (fs.watch is one FSEvents stream per path, all
// stopped through libuv's single CFRunLoop thread), which blew the 5000ms test
// timeout inside the harness's `finally` — a red that had nothing to do with
// the assertion. CI never saw it because CI has no `~/.claude` at all: the root
// set came back EMPTY, no watcher was created, no event was ever emitted, and
// the schema assertion the test exists for silently never ran (DOR-1085).
//
// Pointing the resolver at a seeded temp account fixes both halves — teardown
// is milliseconds, and the assertion now runs on every machine including CI.
// Real root resolution keeps its own coverage in claude-config-dir's unit tests;
// conformance is about the AgentRuntime contract, not about which home
// directory this laptop has.
vi.mock('../claude-config-dir.js', () => ({
  resolveActiveClaudeRoot: () => account.root,
  resolveLaunchAccountRoot: () => account.root,
  resolveClaudeRootSet: () => [account.root],
  claudeConfigDirEnv: (root: string) => ({ CLAUDE_CONFIG_DIR: root }),
  describeClaudeCodeAccounts: () => ({
    resolvedAccount: account.root,
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
vi.mock('../../../../lib/logger.js', () => ({
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
vi.mock('../messaging/context-builder.js', () => ({
  buildSystemPromptAppend: vi
    .fn()
    .mockResolvedValue({
      text: '<env>\nWorking directory: /projects/conformance\n</env>',
      stable: '<env>\nWorking directory: /projects/conformance\n</env>',
    }),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));
vi.mock('../tooling/tool-filter.js', () => ({
  resolveToolConfig: vi
    .fn()
    .mockReturnValue({ tasks: true, relay: true, mesh: true, adapter: true }),
}));
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => {
      if (key === 'runtimes') return { claudeCode: { persistentSession: persistent.on } };
      return {
        tasksTools: true,
        relayTools: true,
        meshTools: true,
        adapterTools: true,
      };
    }),
  },
}));
vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/projects/conformance'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/projects/conformance'),
  getBoundary: vi.fn().mockReturnValue('/projects'),
  initBoundary: vi.fn().mockResolvedValue('/projects'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));
// Filesystem command scanner — never read a real .claude/commands/ dir.
vi.mock('../tooling/command-registry.js', () => ({
  CommandRegistryService: vi.fn().mockImplementation(() => ({
    getCommands: vi.fn().mockResolvedValue({ commands: [], lastScanned: new Date().toISOString() }),
    invalidateCache: vi.fn(),
  })),
}));
vi.mock('../../../core/event-fan-out.js', () => ({
  eventFanOut: { broadcast: vi.fn(), addClient: vi.fn(), clientCount: 0 },
}));
vi.mock('../../../../lib/dork-home.js', () => ({
  resolveDorkHome: vi.fn().mockReturnValue('/tmp/dorkos-conformance'),
}));
vi.mock('../../../marketplace/installed-scanner.js', () => ({
  listEnabledPluginNames: vi.fn().mockResolvedValue([]),
}));
vi.mock('../messaging/plugin-activation.js', () => ({
  buildClaudeAgentSdkPluginsArray: vi.fn().mockResolvedValue([]),
}));
// checkDependencies() shells out to `claude --version` and `claude auth status`
// for real — mock the probes so conformance never spawns (or requires) the
// binary. Returns both the CLI-binary and authentication checks.
vi.mock('../tooling/check-dependency.js', () => ({
  checkClaudeDependencies: vi.fn().mockResolvedValue([
    {
      name: 'Claude Code CLI',
      description: 'The Claude Code CLI powers agent sessions in DorkOS.',
      status: 'satisfied',
      version: '0.0.0-mock',
    },
    {
      name: 'Claude Code authentication',
      description: 'Signed in to Claude.',
      status: 'satisfied',
    },
  ]),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import { ClaudeCodeRuntime } from '../claude-code-runtime.js';
import {
  drivePresenceTurn,
  driveDispositionTurn,
  driveTerminalOnce,
  driveQueueDurability,
} from '../../../session/__tests__/durable-turn-harness.js';
import { getOrCreateProjector, feedProjector } from '../../../session/index.js';
import { FakeCli } from '../sessions/__tests__/fake-persistent-cli.js';

const mockedQuery = vi.mocked(query);

// Create and seed the hermetic account before any test resolves it. One project
// directory holding one parseable transcript, which is what turns
// `subscribeSessionList` from "emits nothing, asserts nothing" into a real
// reading: the watcher's initial inventory finds this session and emits a
// `session_upserted` carrying it, so `SessionListEventSchema` is actually
// exercised against a Session the production projector built from real JSONL.
//
// Deliberately NOT under the slug for the suite's own `/projects/conformance`
// working directory: the fleet-wide watcher sees it wherever it lives, while a
// different cwd keeps it out of every `listSessions('/projects/conformance')`
// answer the other conformance cases assert on.
account.root = mkdtempSync(join(tmpdir(), 'dorkos-conformance-claude-'));
const seededProjectDir = join(account.root, 'projects', '-projects-conformance-fixture');
mkdirSync(seededProjectDir, { recursive: true });
writeFileSync(
  join(seededProjectDir, `${randomUUID()}.jsonl`),
  JSON.stringify({
    type: 'user',
    message: { role: 'user', content: 'seeded conformance transcript' },
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/projects/conformance-fixture',
  }) + '\n'
);

// A second seeded transcript, this one UNDER the suite's own working directory,
// for the `userLastMessageAt` probe (BC-16). It is written as a conversation
// that CONTINUED after the person stopped typing — one human turn, then an
// assistant turn, then a tool_result record (which arrives on the `user` role
// but nobody wrote), then another assistant turn. A reader that counted every
// `user` record, or that handed back the file's mtime, lands on the wrong
// instant here.
const probeSessionId = randomUUID();
const probeUserWroteAt = '2026-01-01T09:00:00.000Z';
const probeProjectDir = join(account.root, 'projects', '-projects-conformance');
mkdirSync(probeProjectDir, { recursive: true });
writeFileSync(
  join(probeProjectDir, `${probeSessionId}.jsonl`),
  [
    {
      type: 'user',
      message: { role: 'user', content: 'ship the ordering fix' },
      timestamp: probeUserWroteAt,
      cwd: '/projects/conformance',
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }], model: 'probe' },
      timestamp: '2026-01-01T09:01:00.000Z',
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
      },
      timestamp: '2026-01-01T09:02:00.000Z',
    },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], model: 'probe' },
      timestamp: '2026-01-01T09:03:00.000Z',
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n') + '\n'
);

afterAll(() => {
  rmSync(account.root, { recursive: true, force: true });
});

/**
 * The working directory the unanswered-question driver writes under (DOR-1293).
 *
 * Its OWN cwd, like the first seeded fixture and for the same reason: this
 * transcript is written mid-suite, and under the suite's own slug it would
 * appear in `listSessions('/projects/conformance')` answers that other cases
 * are asserting on at the time.
 */
const QUESTION_CWD = '/projects/conformance-question';

/**
 * Write the transcript a claude-code session leaves behind when a question goes
 * unanswered, then read history back the way the product does.
 *
 * This is the equivalent of test-mode's `question-expires` scenario for a
 * runtime whose transcript IS the file: the SDK is mocked, so no turn can
 * produce JSONL, and the honest stand-in is the JSONL the SDK would have
 * written — the `tool_use` block, then the auto-deny `tool_result` DorkOS's own
 * `handleAskUserQuestion` hands back at the ten-minute mark, `is_error` and all.
 * Nothing writes a `questionOutcome`; the adapter derives it.
 */
async function seedExpiredQuestionHistory(runtime: AgentRuntime, sessionId: string) {
  const dir = join(account.root, 'projects', '-projects-conformance-question');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${sessionId}.jsonl`),
    [
      {
        type: 'user',
        message: { role: 'user', content: 'set up the tests' },
        timestamp: '2026-01-01T10:00:00.000Z',
        cwd: QUESTION_CWD,
      },
      {
        type: 'assistant',
        timestamp: '2026-01-01T10:00:01.000Z',
        message: {
          role: 'assistant',
          model: 'probe',
          content: [
            {
              type: 'tool_use',
              id: 'tool-q',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Which test runner should I set up?',
                    header: 'Test runner',
                    multiSelect: false,
                    options: [{ label: 'Vitest' }, { label: 'Jest' }],
                  },
                ],
              },
            },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-01-01T10:10:01.000Z',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool-q',
              content: 'User did not respond within 10 minutes',
              is_error: true,
            },
          ],
        },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n'
  );
  return runtime.getMessageHistory(QUESTION_CWD, sessionId);
}

/** Warm processes this file booted, closed after each case so none leaks. */
let warmCli: FakeCli | undefined;

afterEach(() => {
  for (const process of warmCli?.processes ?? []) process.endStream();
  warmCli = undefined;
  persistent.on = false;
});

beforeEach(() => {
  persistent.on = false;
  mockedQuery.mockReset();
  // mockImplementation (not mockReturnValue): every sendMessage turn must get
  // a FRESH generator — a spent one would end the stream with zero events.
  mockedQuery.mockImplementation(
    () =>
      wrapSdkQuery(sdkSimpleText('Echo: conformance ping')) as unknown as ReturnType<typeof query>
  );
});

runtimeConformance(
  () => new ClaudeCodeRuntime('/tmp/dorkos-conformance', '/projects/conformance'),
  {
    name: 'ClaudeCodeRuntime (mocked SDK) — AgentRuntime conformance',
    // The mocked SDK writes no JSONL transcript, so native history is [] here;
    // real-binary history round-trips are covered by integration smokes.
    expectHistory: false,
    // No `sessionListSilentReason`: the seeded transcript above is on disk
    // before any test runs, so the fleet-wide watcher MUST report it and
    // silence is a failure. That is the harness default now — the runtime that
    // needed a waiver is the one this suite just stopped being (DOR-1085).

    // Presence is only assertable against a turn that really runs: drive one
    // through the same projector the trigger path feeds. Claude-code takes the
    // harness WITHOUT the durable store (its transcript is SDK JSONL — it must
    // not persist, DOR-189), which is exactly what `drivePresenceTurn` does.
    presenceTurn: (runtime, sessionId, content, probes) =>
      drivePresenceTurn(runtime, sessionId, content, '/projects/conformance', probes),
    // DOR-1293: a question NOBODY answered. See `seedExpiredQuestionHistory`.
    expiredQuestionHistory: (runtime, sessionId) => seedExpiredQuestionHistory(runtime, sessionId),
    // Claude-code declares `supportsPersistentSession`, so it owes the suite a
    // way to reach WARM. Turning the opt-in on is part of the driver's job: the
    // capability says this adapter CAN hold a process open, and whether a given
    // session does is the operator's per-session setting.
    //
    // The double is swapped here rather than in `beforeEach` because it is the
    // opposite of the one every other case needs: this one stays alive after
    // its `result` and answers the next message on the same process, which is
    // the only way a turn can leave a session warm.
    warmSession: async (runtime: AgentRuntime, sessionId: string) => {
      persistent.on = true;
      warmCli = new FakeCli();
      mockedQuery.mockImplementation(warmCli.query as unknown as typeof query);
      for await (const _event of runtime.sendMessage(sessionId, 'conformance ping', {
        cwd: '/projects/conformance',
      })) {
        // Drained rather than inspected: this driver's job is to LEAVE the
        // session warm, and the suite makes its own assertions afterwards.
      }
    },
    // C1 declared arm: claude-code declares BOTH steer and stage after P4, so it
    // owes the suite a turn held open to deliver into. Same persistent double the
    // warmth cases use: warm a process, open a second turn, go silent so it stays
    // unanswered (the window is open), let the suite steer and stage into it, then
    // answer — which coalesces into ONE result and closes the turn. Answering the
    // LAST pushed message (the steer) is what the persistent CLI takes to close
    // the whole coalesced turn (persistent-dispatch.test.ts).
    dispositionTurn: async (runtime: AgentRuntime, sessionId, content, probes) => {
      persistent.on = true;
      warmCli = new FakeCli();
      mockedQuery.mockImplementation(warmCli.query as unknown as typeof query);
      for await (const _event of runtime.sendMessage(sessionId, 'warm the process', {
        cwd: '/projects/conformance',
      })) {
        // Drained to leave the session warm — the held turn below joins it.
      }
      const process = warmCli.processes[0]!;
      const warmReceived = process.received.length;
      process.goSilent();
      await driveDispositionTurn(runtime, sessionId, content, '/projects/conformance', probes, {
        // The held turn's message has reached the process — its window is open.
        awaitOpen: () => vi.waitFor(() => expect(process.received.length).toBe(warmReceived + 1)),
        // Answer the last thing pushed (the steer if one was delivered, else the
        // turn's own message): the CLI coalesces it into one result and closes.
        endTurn: () => process.answer(process.received.at(-1)),
      });
    },
    // C2/C3 are server-owned invariants every runtime inherits by construction,
    // driven through the shared machinery rather than claude-code itself.
    terminalOnce: () => driveTerminalOnce('/projects/conformance'),
    queueDurability: () => driveQueueDurability(),
    // C11 (DOR-1299): warm a process, open a SECOND turn on it and leave it
    // silent (mirrors dispositionTurn above), then arm its `interrupt()` to
    // hang forever — the fake-CLI equivalent of the ended-stdin wedge
    // `bounded-control.ts` exists for. `process.received` growing past the warm
    // turn's count is the real signal the second turn's message reached the
    // process, i.e. `session.activeQuery` is armed with the query under test.
    // The pinned settle is `true`: `bounded-control.ts` escalates an unacked
    // interrupt to `query.close()` and reports the process WAS stopped, just
    // not gracefully — unlike opencode, which has nothing to escalate to.
    hangingInterrupt: async (runtime: AgentRuntime, sessionId: string): Promise<boolean> => {
      persistent.on = true;
      warmCli = new FakeCli();
      mockedQuery.mockImplementation(warmCli.query as unknown as typeof query);
      for await (const _event of runtime.sendMessage(sessionId, 'warm the process', {
        cwd: '/projects/conformance',
      })) {
        // Drained to leave the session warm — the hung turn below joins it.
      }
      const process = warmCli.processes[0]!;
      const warmReceived = process.received.length;
      process.goSilent();
      process.interruptNeverSettles = true;
      const projector = getOrCreateProjector(sessionId, '/projects/conformance');
      // Started, NOT awaited — same as dispositionTurn above: the silent
      // process never answers, so this promise never settles on its own.
      void feedProjector(
        projector,
        runtime.sendMessage(sessionId, 'this turn is never answered', {
          cwd: '/projects/conformance',
        }),
        { userMessage: 'this turn is never answered' }
      );
      await vi.waitFor(() => expect(process.received.length).toBe(warmReceived + 1));
      return true;
    },
    // Claude-code CAN say when the person last wrote: it rides the transcript
    // tail read the session list already performs. Read back through
    // `listSessions` rather than `getSession`, because the recents LIST is the
    // path the sidebar calls and the one this field exists for. The probe
    // transcript's last human message precedes both the agent's later turns and
    // the file's mtime.
    userLastMessageAtSession: async (runtime) => {
      const listed = await runtime.listSessions('/projects/conformance');
      const session = listed.find((s) => s.id === probeSessionId);
      if (!session) throw new Error('probe transcript did not reach the session list');
      return session;
    },
    // One-shot failing turn: the SDK stream ends in a non-success result
    // (error_during_execution), driving the result-event-mapper's typed error
    // + terminal done path. mockImplementationOnce takes precedence over the
    // beforeEach default for exactly the next query() call, which is this
    // runtime's next sendMessage turn.
    makeFailingRuntime: () => {
      mockedQuery.mockImplementationOnce(
        () =>
          wrapSdkQuery(sdkError('Simulated SDK execution failure')) as unknown as ReturnType<
            typeof query
          >
      );
      return new ClaudeCodeRuntime('/tmp/dorkos-conformance', '/projects/conformance');
    },
    // One-shot compacting turn: the SDK stream carries a `status: 'compacting'`,
    // a `compact_boundary`, and a resolving `compact_result: 'success'`, which the
    // system-event-mapper maps to the `operation_progress` started→done contract
    // (DOR-110). mockImplementationOnce applies to exactly the next query() call.
    makeCompactingRuntime: () => {
      mockedQuery.mockImplementationOnce(
        () => wrapSdkQuery(sdkCompaction()) as unknown as ReturnType<typeof query>
      );
      return new ClaudeCodeRuntime('/tmp/dorkos-conformance', '/projects/conformance');
    },
  }
);
