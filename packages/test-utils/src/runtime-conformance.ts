/**
 * Shared AgentRuntime conformance suite — the behavioral gate every runtime
 * adapter clears before its UI activates.
 *
 * `runtimeConformance(makeRuntime, opts)` registers a `describe` block that
 * asserts the `AgentRuntime` contract (`packages/shared/src/agent-runtime.ts`)
 * against any backend, parameterized by a factory. The suite is deliberately
 * storage-agnostic: a stateless EventLog-backed runtime (TestModeRuntime) and
 * a JSONL-backed one (ClaudeCodeRuntime with the SDK mocked) must BOTH pass
 * the same assertions, so nothing here may assume transcripts on disk or any
 * particular persistence. Legitimate cross-runtime differences are declared
 * via {@link RuntimeConformanceOpts} instead of weakening assertions.
 *
 * Division of labor: this suite covers runtime BEHAVIOR; the TypeScript
 * interface covers SHAPE (a runtime omitting an `AgentRuntime` method fails
 * compilation — the existing `FakeAgentRuntime` invariant).
 *
 * @module test-utils/runtime-conformance
 */
import { describe, expect, it } from 'vitest';
import type { AgentRuntime, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import {
  ErrorEventSchema,
  OperationProgressEventSchema,
  StreamEventSchema,
  UsageStatusSchema,
} from '@dorkos/shared/schemas';
import type { HistoryMessage, PermissionMode, StreamEvent } from '@dorkos/shared/types';

/**
 * Tuning knobs for legitimate cross-runtime differences. Defaults describe
 * the strictest portable expectations; loosen only what a runtime genuinely
 * cannot satisfy (e.g. a stateless adapter with no native history).
 */
export interface RuntimeConformanceOpts {
  /** Label for the registered describe block. Defaults to `'AgentRuntime conformance'`. */
  name?: string;
  /** Working/project directory for cwd-scoped calls. Defaults to `'/projects/conformance'`. */
  projectDir?: string;
  /** Permission mode used when creating sessions. Defaults to `'default'`. */
  permissionMode?: PermissionMode;
  /**
   * When true, `getMessageHistory` must return at least one message after a
   * completed turn. Leave false (the default) for stateless adapters that
   * legitimately return `[]` — their completed history lives in the
   * DorkOS-owned EventLog, not the runtime (ADR-0263).
   */
  expectHistory?: boolean;
  /** User message content sent during turn-based assertions. Defaults to `'conformance ping'`. */
  messageContent?: string;
  /**
   * Factory producing a runtime whose next `sendMessage` turn FAILS
   * terminally (e.g. a mocked backend scripted to a failed turn). When
   * provided, the suite additionally asserts turn-failure conformance: the
   * failing turn must yield a typed `error` StreamEvent before its terminal
   * `done`. Omit only when a deterministic failure cannot be scripted (e.g.
   * env-gated live-binary smokes).
   */
  makeFailingRuntime?: () => AgentRuntime;
  /**
   * Factory producing a runtime whose next `sendMessage` turn emits a
   * COMPACTION operation via the standardized `operation_progress` contract
   * (DOR-110). When provided, the suite additionally asserts the progress
   * contract: the turn yields at least one `operation_progress` for
   * `operation: 'compaction'`, and a resolving phase (`done`/`failed`) appears.
   * Omit for runtimes with no compaction concept (codex, test-mode) — honest
   * degradation, not a weakened assertion.
   */
  makeCompactingRuntime?: () => AgentRuntime;
  /**
   * Provided ONLY by LOG-BACKED runtimes (codex, opencode, test-mode) that
   * declare `logBackedHistory` and persist their completed turns to the durable
   * session-event store (DOR-189). Given a runtime, a fresh session id, and the
   * message content, it must drive ONE complete turn through the real
   * projector → durable store path, drop the live projector (the server-restart
   * analog), and return the history reconstructed FROM THE STORE. The suite
   * asserts that history is non-empty and well-formed — the durability contract.
   * Claude-code omits it (its transcript is SDK JSONL; it must NOT persist).
   */
  durableHistory?: (
    runtime: AgentRuntime,
    sessionId: string,
    content: string
  ) => Promise<HistoryMessage[]>;
}

/** The turn-terminating event type every sendMessage stream must end with. */
const TERMINAL_EVENT_TYPE = 'done';

/** Valid `DependencyCheck.status` values per the AgentRuntime contract. */
const DEPENDENCY_STATUSES = ['satisfied', 'missing', 'outdated'];

/** Every documented boolean capability flag on {@link RuntimeCapabilities}. */
const BOOLEAN_CAPABILITY_FLAGS = [
  'supportsToolApproval',
  'supportsCostTracking',
  'supportsResume',
  'supportsMcp',
  'supportsQuestionPrompt',
  'supportsPlugins',
] as const satisfies readonly (keyof RuntimeCapabilities)[];

/**
 * Assert one `operation_progress` event satisfies the DOR-110 contract: it
 * parses against the shared schema and `percent` is present ONLY when the phase
 * is `determinate` (an indeterminate phase must carry no fraction).
 *
 * @param event - A StreamEvent whose `type` is `'operation_progress'`.
 */
function assertOperationProgress(event: StreamEvent): void {
  const parsed = OperationProgressEventSchema.safeParse(event.data);
  expect(
    parsed.success,
    `malformed operation_progress: ${parsed.success ? '' : parsed.error.message}`
  ).toBe(true);
  if (parsed.success && !parsed.data.determinate) {
    expect(
      parsed.data.percent,
      'an indeterminate operation must not report a percent'
    ).toBeUndefined();
  }
}

let sessionCounter = 0;

/** Unique per-test session id so tests never observe each other's state. */
function nextSessionId(): string {
  sessionCounter += 1;
  return `conformance-session-${sessionCounter}`;
}

/**
 * Register the shared AgentRuntime conformance suite for one runtime.
 *
 * Call at the top level of a Vitest test file. The factory is invoked once
 * per test so every assertion starts from a fresh runtime instance — any
 * backend mocking (e.g. the Claude Agent SDK) belongs in the calling file's
 * own `vi.mock`/`beforeEach` setup, which applies to the registered tests.
 *
 * @param makeRuntime - Factory producing a fresh, ready-to-use runtime
 * @param opts - Declared behavioral differences; see {@link RuntimeConformanceOpts}
 */
export function runtimeConformance(
  makeRuntime: () => AgentRuntime,
  opts: RuntimeConformanceOpts = {}
): void {
  const {
    name = 'AgentRuntime conformance',
    projectDir = '/projects/conformance',
    permissionMode = 'default',
    expectHistory = false,
    messageContent = 'conformance ping',
    makeFailingRuntime,
    makeCompactingRuntime,
    durableHistory,
  } = opts;

  /** SessionOpts shared by every ensureSession call in the suite. */
  const sessionOpts = () => ({ permissionMode, cwd: projectDir });

  /** Run one full turn and collect every yielded StreamEvent. */
  async function drainTurn(runtime: AgentRuntime, sessionId: string): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    for await (const event of runtime.sendMessage(sessionId, messageContent, {
      cwd: projectDir,
    })) {
      events.push(event);
    }
    return events;
  }

  describe(name, () => {
    describe('session lifecycle', () => {
      it('tracks a session after ensureSession and leaves unknown ids untracked', () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();

        expect(runtime.hasSession(sessionId)).toBe(false);
        runtime.ensureSession(sessionId, sessionOpts());
        expect(runtime.hasSession(sessionId)).toBe(true);
        expect(runtime.hasSession(nextSessionId())).toBe(false);
      });

      it('a session tracked without a cwd appears in NO project list (ADR 260707-193314)', async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        // Deliberately no cwd: an unattributable session must not fan into
        // every project's list — that rendered ghost sessions under every
        // agent (DOR-202). It may still resolve by id via getSession.
        runtime.ensureSession(sessionId, { permissionMode });

        const sessions = await runtime.listSessions(projectDir);
        expect(sessions.map((s) => s.id)).not.toContain(sessionId);
      });

      it('getSession resolves session metadata or null — and null for an unknown id', async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts());

        // Backends that hydrate metadata from a native store may legitimately
        // return null before the first turn — the contract is "Session or
        // null", never a throw.
        const session = await runtime.getSession(projectDir, sessionId);
        if (session !== null) {
          expect(session.id).toBe(sessionId);
          // The runtime tag is the aggregation key (ADR-0310) — an adapter
          // must stamp its own type, never another runtime's.
          expect(session.runtime).toBe(runtime.type);
        }

        await expect(runtime.getSession(projectDir, nextSessionId())).resolves.toBeNull();
      });

      it('getInternalSessionId returns a string or undefined — never throws', () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts());

        for (const id of [sessionId, nextSessionId()]) {
          const internal = runtime.getInternalSessionId(id);
          expect(internal === undefined || typeof internal === 'string').toBe(true);
        }
      });
    });

    describe('messaging', () => {
      it(`sendMessage yields well-formed StreamEvents and terminates with '${TERMINAL_EVENT_TYPE}'`, async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts());

        const events = await drainTurn(runtime, sessionId);

        expect(events.length).toBeGreaterThan(0);
        for (const event of events) {
          const parsed = StreamEventSchema.safeParse(event);
          expect(
            parsed.success,
            `malformed StreamEvent (type '${event.type}'): ${
              parsed.success ? '' : parsed.error.message
            }`
          ).toBe(true);
        }

        // The generator completed (the for-await above returned) AND the final
        // event is the turn-ending type — consumers key turn teardown on it.
        expect(events[events.length - 1]!.type).toBe(TERMINAL_EVENT_TYPE);
      });

      it('any `usage` on a session_status is a well-formed UsageStatus', async () => {
        // Runtime-neutral usage/cost self-gates on the `session_status` carrier
        // (ADR runtime-usage-as-session-status-field): a runtime with nothing to
        // report omits it; a runtime that reports it must parse against the
        // shared schema, with subscription-only fields never on pay-as-you-go.
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts());

        const events = await drainTurn(runtime, sessionId);

        for (const event of events) {
          if (event.type !== 'session_status') continue;
          const usage = (event.data as { usage?: unknown }).usage;
          if (usage === undefined) continue;
          const parsed = UsageStatusSchema.safeParse(usage);
          expect(
            parsed.success,
            `malformed usage: ${parsed.success ? '' : parsed.error.message}`
          ).toBe(true);
          if (parsed.success && parsed.data.kind === 'pay-as-you-go') {
            expect(parsed.data.utilization).toBeUndefined();
            expect(parsed.data.resetsAt).toBeUndefined();
            expect(parsed.data.windowLabel).toBeUndefined();
          }
        }
      });

      it('any `operation_progress` yielded is a well-formed OperationProgressEvent', async () => {
        // Self-gating on the standardized progress contract (DOR-110): a runtime
        // with no long-running operation emits none; a runtime that reports one
        // must parse against the shared schema, with `percent` only on a
        // determinate phase. Compaction lifecycle ordering is asserted by the
        // dedicated `makeCompactingRuntime` block below.
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts());

        const events = await drainTurn(runtime, sessionId);

        for (const event of events) {
          if (event.type !== 'operation_progress') continue;
          assertOperationProgress(event);
        }
      });
    });

    if (makeCompactingRuntime) {
      describe('operation progress (compaction, DOR-110)', () => {
        it('reports compaction via the standardized operation_progress contract', async () => {
          const runtime = makeCompactingRuntime();
          const sessionId = nextSessionId();
          runtime.ensureSession(sessionId, sessionOpts());

          const events = await drainTurn(runtime, sessionId);

          const progress = events.filter((event) => event.type === 'operation_progress');
          expect(
            progress.length,
            'a compacting turn must yield at least one operation_progress event'
          ).toBeGreaterThan(0);

          for (const event of progress) assertOperationProgress(event);

          const compaction = progress.filter(
            (event) => (event.data as { operation?: string }).operation === 'compaction'
          );
          expect(
            compaction.length,
            "a compacting turn must report operation 'compaction'"
          ).toBeGreaterThan(0);

          // Compaction must resolve — a `done` or `failed` phase always arrives so
          // the client's progress treatment can never get stuck open.
          const resolved = compaction.some((event) => {
            const state = (event.data as { state?: string }).state;
            return state === 'done' || state === 'failed';
          });
          expect(resolved, 'a compacting turn must resolve (done or failed)').toBe(true);

          // The stream still ends on the terminal event, compaction notwithstanding.
          expect(events[events.length - 1]!.type).toBe(TERMINAL_EVENT_TYPE);
        });
      });
    }

    if (makeFailingRuntime) {
      describe('turn failure', () => {
        it(`yields a typed 'error' event before the terminal '${TERMINAL_EVENT_TYPE}'`, async () => {
          const runtime = makeFailingRuntime();
          const sessionId = nextSessionId();
          runtime.ensureSession(sessionId, sessionOpts());

          const events = await drainTurn(runtime, sessionId);

          const errorIndex = events.findIndex((event) => event.type === 'error');
          expect(errorIndex, "a failing turn must yield an 'error' StreamEvent").toBeGreaterThan(
            -1
          );

          const parsed = ErrorEventSchema.safeParse(events[errorIndex]!.data);
          expect(
            parsed.success,
            `malformed error event data: ${parsed.success ? '' : parsed.error.message}`
          ).toBe(true);
          expect(parsed.data!.message.length).toBeGreaterThan(0);

          // The typed error must precede stream teardown, and failure must not
          // break the every-path-ends-in-done contract: consumers key turn
          // teardown on the same terminal event whether the turn succeeded or
          // failed.
          expect(errorIndex).toBeLessThan(events.length - 1);
          expect(events[events.length - 1]!.type).toBe(TERMINAL_EVENT_TYPE);

          // Deliberately NOT asserted: `terminalReason: 'error'` on the done
          // event. Terminal settling is owned by the server-side feedProjector
          // latch (session-state-projector), which stamps the reason onto its
          // synthesized turn_end; requiring it per-adapter here would fork
          // that contract across runtimes.
        });
      });
    }

    describe('interrupt semantics', () => {
      it('interruptQuery resolves to a boolean — false when no query is active', async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts());

        const result = await runtime.interruptQuery(sessionId);
        expect(typeof result).toBe('boolean');
        // Contract: true only when an active query was interrupted.
        expect(result).toBe(false);
      });
    });

    describe('history', () => {
      it('getMessageHistory returns an array after a completed turn — never throws', async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts());
        await drainTurn(runtime, sessionId);

        const history = await runtime.getMessageHistory(projectDir, sessionId);
        expect(Array.isArray(history)).toBe(true);
        if (expectHistory) {
          expect(history.length).toBeGreaterThan(0);
        }
        for (const message of history) {
          expect(typeof message.id).toBe('string');
          expect(typeof message.role).toBe('string');
        }
      });
    });

    if (durableHistory) {
      describe('durable history (log-backed, DOR-189)', () => {
        it('a completed turn survives a server restart — reconstructable from the durable store', async () => {
          const runtime = makeRuntime();
          const sessionId = nextSessionId();
          runtime.ensureSession(sessionId, sessionOpts());

          // Drives one real turn through the projector → store, drops the live
          // projector, and reads history back FROM THE STORE (the restart analog).
          const history = await durableHistory(runtime, sessionId, messageContent);

          expect(Array.isArray(history)).toBe(true);
          expect(
            history.length,
            'a log-backed runtime must reconstruct history from the durable store after a restart'
          ).toBeGreaterThan(0);
          for (const message of history) {
            expect(typeof message.id).toBe('string');
            expect(message.id.length).toBeGreaterThan(0);
            expect(typeof message.role).toBe('string');
          }
        });

        it('declares logBackedHistory so the platform knows to persist it', () => {
          const runtime = makeRuntime();
          expect(runtime.getCapabilities().logBackedHistory).toBe(true);
        });
      });
    }

    describe('capabilities', () => {
      it('getCapabilities returns a structurally valid RuntimeCapabilities', () => {
        const runtime = makeRuntime();
        const capabilities = runtime.getCapabilities();

        expect(typeof capabilities.type).toBe('string');
        expect(capabilities.type.length).toBeGreaterThan(0);
        // The instance identifier and its declared capabilities must agree.
        expect(capabilities.type).toBe(runtime.type);

        for (const flag of BOOLEAN_CAPABILITY_FLAGS) {
          expect(typeof capabilities[flag], `capabilities.${flag} must be a boolean`).toBe(
            'boolean'
          );
        }

        expect(
          Array.isArray(capabilities.nativeContext),
          'capabilities.nativeContext must be an array'
        ).toBe(true);
        expect(capabilities.features, 'capabilities.features must be an object').toBeTypeOf(
          'object'
        );
        expect(capabilities.features).not.toBeNull();

        // Runtime values can drift from the compile-time type via casts, so the
        // permission-modes contract is re-asserted structurally.
        const modes = capabilities.permissionModes as
          | RuntimeCapabilities['permissionModes']
          | undefined;
        expect(modes, 'capabilities.permissionModes is required').toBeDefined();
        expect(typeof modes!.supported).toBe('boolean');
        expect(Array.isArray(modes!.values)).toBe(true);

        if (modes!.supported) {
          expect(modes!.values.length).toBeGreaterThan(0);
          for (const descriptor of modes!.values) {
            expect(typeof descriptor.id).toBe('string');
            expect(descriptor.id.length).toBeGreaterThan(0);
            expect(typeof descriptor.label).toBe('string');
            expect(descriptor.label.length).toBeGreaterThan(0);
          }
          if (modes!.default !== undefined) {
            expect(
              modes!.values.map((descriptor) => descriptor.id),
              'permissionModes.default must reference a declared descriptor id'
            ).toContain(modes!.default);
          }
        } else {
          // `supported: false, values: []` is the declared no-picker shape.
          expect(modes!.values).toEqual([]);
        }
      });
    });

    describe('command intents (DOR-109)', () => {
      it('declares commandIntents with a { supported: boolean } for every runtime-fulfilled intent', () => {
        // The required RuntimeCapabilities.commandIntents field must be present
        // and well-formed on every runtime — the palette and the compact route
        // read it to gate the runtime-fulfilled `compact` intent. `compact` is
        // the only runtime-fulfilled id today, so it must always be declared.
        const runtime = makeRuntime();
        const { commandIntents } = runtime.getCapabilities();

        expect(commandIntents, 'capabilities.commandIntents is required').toBeDefined();
        const entries = Object.entries(commandIntents);
        expect(
          entries.length,
          'commandIntents must declare at least the compact intent'
        ).toBeGreaterThan(0);
        for (const [intentId, support] of entries) {
          expect(
            typeof support?.supported,
            `commandIntents.${intentId}.supported must be a boolean`
          ).toBe('boolean');
        }
        expect(commandIntents.compact, 'commandIntents.compact must be declared').toBeDefined();
      });

      it('dispatches per its declared support: supported → boundary/terminal, unsupported → throws', async () => {
        // executeCommandIntent must agree with the capability it declares: a
        // runtime advertising compact support actually fulfills it (yielding a
        // compact_boundary the server projects, or at minimum a terminal event),
        // while one that declares no support is honestly defensive and throws
        // when driven — never a silent no-op (the route gates on
        // supported===false and never calls it, but the throw is the contract).
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts());
        const supported = runtime.getCapabilities().commandIntents.compact.supported;

        if (supported) {
          const events: StreamEvent[] = [];
          for await (const event of runtime.executeCommandIntent(sessionId, 'compact', {
            cwd: projectDir,
          })) {
            events.push(event);
          }
          const settled = events.some(
            (event) => event.type === 'compact_boundary' || event.type === TERMINAL_EVENT_TYPE
          );
          expect(
            settled,
            'a supported compact must yield a compact_boundary or a terminal event'
          ).toBe(true);
        } else {
          await expect(
            (async () => {
              for await (const _event of runtime.executeCommandIntent(sessionId, 'compact', {
                cwd: projectDir,
              })) {
                /* drain — the generator must reject before completing */
              }
            })()
          ).rejects.toThrow();
        }
      });
    });

    describe('dependencies', () => {
      it('checkDependencies returns well-formed DependencyCheck entries', async () => {
        const runtime = makeRuntime();
        const checks = await runtime.checkDependencies();

        expect(Array.isArray(checks)).toBe(true);
        for (const check of checks) {
          expect(typeof check.name).toBe('string');
          expect(check.name.length).toBeGreaterThan(0);
          expect(typeof check.description).toBe('string');
          expect(check.description.length).toBeGreaterThan(0);
          expect(
            DEPENDENCY_STATUSES,
            `invalid dependency status '${String(check.status)}'`
          ).toContain(check.status);
        }
      });
    });
  });
}
