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
import { randomUUID } from 'node:crypto';
import { describe, expect, it, onTestFinished } from 'vitest';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeSettingsCapability,
  RuntimeSettingsSection,
  SessionSettingsPort,
} from '@dorkos/shared/agent-runtime';
import { needsConsentRitual } from '@dorkos/shared/permission-semantics';
import {
  ErrorEventSchema,
  OperationProgressEventSchema,
  SessionSchema,
  StreamEventSchema,
  UsageStatusSchema,
} from '@dorkos/shared/schemas';
import {
  SessionLifecycleSchema,
  SessionListEventSchema,
  type SessionListEvent,
} from '@dorkos/shared/session-stream';
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
  /**
   * Permission mode used when creating sessions. Defaults to the runtime
   * UNDER TEST's own declared default (`getCapabilities().permissionModes.default`),
   * falling back to `'default'` only when a runtime declares none — never
   * hardcoded to `'default'` regardless of the runtime, which would silently
   * skip exercising a runtime whose declared default sits outside the shared
   * `PermissionMode` enum (test-mode's is `always-allow` — DOR-851). Set this
   * only to force a SPECIFIC mode across every session the suite creates.
   */
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
  /**
   * Drives ONE real turn through the trigger path's projector — the
   * `getOrCreateProjector` → `feedProjector` seam `POST /messages` uses —
   * calling `midTurn` while the turn is OPEN and `afterTurn` once it has
   * closed. Wire it to `drivePresenceTurn`
   * (`apps/server/src/services/session/__tests__/durable-turn-harness.ts`).
   *
   * Required for the live half of the presence assertions, and there is no
   * default that could stand in for it: a runtime's `sendMessage` is a pure
   * event producer that moves no projector, so presence read off `sendMessage`
   * alone reports `idle` at every moment for every runtime and asserts nothing.
   * Omit it and those cases SKIP, loudly and by name, rather than passing on an
   * absence the suite manufactured.
   */
  presenceTurn?: (
    runtime: AgentRuntime,
    sessionId: string,
    content: string,
    probes: { midTurn: () => Promise<void>; afterTurn: () => Promise<void> }
  ) => Promise<void>;
  /**
   * Waives the safety invariant that a runtime's DEFAULT permission mode must
   * still stop for the person — one that would need a consent ritual if a person
   * selected it (`needsConsentRitual`) may not be where a session is BORN. The
   * string is the reason, and it is required rather than a boolean so the waiver
   * is a sentence somebody wrote, not a flag somebody flipped — an empty or
   * whitespace-only string does not waive anything.
   *
   * There is exactly one legitimate use today: `test-mode`, whose entire purpose
   * is a deterministic always-allow fixture. A production runtime that wants
   * this is telling you it starts sessions with the keys already handed over.
   */
  autonomyDefaultReason?: string;
  /**
   * Waives the requirement that `subscribeSessionList` actually emit something.
   * The string is the reason, and it is required rather than a boolean for the
   * same purpose as {@link autonomyDefaultReason}: an empty or whitespace-only
   * string waives nothing.
   *
   * **Absent is strict.** By default a runtime must produce at least one event,
   * because the schema check this case exists for cannot run against a stream
   * that says nothing — it passes, silently, having asserted nothing. That is
   * not hypothetical: claude-code's suite was green in CI for exactly that
   * reason, its watcher never constructed there, and a probe that made the parse
   * site fail unconditionally still reported 21/21 (DOR-1085).
   *
   * All four shipped runtimes reach the parse site, so nothing needs this today.
   * It exists for a future adapter whose list stream genuinely observes a store
   * a mocked backend cannot write to — and it makes that author state the case
   * in a sentence, rather than inheriting a silent pass they never chose.
   */
  sessionListSilentReason?: string;
}

/**
 * Whether a runtime has WAIVED the requirement to emit a session-list event.
 *
 * Whitespace does not waive, matching `autonomyDefaultReason`: the waiver has to
 * be a sentence somebody wrote, not a flag somebody flipped.
 *
 * @param silentReason - The runtime's {@link RuntimeConformanceOpts.sessionListSilentReason}.
 * @returns True when silence is an accepted answer for this runtime.
 */
export function sessionListSilenceWaived(silentReason: string | undefined): boolean {
  return (silentReason ?? '').trim().length > 0;
}

/**
 * How long the session-list case waits for a first event.
 *
 * Longer when an event is REQUIRED, because that wait now decides a real
 * assertion and must not fail a working stream that was merely slow; shorter
 * when silence is waived, so a runtime that will never emit is not taxed for it.
 * Both fit inside the default 5000ms `it` timeout with room for the turn — this
 * case must never be the thing that runs the clock out.
 *
 * @param silentReason - The runtime's {@link RuntimeConformanceOpts.sessionListSilentReason}.
 * @returns Milliseconds to wait before treating the stream as silent.
 */
