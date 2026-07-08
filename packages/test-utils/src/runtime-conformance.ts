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
import { ErrorEventSchema, StreamEventSchema } from '@dorkos/shared/schemas';
import type { PermissionMode, StreamEvent } from '@dorkos/shared/types';

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
    });

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