export function sessionListWaitMs(silentReason: string | undefined): number {
  return sessionListSilenceWaived(silentReason) ? 500 : 2000;
}

/**
 * The session-list contract, applied to one subscribed stream.
 *
 * Reads at most one event, bounded by {@link sessionListWaitMs}, and answers the
 * two ways a list stream can be wrong: it said NOTHING when this runtime never
 * waived that, or it said something `SessionListEventSchema` rejects.
 *
 * Extracted and exported so the suite and its proof-of-failure
 * (`runtime-conformance-session-list.test.ts`) run the SAME rules — the suite
 * only ever meets adapters that are supposed to pass, so a green conformance run
 * is no evidence these rules fired at all. Nothing in that test re-implements
 * what is here.
 *
 * The caller owns closing the stream; this never does, because teardown belongs
 * on a different clock (see the call site).
 *
 * @param iterator - A subscribed `subscribeSessionList` iterator.
 * @param silentReason - The runtime's {@link RuntimeConformanceOpts.sessionListSilentReason}.
 * @returns Null when the stream satisfies the contract, else the failure message.
 */
export async function evaluateSessionListStream(
  iterator: AsyncIterator<SessionListEvent>,
  silentReason: string | undefined
): Promise<string | null> {
  const waitMs = sessionListWaitMs(silentReason);
  // Cleared in `finally` rather than left to expire: when the event wins the
  // race the timer is still armed, and an orphan 2s timer per conformance run
  // holds the event loop open past the assertion for no reason.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let race: { kind: 'event'; result: IteratorResult<SessionListEvent> } | { kind: 'timeout' };
  try {
    race = await Promise.race([
      iterator.next().then((result) => ({ kind: 'event' as const, result })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), waitMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (race.kind === 'timeout' || race.result.done) {
    if (sessionListSilenceWaived(silentReason)) return null;
    return (
      `subscribeSessionList emitted nothing within ${waitMs}ms, so SessionListEventSchema was ` +
      `never applied and this case asserted nothing — a dead stream, not a pass. A runtime that ` +
      `genuinely cannot produce an event here must say why via sessionListSilentReason.`
    );
  }

  const parsed = SessionListEventSchema.safeParse(race.result.value);
  if (parsed.success) return null;
  return (
    `subscribeSessionList produced an event that fails SessionListEventSchema ` +
    `(SessionListBroadcaster would silently drop it): ${parsed.error.message}`
  );
}

/** Every valid {@link PermissionModeDescriptor.stop} value. */
const PERMISSION_STOPS = ['ask', 'act', 'autonomy'];

/** Every valid {@link PermissionModeDescriptor.asks} value. */
const PERMISSION_ASKS = ['always', 'when-risky', 'never'];

/** Every valid {@link PermissionModeDescriptor.reach} value. */
const PERMISSION_REACHES = ['read', 'edit', 'workspace', 'everything'];

/**
 * Every valid {@link PermissionModeDescriptor.axis} value. Absent is legal and
 * means `'trust'` — the common case, and the one that keeps a mode on the dial.
 */
const PERMISSION_AXES = ['trust', 'working'];

/** The turn-terminating event type every sendMessage stream must end with. */
const TERMINAL_EVENT_TYPE = 'done';

/**
 * The lifecycle that claims a turn is running RIGHT NOW — what the presence
 * strip renders as "working".
 *
 * `blocked` is deliberately not one: a blocked session is waiting on a person,
 * not working. `error`/`interrupted` are settled, closed states.
 */
const WORKING_LIFECYCLE = 'streaming';

/** Valid `DependencyCheck.status` values per the AgentRuntime contract. */
const DEPENDENCY_STATUSES = ['satisfied', 'missing', 'outdated'];

/** Every documented boolean capability flag on {@link RuntimeCapabilities}. */
const BOOLEAN_CAPABILITY_FLAGS = [
  'supportsToolApproval',
  'supportsCostTracking',
  'supportsResume',
  'supportsMcp',
  'supportsManagedMcpServers',
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

/**
 * Unique per-test session id so tests never observe each other's state.
 *
 * A real UUID, not a readable counter string — `SessionSchema.id` requires
 * one (`z.string().uuid()`, matching every real session id, which is always
 * client-minted via `crypto.randomUUID()`). A non-UUID id here used to make
 * every `SessionSchema.parse()`/`SessionListEventSchema.parse()` assertion
 * added for DOR-851 fail for every runtime, on a mismatch this suite's own
 * ids caused — not a signal about runtime behavior.
 */
function nextSessionId(): string {
  return randomUUID();
}

/**
 * The durable settings store as a runtime sees it (ADR-0260), recording every
 * re-key it is asked to perform. Reads return nothing so the runtime falls back
 * to its own defaults — the subject here is which id the settings are FILED
 * under, not what they contain.
 */
function recordingSettingsPort(): SessionSettingsPort & { rekeyCalls: Array<[string, string]> } {
  const rekeyCalls: Array<[string, string]> = [];
  return {
    rekeyCalls,
    getSessionSettings: async () => null,
    saveSessionSettings: async () => {},
    rekeySessionSettings: async (fromId: string, toId: string) => {
      rekeyCalls.push([fromId, toId]);
    },
  };
}

/**
 * Structural check of a runtime's {@link RuntimeSettingsCapability}
 * declaration: returns one message per violation, empty when it is sound.
 *
 * Extracted from the conformance suite's `capabilities` test so the rules can
 * be exercised directly against deliberately-malformed declarations
 * (`__tests__/runtime-conformance-settings.test.ts`) — proof the check can
 * actually fail. Wrapping a whole conformance run in `it.fails()` would not be
 * proof: it passes on ANY throw, including one from an unrelated assertion.
 *
 * Accepts `unknown` deliberately. The compile-time type says the field is
 * present and well-formed; runtime values drift from it through casts, and
 * this is the layer that catches the drift.
 *
 * @internal
 * @param settings - Whatever a runtime reported as `getCapabilities().settings`.
 * @returns Failure messages, one per violation; empty when the declaration is valid.
 */
export function validateSettingsCapability(settings: unknown): string[] {
  if (settings === null || typeof settings !== 'object') {
    return ['capabilities.settings is required'];
  }
  const failures: string[] = [];
  const declaration = settings as Partial<RuntimeSettingsCapability>;

  // `null` is the honest declaration for a runtime with no config section.
  // An empty or whitespace-only key is not: it reads a config leaf nobody
  // writes, and does it silently.
  const { configSection } = declaration;
  if (configSection !== null) {
    if (typeof configSection !== 'string') {
      failures.push('settings.configSection must be a string or null');
    } else if (configSection.trim().length === 0) {
      failures.push(
        'settings.configSection must be null or a non-empty key — an empty ' +
          'section name reads a config leaf nobody writes'
      );
    }
  }

  if (typeof declaration.supportsEffort !== 'boolean') {
    failures.push('settings.supportsEffort must be a boolean');
  }

  const { sections } = declaration;
  if (!Array.isArray(sections)) {
    failures.push('settings.sections must be an array');
    return failures;
  }

  const kinds: string[] = [];
  sections.forEach((section: unknown, index: number) => {
    if (section === null || typeof section !== 'object') {
      failures.push(`settings.sections[${index}] must be an object`);
      return;
    }
    const { kind } = section as Partial<RuntimeSettingsSection>;
    if (typeof kind !== 'string' || kind.trim().length === 0) {
      failures.push(`settings.sections[${index}].kind must be a non-empty string`);
      return;
    }
    kinds.push(kind);
  });

  // Two sections of one kind render the same bespoke panel twice.
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const kind of kinds) {
    if (seen.has(kind)) duplicates.add(kind);
    seen.add(kind);
  }
  for (const kind of duplicates) {
    failures.push(`settings.sections declares the kind '${kind}' more than once`);
  }

  return failures;
}

/**
 * When a presence reading was taken, relative to the session's own turns.
 *
 * The three moments differ in what a TRUTHFUL runtime may say, which is why the
 * validator needs to be told which one it is looking at.
 */
export type PresencePhase = 'never-run' | 'mid-turn' | 'after-turn';

/**
 * One reading of the two presence facts a runtime owns for a session: whether a
 * turn is running now, and what the session is bound to.
 *
 * Fields are typed `unknown` on purpose. The compile-time types say a lifecycle
 * is a `SessionLifecycle` and a binding is a `string | undefined`; what a
 * runtime actually reports drifts from that through casts and hand-built
 * snapshots, and this is the layer that catches the drift.
 */
export interface PresenceObservation {
  /** Which moment this reading was taken at. */
  phase: PresencePhase;
  /** `getSessionSnapshot().status.lifecycle`, verbatim. */
  lifecycle: unknown;
  /** `getSessionSnapshot().inProgressTurn`, verbatim. */
  inProgressTurn: unknown;
  /**
   * The cwd the session was created with, or `undefined` when it was created
   * bound to nothing.
   */
  boundTo?: string;
  /**
   * The binding the runtime reported (`getSession().cwd`), or `null` when the
   * runtime reported no session at all — a legal answer before the first turn,
   * and one that carries no binding claim to check.
   */
  reportedBinding: unknown;
}

/**
 * Check one {@link PresenceObservation} against the presence-truthfulness
 * contract: returns one message per violation, empty when the reading is honest.
 *
 * **The rule the whole thing serves: the strip omits rather than lies.** A
 * runtime that cannot observe its own running state, or cannot say what a
 * session is bound to, reports that absence (`idle` with no turn, an omitted
 * binding) and passes — absence is a valid answer, and it is the only
 * alternative to a true one. What it may never do is fabricate: claim a turn is
 * running when none is, keep claiming one after the turn terminated, or name a
 * directory the session is not bound to. Each of those puts a person in front of
 * a roster that says an agent is working on something it is not.
 *
 * There is deliberately NO opt-out knob on {@link RuntimeConformanceOpts} for
 * this. "Cannot report presence" and "reports absence" are the same value here,
 * so a runtime declaring the former would be waiving assertions it already
 * satisfies.
 *
 * Extracted as a pure function for the same reason
 * {@link validateSettingsCapability} is: the suite only ever runs against
 * runtimes meant to pass, so its green says nothing about whether these rules
 * can fire. `__tests__/runtime-conformance-presence.test.ts` drives this
 * directly with fabricated readings and asserts each is rejected.
 *
 * @internal
 * @param observation - One reading of a session's presence facts.
 * @returns Failure messages, one per violation; empty when the reading is honest.
 */
export function validatePresenceReport(observation: PresenceObservation): string[] {
  const failures: string[] = [];
  const { phase, lifecycle, inProgressTurn, boundTo, reportedBinding } = observation;

  // Vocabulary first: an unknown lifecycle string is a claim no consumer can
  // read, and every rule below would silently pass it through.
  const knownLifecycle = SessionLifecycleSchema.safeParse(lifecycle).success;
  if (!knownLifecycle) {
    failures.push(
      `status.lifecycle is '${String(lifecycle)}', which is not a SessionLifecycle — ` +
        'a presence state nothing downstream can read'
    );
  }

  // An EMPTY array is not "a turn to show" — it is the absence of one wearing
  // the shape of presence, and it is not a state the real projector can reach
  // (`turn_start` opens the turn WITH its own event, `turn_end` nulls it —
  // session-state-projector). Counting `[]` as a shown turn would let a runtime
  // satisfy the claim-what-you-can-show rule below with nothing at all.
  const turnShown = Array.isArray(inProgressTurn) && inProgressTurn.length > 0;
  if (!Array.isArray(inProgressTurn) && inProgressTurn !== null) {
    failures.push(
      `inProgressTurn must be an array of events or null, not '${String(inProgressTurn)}'`
    );
  }

  // A turn claimed is a turn showable. The reverse does NOT hold: a snapshot may
  // carry events with no turn running (an open sign-in card outlives its turn,
  // DOR-1004), so a non-null turn on an idle session is not a lie.
  if (lifecycle === WORKING_LIFECYCLE && !turnShown) {
    failures.push(
      `reports '${WORKING_LIFECYCLE}' but has no in-progress turn to show — ` +
        'presence claimed with nothing behind it'
    );
  }

  if (phase === 'never-run') {
    if (knownLifecycle && lifecycle !== 'idle') {
      failures.push(
        `a session that has never run a turn must report 'idle', not '${String(lifecycle)}' — ` +
          'nothing has happened to it yet'
      );
    }
    // `null`, strictly. An empty array is the same absence in the shape of a
    // turn, and the projector has no state that produces one.
    if (inProgressTurn !== null) {
      failures.push('a session that has never run a turn must show no in-progress turn');
    }
  }

  // The stuck-working lie, and the one a person actually meets: an agent that
  // finished hours ago still lit up on the roster.
  if (phase === 'after-turn' && lifecycle === WORKING_LIFECYCLE) {
    failures.push(
      `still reports '${WORKING_LIFECYCLE}' after the turn reached its terminal ` +
        `'${TERMINAL_EVENT_TYPE}' — nothing is running`
    );
  }

  // `null` means the runtime reported no session, which makes no binding claim.
  if (reportedBinding !== null) {
    if (reportedBinding !== undefined && typeof reportedBinding !== 'string') {
      failures.push(
        `the reported binding must be a directory string or absent, not '${String(reportedBinding)}'`
      );
    } else if (typeof reportedBinding === 'string') {
      if (boundTo === undefined) {
        failures.push(
          `reports the binding '${reportedBinding}' for a session created bound to nothing — ` +
            'an unattributable session must report no binding rather than borrow one'
        );
      } else if (reportedBinding !== boundTo) {
        failures.push(
          `reports the binding '${reportedBinding}' for a session bound to '${boundTo}'`
        );
      }
    }
  }

  return failures;
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
    permissionMode: permissionModeOverride,
    expectHistory = false,
    messageContent = 'conformance ping',
    makeFailingRuntime,
    makeCompactingRuntime,
    durableHistory,
    presenceTurn,
    autonomyDefaultReason,
    sessionListSilentReason,
  } = opts;

  /**
   * The mode a fresh session should carry: the suite override when given,
   * else the SPECIFIC runtime instance's own declared default.
   *
   * Resolved per-instance (never memoized, never hardcoded to `'default'`) —
   * a runtime's declared default may sit outside the shared `PermissionMode`
   * enum entirely (test-mode's is `always-allow`). Before DOR-851 this suite
   * hardcoded `'default'` for every runtime, so it never exercised any
   * runtime through the mode it actually starts sessions in; a runtime whose
   * ENTIRE declared set sits outside the enum (test-mode) would have sailed
   * through unnoticed. The cast bridges `RuntimeCapabilities.permissionModes.default`
   * (a runtime-declared id, DOR-851's wide id) to `SessionOpts.permissionMode`
   * (still typed to the narrower enum — a known, separately-tracked gap): the
   * same bridge every other seam in the codebase uses at this exact boundary
   * (`routes/sessions.ts`, `codex-runtime.ts`), safe here because the id is
   * read back from the SAME runtime that declared it and `ensureSession`
   * never branches on the literal name.
   *
   * @param runtime - The runtime instance under test in THIS test.
   */
  function resolvePermissionMode(runtime: AgentRuntime): PermissionMode {
    if (permissionModeOverride !== undefined) return permissionModeOverride;
    return (runtime.getCapabilities().permissionModes.default ?? 'default') as PermissionMode;
  }

  /**
   * SessionOpts shared by every ensureSession call in the suite, resolved
   * against the specific runtime instance under test.
   *
   * @param runtime - The runtime instance under test in THIS test.
   */
  const sessionOpts = (runtime: AgentRuntime) => ({
    permissionMode: resolvePermissionMode(runtime),
    cwd: projectDir,
  });

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

  /**
   * Read a session's two presence facts the way a roster does: whether a turn
   * is running (the snapshot's projection) and what the session is bound to
   * (the session's own `cwd`).
   *
   * @param runtime - The runtime instance under test.
   * @param sessionId - The session to read.
   * @param phase - Which moment the reading is taken at.
   * @param boundTo - The cwd the session was created with, if any.
   */
  async function observePresence(
    runtime: AgentRuntime,
    sessionId: string,
    phase: PresencePhase,
    boundTo: string | undefined
  ): Promise<PresenceObservation> {
    const ctx = {
      permissionMode: resolvePermissionMode(runtime),
      ...(boundTo === undefined ? {} : { cwd: boundTo }),
    };
    const snapshot = await runtime.getSessionSnapshot(ctx, sessionId);
    // `getSession` takes the directory to look IN; an unbound session has none,
    // so it is asked for in the suite's project dir — where, being bound to
    // nothing, it must still not claim a binding.
    const session = await runtime.getSession(boundTo ?? projectDir, sessionId);
    return {
      phase,
      lifecycle: snapshot.status.lifecycle,
      inProgressTurn: snapshot.inProgressTurn,
      boundTo,
      reportedBinding: session === null ? null : session.cwd,
    };
  }

  /**
   * Failure preamble naming what was actually reported, so a red says which
   * presence claim was fabricated without a rerun.
   *
   * @param observation - The reading that failed.
   */
  function presenceMessage(observation: PresenceObservation): string {
    return (
      `presence reported ${observation.phase} was not truthful ` +
      `(lifecycle '${String(observation.lifecycle)}', ` +
      `turn ${observation.inProgressTurn === null ? 'absent' : 'present'}, ` +
      `binding ${String(observation.reportedBinding)})`
    );
  }

  describe(name, () => {
    describe('session lifecycle', () => {
      it('tracks a session after ensureSession and leaves unknown ids untracked', () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();

        expect(runtime.hasSession(sessionId)).toBe(false);
        runtime.ensureSession(sessionId, sessionOpts(runtime));
        expect(runtime.hasSession(sessionId)).toBe(true);
        expect(runtime.hasSession(nextSessionId())).toBe(false);
      });

      it('a session tracked without a cwd appears in NO project list (ADR 260707-193314)', async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        // Deliberately no cwd: an unattributable session must not fan into
        // every project's list — that rendered ghost sessions under every
        // agent (DOR-202). It may still resolve by id via getSession.
        runtime.ensureSession(sessionId, { permissionMode: resolvePermissionMode(runtime) });

        const sessions = await runtime.listSessions(projectDir);
        expect(sessions.map((s) => s.id)).not.toContain(sessionId);
      });

      it('getSession resolves session metadata or null — and null for an unknown id', async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));

        // Backends that hydrate metadata from a native store may legitimately
        // return null before the first turn — the contract is "Session or
        // null", never a throw.
        const session = await runtime.getSession(projectDir, sessionId);
        if (session !== null) {
          // The wire shape a runtime's own returned Session must satisfy —
          // in particular `permissionMode`, which is the id THIS runtime
          // reports and may sit outside the shared `PermissionMode` enum
          // (test-mode's is `always-allow`). A runtime that reports a mode
          // `SessionSchema` cannot parse gets silently dropped everywhere the
          // session list is broadcast (`SessionListBroadcaster`), which is
          // exactly the defect this parse pins shut (DOR-851).
          const parsed = SessionSchema.safeParse(session);
          expect(
            parsed.success,
            `runtime.getSession() returned a Session that fails SessionSchema: ${
              parsed.success ? '' : parsed.error.message
            }`
          ).toBe(true);
          expect(session.id).toBe(sessionId);
          // The runtime tag is the aggregation key (ADR-0310) — an adapter
          // must stamp its own type, never another runtime's.
          expect(session.runtime).toBe(runtime.type);
          // Context reading is OPTIONAL per runtime (fleet-context-health,
          // DOR-113): no adapter is forced to produce one. Only assert the
          // shape WHEN present — never assert presence.
          if (session.contextTokens !== undefined) {
            expect(typeof session.contextTokens).toBe('number');
          }
          if (session.lastAutoCompactAt !== undefined) {
            expect(typeof session.lastAutoCompactAt).toBe('string');
          }
        }

        await expect(runtime.getSession(projectDir, nextSessionId())).resolves.toBeNull();
      });

      it('subscribeSessionList emits only events that satisfy SessionListEventSchema (DOR-851)', async () => {
        // Purpose: `SessionListBroadcaster` feeds every `subscribeSessionList`
        // event straight through `SessionListEventSchema` and silently DROPS
        // whatever fails it (apps/server/src/services/session/session-list-broadcaster.ts) —
        // so a runtime whose own upsert/status events do not parse simply
        // never appears in the live session list, with nothing louder than a
        // log line. That is exactly how DOR-851 happened: test-mode reports
        // `permissionMode: 'always-allow'`, the schema used to reject it, and
        // the sidebar went empty for every test-mode session. This asserts the
        // contract at the SOURCE — a runtime's own emitted events — rather
        // than only downstream at the broadcaster.
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));
        await drainTurn(runtime, sessionId);

        const iterator = runtime.subscribeSessionList(sessionOpts(runtime))[Symbol.asyncIterator]();
        // Closing this stream is CLEANUP, and it is moved off the assertion's
        // clock onto its own. This applies to EVERY runtime, not just the one
        // that needed it: closing a list stream can be slow through no fault of
        // the adapter — claude-code's is a chokidar watch, and on macOS every
        // watched path is an FSEvents stream torn down through libuv's single
        // CFRunLoop thread, measured at 50ms to 2.3s for a ONE-file temp tree
        // and 10-24s against a real `~/.claude`. Awaiting that in a `finally`
        // inside the 5000ms `it` is what reported a ~5ms assertion as a timeout
        // on every macOS checkout (DOR-1085).
        //
        // State the trade rather than leave it to be discovered: the bound it
        // moves TO is vitest's default `hookTimeout`, 10_000ms, so the threshold
        // at which a slow teardown is caught roughly doubles. A `close()` taking
        // 6-9s now passes where it previously failed. That is deliberate — a
        // teardown budget and an assertion budget are different questions, and
        // the signal survives: a close that hangs fails the hook, and one that
        // throws fails the test.
        onTestFinished(async () => {
          await iterator.return?.();
        });

        // Both ways a list stream can be wrong live in one exported predicate,
        // so the proof that they can FAIL (runtime-conformance-session-list.test.ts)
        // exercises these exact rules rather than a copy of them.
        const failure = await evaluateSessionListStream(iterator, sessionListSilentReason);
        if (failure !== null) expect.fail(failure);
      });

      it('getInternalSessionId returns a string or undefined — never throws', () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));

        for (const id of [sessionId, nextSessionId()]) {
          const internal = runtime.getInternalSessionId(id);
          expect(internal === undefined || typeof internal === 'string').toBe(true);
        }
      });

      it('getInternalSessionId is IDEMPOTENT — a canonical id maps to itself', () => {
        // Server-side callers resolve a session's canonical id by applying this
        // once (`getInternalSessionId(id) ?? id`) and MUST be able to apply it to
        // an already-resolved id without moving further. The persisted-settings
        // overlay depends on it: the write path (PATCH) and every read path each
        // resolve independently, and they converge on one key only because a
        // second application is a no-op. An adapter that chained aliases
        // (a -> b -> c) would silently split those keys apart and let two
        // surfaces report different permission modes for one session (DOR-463).
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));

        for (const id of [sessionId, nextSessionId()]) {
          const canonical = runtime.getInternalSessionId(id) ?? id;
          expect(runtime.getInternalSessionId(canonical) ?? canonical).toBe(canonical);
        }
      });

      it('a session that gains a canonical id takes its stored settings with it', async () => {
        // The other half of the alias contract above (DOR-493). An alias splits
        // the id a session's settings were written under from the id every later
        // read and turn will ask by, so a runtime that mints one MUST move the
        // row. Leaving it behind reverts the ENFORCED permission mode to the
        // runtime default on the first turn after an eviction or restart — the
        // agent silently stops asking, or starts.
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));

        // The port is OPTIONAL on the interface, so a stateless adapter may have
        // none. That is not a second case with its own assertion — it is the
        // same one with no re-keys recorded, which is why this reads the calls
        // through `?? []` instead of branching. A portless runtime that aliases
        // therefore fails the very same expectation, and says why.
        const port = runtime.setSessionSettings ? recordingSettingsPort() : undefined;
        if (port) runtime.setSessionSettings?.(port);

        // AFTER a turn, deliberately. An alias is minted when the backend names
        // the session, which for claude-code is the first turn's init message —
        // reading `getInternalSessionId` before that asks a question no runtime
        // can answer yet, and would pass for every adapter ever written.
        await drainTurn(runtime, sessionId);

        const canonical = runtime.getInternalSessionId(sessionId);
        if (canonical !== undefined && canonical !== sessionId) {
          expect(
            port?.rekeyCalls ?? [],
            port
              ? `rebound '${sessionId}' to '${canonical}' but left its settings row behind`
              : `rebound '${sessionId}' to '${canonical}' with no settings port to re-key through — a runtime that aliases must accept one`
          ).toContainEqual([sessionId, canonical]);
        } else {
          expect(port?.rekeyCalls ?? [], 'no alias was minted, so nothing may be re-keyed').toEqual(
            []
          );
        }
      });
    });

    describe('messaging', () => {
      it(`sendMessage yields well-formed StreamEvents and terminates with '${TERMINAL_EVENT_TYPE}'`, async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));

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
        runtime.ensureSession(sessionId, sessionOpts(runtime));

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
        runtime.ensureSession(sessionId, sessionOpts(runtime));

        const events = await drainTurn(runtime, sessionId);

        for (const event of events) {
          if (event.type !== 'operation_progress') continue;
          assertOperationProgress(event);
        }
      });
    });

    describe('presence truthfulness (the strip omits rather than lies)', () => {
      it('a session that has never run a turn reports idle, and shows no turn', async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));

        const observation = await observePresence(runtime, sessionId, 'never-run', projectDir);
        expect(validatePresenceReport(observation), presenceMessage(observation)).toEqual([]);
      });

      if (presenceTurn) {
        it('reports a running turn while it runs, and stops the moment it ends', async () => {
          // Both live readings come from ONE turn driven through the real
          // trigger path, so the lifecycle genuinely transitions
          // idle → streaming → idle underneath them. Read off `sendMessage`
          // alone these cases would be inert: the generator moves no
          // projector, every reading would be `idle`, and a runtime latched at
          // `streaming` forever would sail through.
          const runtime = makeRuntime();
          const sessionId = nextSessionId();
          runtime.ensureSession(sessionId, sessionOpts(runtime));

          let mid: PresenceObservation | undefined;
          let after: PresenceObservation | undefined;
          await presenceTurn(runtime, sessionId, messageContent, {
            midTurn: async () => {
              mid = await observePresence(runtime, sessionId, 'mid-turn', projectDir);
            },
            afterTurn: async () => {
              after = await observePresence(runtime, sessionId, 'after-turn', projectDir);
            },
          });

          expect(mid, 'the driver never read presence with the turn open').toBeDefined();
          expect(after, 'the driver never read presence after the turn closed').toBeDefined();
          expect(validatePresenceReport(mid!), presenceMessage(mid!)).toEqual([]);
          expect(validatePresenceReport(after!), presenceMessage(after!)).toEqual([]);

          // The discriminating half. A runtime that answers this question at
          // all must MOVE: claiming a turn while one runs is what the strip
          // renders, and the reading afterwards is what stops it rendering.
          //
          // Only `idle` is held to reporting nothing. `blocked` legitimately
          // carries a live non-null turn — the projector settles there the
          // moment an approval opens mid-turn, with the turn still open — and
          // so can a turn that ended in `error`/`interrupted`. Demanding a null
          // turn from all of them false-reds an honest runtime; the
          // stuck-working coverage lives in the after-turn rule regardless.
          if (mid!.lifecycle === 'streaming') {
            expect(
              after!.lifecycle,
              'reported the turn while it ran but never let go of it'
            ).not.toBe('streaming');
          } else if (mid!.lifecycle === 'idle') {
            expect(
              mid!.inProgressTurn,
              'a runtime that reports no running turn must report nothing at all'
            ).toBeNull();
          }
        });
      } else {
        it.skip(
          'SKIPPED: no `presenceTurn` driver wired — nothing here proves this runtime ' +
            'reports a live turn truthfully (see RuntimeConformanceOpts.presenceTurn)',
          () => {}
        );
      }

      it('a session bound to nothing reports no binding — it never borrows one', async () => {
        // The binding half of the same rule, and the one that put ghost rows
        // under every agent when it was violated (DOR-202): a session created
        // with no cwd is bound to nothing, and the only honest answer is none.
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, { permissionMode: resolvePermissionMode(runtime) });

        const observation = await observePresence(runtime, sessionId, 'never-run', undefined);
        expect(validatePresenceReport(observation), presenceMessage(observation)).toEqual([]);
      });
    });

    if (makeCompactingRuntime) {
      describe('operation progress (compaction, DOR-110)', () => {
        it('reports compaction via the standardized operation_progress contract', async () => {
          const runtime = makeCompactingRuntime();
          const sessionId = nextSessionId();
          runtime.ensureSession(sessionId, sessionOpts(runtime));

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
          runtime.ensureSession(sessionId, sessionOpts(runtime));

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
        runtime.ensureSession(sessionId, sessionOpts(runtime));

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
        runtime.ensureSession(sessionId, sessionOpts(runtime));
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
          runtime.ensureSession(sessionId, sessionOpts(runtime));

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

            // Semantics are what every surface computes its warnings from, so a
            // mode that declares only half of them is worse than one that
            // declares none: the client would derive a confident wrong answer
            // rather than an obviously missing one (spec `trust-dial`).
            expect(PERMISSION_STOPS, `${descriptor.id}.stop`).toContain(descriptor.stop);
            expect(PERMISSION_ASKS, `${descriptor.id}.asks`).toContain(descriptor.asks);
            expect(PERMISSION_REACHES, `${descriptor.id}.reach`).toContain(descriptor.reach);
            expect(typeof descriptor.promise, `${descriptor.id}.promise`).toBe('string');
            expect(
              descriptor.promise.trim().length,
              `${descriptor.id}.promise must say what happens`
            ).toBeGreaterThan(0);
            if (descriptor.axis !== undefined) {
              expect(PERMISSION_AXES, `${descriptor.id}.axis`).toContain(descriptor.axis);
            }
          }

          // A way of working is not a trust level, so it leaves the dial — which
          // means a runtime whose ONLY `stop: 'ask'` mode declares
          // `axis: 'working'` ships a dial with no Ask stop: nothing to select,
          // and a session sitting in that mode with nowhere to go back to. The
          // client defends against it anyway, but this is where it is cheap to
          // catch, because only the runtime can fix it.
          const askModes = modes!.values.filter((d) => d.stop === 'ask');
          if (askModes.length > 0) {
            expect(
              askModes.some((d) => d.axis !== 'working'),
              'a runtime that declares any `stop: "ask"` mode must declare at least ' +
                'one that is a trust level — a way of working (axis: "working") ' +
                'leaves the dial, so it cannot be the only mode holding the Ask stop'
            ).toBe(true);
          }
          if (modes!.default !== undefined) {
            expect(
              modes!.values.map((descriptor) => descriptor.id),
              'permissionModes.default must reference a declared descriptor id'
            ).toContain(modes!.default);

            // Safety invariant: a fresh session starts somewhere the person is
            // still consulted. A runtime whose default never asks hands the keys
            // over before anybody chose to, and no capability flag can make that
            // acceptable — only a written-down reason can (autonomyDefaultReason).
            //
            // Asked through `needsConsentRitual` — the same rule the consent
            // door applies (DOR-816) — and NOT against `stop`. This is the one
            // path with no door on it: a session born at the default never
            // PATCHes, so nothing downstream can ask the person anything. A
            // `stop`-shaped check passed a profile defaulting to
            // `{ stop: 'act', asks: 'never', reach: 'workspace' }`, which is
            // precisely the shape the door was widened to catch. A read-only
            // default that "never asks" because it has nothing to ask about
            // (Codex's) still passes, as it must.
            const defaultDescriptor = modes!.values.find((d) => d.id === modes!.default);
            // Trimmed, like the promise check above: a waiver has to BE a reason.
            // An empty or whitespace string is somebody silencing the invariant
            // without writing down why, which is the one thing it exists to stop.
            if ((autonomyDefaultReason ?? '').trim().length === 0) {
              expect(
                defaultDescriptor !== undefined && needsConsentRitual(defaultDescriptor),
                `permissionModes.default ('${modes!.default}') must not be a mode that ` +
                  'never asks — a session born there passes no consent door. Declare ' +
                  'autonomyDefaultReason if this runtime genuinely must'
              ).toBe(false);
            }
          }
        } else {
          // `supported: false, values: []` is the declared no-picker shape.
          expect(modes!.values).toEqual([]);
        }

        // Settings are re-read from the runtime VALUE for the same reason the
        // permission modes above are: a cast can put anything here, and every
        // settings surface renders straight off this declaration.
        const settingsFailures = validateSettingsCapability(capabilities.settings);
        expect(
          settingsFailures,
          `capabilities.settings is malformed:\n  ${settingsFailures.join('\n  ')}`
        ).toEqual([]);
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
        runtime.ensureSession(sessionId, sessionOpts(runtime));
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
