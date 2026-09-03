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
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type {
  AgentRuntime,
  RuntimeCapabilities,
  RuntimeSettingsCapability,
  RuntimeSettingsSection,
  SessionSettingsPort,
} from '@dorkos/shared/agent-runtime';
import { needsConsentRitual } from '@dorkos/shared/permission-semantics';
import { describeAuthError } from '@dorkos/shared/runtime-error-classification';
import {
  ErrorEventSchema,
  OperationProgressEventSchema,
  SessionImageEventSchema,
  SessionSchema,
  StreamEventSchema,
  UsageStatusSchema,
} from '@dorkos/shared/schemas';
import {
  SessionLifecycleSchema,
  SessionListEventSchema,
  type SessionListEvent,
} from '@dorkos/shared/session-stream';
import type {
  HistoryMessage,
  InterruptReceipt,
  PermissionModeId,
  Session,
  StreamEvent,
} from '@dorkos/shared/types';
import { InterruptReceiptSchema } from '@dorkos/shared/schemas';

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
  permissionMode?: PermissionModeId;
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
   * Produces a session this runtime's LIST path will report, running at a
   * caller-chosen working directory — the wiring behind the subtree-membership
   * invariant (DOR-1550).
   *
   * The default tracks one with `ensureSession`, which is all a registry-backed
   * runtime needs. Wire this when a runtime lists from a STORE it must first be
   * given something to read: claude-code lists SDK JSONL transcripts, so an
   * `ensureSession` alone produces nothing to list and the invariant would fail
   * on the seeding rather than on the rule.
   *
   * There is deliberately no "cannot be scripted" waiver. Every runtime lists
   * sessions per project — that IS the `listSessions(projectDir)` contract — so
   * a runtime that cannot be given a listable session at a chosen directory
   * cannot honour it either, and the honest report is a red.
   *
   * @param runtime - The runtime instance under test.
   * @param cwd - The working directory the session must run in.
   * @returns The seeded session's id.
   */
  listableSessionAt?: (runtime: AgentRuntime, cwd: string) => Promise<string> | string;
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
   * A turn that fails because the runtime's CREDENTIAL is expired, revoked or
   * invalid — the gate behind "auth errors speak DorkOS copy on every channel
   * and runtime" (DOR-1656).
   *
   * Wire it and the suite drives the turn, then holds the resulting `error`
   * event to three rules: it is categorised `auth_error`, its `message` is the
   * shared DorkOS sentence for THIS runtime
   * ({@link describeAuthError}, which names the runtime rather than Claude),
   * and the backend's own words survive in `details`.
   *
   * **Why the vendor text is supplied rather than inferred.** "The message is
   * not vendor internals" is unfalsifiable without knowing what the vendor
   * actually said — a suite that only checked the message was non-empty passes
   * on the raw string it exists to reject. So the wiring names the exact text
   * it scripted its backend with, and the suite checks that text landed in
   * `details` while the message came from DorkOS. A wiring whose backend never
   * emits the named string fails on `details`, so the two halves keep each
   * other honest.
   *
   * Omit only when a credential failure cannot be scripted (a live-binary smoke
   * cannot revoke a real sign-in on demand); the case then SKIPs by name rather
   * than passing on an absence.
   */
  authFailure?: {
    /** Produces a runtime whose next `sendMessage` turn fails on credentials. */
    makeRuntime: () => AgentRuntime;
    /**
     * The VERBATIM backend text that failure carries — the vendor string that
     * must never be what a person reads.
     */
    vendorText: string;
    /**
     * Puts that same credential failure through this runtime's REAL history
     * path and returns what a REOPENED session is served (DOR-1678).
     *
     * The live half above says what a person sees while the turn is failing.
     * This one says what they see the next morning, and the two are different
     * code paths in every runtime: claude-code re-parses the JSONL its CLI
     * wrote, codex replays the durable EventLog, opencode reads its sidecar's
     * store. The property was pinned three separate times, once per runtime,
     * and nowhere shared — so a fourth adapter could ship a live `auth_error`
     * card that reloads as the vendor's 401 pasted in as something the agent
     * said, and every suite in the tree would still be green.
     *
     * **Drive the real reader, never hand back a shape you built.** The
     * returned array must come from `getMessageHistory` (or whatever the
     * product calls on reopen), reading state the failing turn genuinely left
     * behind. A driver that assembles a `HistoryMessage` itself asserts only
     * that its author knows what the answer should look like — the exact
     * failure `.claude/rules/testing.md` catalogues. Where a runtime's backend
     * is mocked and therefore writes no durable record, the honest stand-in is
     * the record the REAL backend writes, copied from an observed one — the
     * same latitude `expiredQuestionHistory` takes, and the reason each wiring
     * says on the spot where its fixture came from.
     *
     * Omit it and the reload case SKIPs by name rather than passing on an
     * absence, exactly as the live half does when {@link authFailure} itself is
     * missing. A runtime whose history cannot be reached from this seam is
     * saying so out loud, not quietly getting a green.
     *
     * @param runtime - The failing runtime from {@link authFailure.makeRuntime}.
     * @param sessionId - The session the suite already called `ensureSession` for.
     * @param content - The user message the turn should carry.
     * @returns The history a reopened session would be served.
     */
    hydratedHistory?: (
      runtime: AgentRuntime,
      sessionId: string,
      content: string
    ) => Promise<HistoryMessage[]>;
  };
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
   * Why this runtime legitimately repeats the message it was triggered with
   * back in its own output.
   *
   * Exactly one thing qualifies: a scripted fixture whose whole contract is to
   * answer deterministically from what it was sent (test-mode's `Echo: …`). No
   * runtime that reaches a real model qualifies — replaying the prompt is the
   * DOR-1659 bug, not a style.
   *
   * Narrow on purpose: declaring it waives ONLY the trigger-content half of the
   * check. The injected-context half still runs, because no runtime, scripted or
   * not, may ever stream another person's `<room_context>` back into a room.
   */
  echoesTriggerReason?: string;
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
   * Drives ONE turn whose model or tools produce an IMAGE, and returns every
   * StreamEvent it yielded.
   *
   * Provided only by runtimes that declare `mediaOutput` other than `'none'`.
   * Keyed on the declaration, not on the driver: a runtime that claims it
   * carries media and wires no driver FAILS rather than skipping, because a
   * silent skip about media is the exact failure this whole invariant exists to
   * end — before it, no runtime declared anything about media, all three
   * dropped every image, and the suite reported the same green for all of them.
   *
   * Owns its own setup (like `terminalOnce`), because a media turn needs a
   * differently-scripted backend than the suite's default runtime carries.
   */
  mediaTurn?: () => Promise<StreamEvent[]>;

  /**
   * Drives ONE turn that ASKS a question nobody answers, lets the ask expire,
   * closes the turn, and returns the history a reopened session would be
   * served.
   *
   * Provided only by runtimes that declare `supportsQuestionPrompt` AND can
   * reach the unanswered ending deterministically. Omit it and the case SKIPs
   * by name rather than passing on an absence the suite manufactured — the same
   * rule the presence and disposition drivers follow, and for the same reason:
   * a runtime's `sendMessage` moves no projector, so an assertion read off it
   * alone would report the same thing for every runtime and prove nothing.
   *
   * The ending must be reached the way production reaches it — the runtime's
   * real timeout/cancel path through the normalizer and projector — never by
   * writing a `questionOutcome` into history by hand, which would assert only
   * that the driver can type.
   */
  expiredQuestionHistory?: (
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
   * Drives a session to WARM — a completed turn with the process still held —
   * and hands control back.
   *
   * Provided ONLY by runtimes declaring `supportsPersistentSession`. Omit it and
   * the warmth cases SKIP by name rather than passing on an absence the suite
   * manufactured: a runtime's `sendMessage` moves no projector, so a warmth
   * assertion read off it alone would report the same thing for every runtime
   * and assert nothing. Whatever per-session opt-in the runtime requires is the
   * driver's job to arrange — the capability says the adapter CAN hold a
   * process, not that every session does.
   */
  warmSession?: (runtime: AgentRuntime, sessionId: string) => Promise<void>;
  /**
   * Drives ONE turn to the point where it is OPEN, calls `midTurn`, then lets it
   * close. Required for the C1 disposition cases; without it a runtime that
   * DECLARES a disposition SKIPs the open-turn half by name rather than passing
   * on a manufactured absence.
   *
   * A steer only reaches a turn that is already running, so proving "a declared
   * steer delivers into the open turn, minting no new `turn_start`" needs a turn
   * genuinely open underneath the assertion — and a runtime's own `sendMessage`
   * moves no projector, so a case driven off it alone reads `idle` for every
   * runtime and asserts nothing. The driver holds a turn open through the same
   * projector `getSessionSnapshot` resolves, so what the suite reads mid-`midTurn`
   * is the adapter answering about a turn that is really streaming.
   *
   * Provided ONLY by runtimes that declare `supportsSteer` or
   * `supportsContextStaging` — a runtime that declares neither has no open-turn
   * delivery to prove and wiring one is the error the suite catches. How the
   * driver holds a turn open (a scenario that parks, a persistent window left
   * unanswered) is its own concern; the capability says the adapter CAN deliver
   * into a turn, not that any given `sendMessage` stays open.
   */
  dispositionTurn?: (
    runtime: AgentRuntime,
    sessionId: string,
    content: string,
    probes: { midTurn: () => Promise<void> }
  ) => Promise<void>;
  /**
   * Drives ONE turn window that carries TWO native terminals with no reopening
   * content between them, and returns how many `turn_end`s the projector
   * synthesized — the driver for the C2 terminal-exactly-once case.
   *
   * The collapse-to-one is the PLATFORM's job (`feedProjector`'s idempotent
   * `closeTurn`, spec task 0.1), not any adapter's, so this is runtime-neutral:
   * the input is a synthetic two-result backend rather than the runtime under
   * test, because "however many native results the backend produced" is exactly
   * the variable C2 pins and no shipped adapter emits two in one window on
   * demand. Wire it (`driveTerminalOnce`) so C2 runs; omit it and C2 SKIPs by
   * name. The suite asserts the count is `1` — seeding the defect makes it climb.
   */
  terminalOnce?: () => Promise<number>;
  /**
   * Exercises the server-owned queue's two durability promises against the real
   * dispatcher and store, returning what it observed — the driver for the C3
   * queue-durability case.
   *
   * The queue is server-owned by construction (spec §2.4 — no `supportsQueue`
   * flag, no adapter opts out), so C3 is a platform invariant every runtime
   * inherits, driven with a controllable runtime because both failure modes need
   * a turn that PARKS on command (a held failure, an open approval) that no
   * shipped adapter's mocked backend can be made to do here. Wire it
   * (`driveQueueDurability`) so C3 runs; omit it and C3 SKIPs by name.
   */
  queueDurability?: () => Promise<{
    ranBehindFailedTurn: boolean;
    heldWhileInteractionPending: boolean;
    ranAfterInteractionResolved: boolean;
  }>;
  /**
   * Stages a session with a GENUINELY ACTIVE turn whose interrupt call the
   * backend will never acknowledge, then hands control back — the driver
   * behind this suite's C11 bounded-interrupt case.
   *
   * **This C11 is not `meta/chat-capabilities.md`'s C-11 row.** The doc's
   * C-11 is "Add context" (a capability id in its numbered matrix); this
   * suite's numbering is its own, separate sequence of conformance CASES —
   * the two happen to collide on the number by coincidence, not by any
   * shared meaning. Read `C11` here as "this file's eleventh case."
   *
   * "Stop is bounded" (`meta/chat-capabilities.md` C-10 matrix preamble;
   * DOR-1244) is only provable against a turn whose backend has gone quiet:
   * a runtime's own `interruptQuery` on an idle session already answers
   * `false` at once, which proves nothing about a WEDGED one. Arranging the
   * hang is adapter-specific — an SDK control promise nothing settles for
   * claude-code, an HTTP call to a stuck sidecar for opencode — so this
   * driver is that half only; the suite races `interruptQuery` against a
   * clock once it hands back.
   *
   * Provided only by runtimes whose interrupt path awaits a backend ack that
   * can go unanswered. Omit it and C11 still runs, AT REST rather than
   * skipping: a runtime with no round trip to wait on — codex's synchronous
   * `controller.abort()`, test-mode's in-process abort — proves the property
   * by construction, and the case asserts exactly that shape instead.
   *
   * @returns The EXACT receipt `interruptQuery` must settle to once the suite
   *   advances past the bound — not merely "some receipt". The two shipped
   *   drivers disagree on purpose: claude-code escalates an unacked
   *   interrupt to `query.close()` and reports `closed` / `ack-timeout` (the
   *   process WAS stopped, just not gracefully); opencode has no session-scoped
   *   escalation to reach for and reports `unconfirmed` / `ack-timeout`
   *   (honest, not a lie of omission). Pinning the receipt, rather than
   *   accepting either, is what catches a runtime that silently started
   *   answering the wrong one on expiry — and the two differ in `outcome`, so
   *   the distinction the boolean could not carry is exactly what is pinned.
   */
  hangingInterrupt?: (runtime: AgentRuntime, sessionId: string) => Promise<InterruptReceipt>;
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
  /**
   * Produces the Session **this runtime's LIST path reports** for a conversation
   * a person has written to — the presence half of the `Session.userLastMessageAt`
   * contract (spec `sidebar-now-today-library` BC-16).
   *
   * Read it off `listSessions`, not `getSession`: `userLastMessageAt` is a
   * field of the recents LIST, that is the path the sidebar actually calls, and
   * a runtime can populate one without the other.
   *
   * **Your fixture has an obligation, and it is not optional.** It must contain
   * agent activity AFTER the person's last message, so the reported instant is
   * strictly earlier than the session's own `updatedAt`. That gap is the only
   * thing that can distinguish a real derivation from `updatedAt` returned
   * under a second name, and the suite asserts it. This is a requirement on the
   * FIXTURE rather than a claim about runtimes in general — a conversation that
   * really did end on the person's turn has both facts legitimately equal, and
   * such a conversation simply cannot serve as the probe.
   *
   * Wire this, or declare {@link userLastMessageAtOmittedReason}. A runtime that
   * supplies neither fails the case rather than skipping it: "nobody decided"
   * is not one of the two honest answers.
   */
  userLastMessageAtSession?: (runtime: AgentRuntime) => Promise<Session>;
  /**
   * Why this runtime can never say when the person last wrote, in a sentence
   * somebody wrote — required rather than a boolean for the same reason as
   * {@link autonomyDefaultReason}, and whitespace declares nothing.
   *
   * Declaring it does not buy silence: the suite then asserts the field is
   * strictly ABSENT on a session that has just received a user message, so an
   * omitting runtime cannot quietly start emitting a placeholder, a null, or
   * its `updatedAt`. Implementing the field means DELETING this reason and
   * wiring {@link userLastMessageAtSession}.
   */
  userLastMessageAtOmittedReason?: string;
  /**
   * Drives TWO turns on ONE session with two DIFFERENT
   * {@link MessageOpts.systemPromptAppend} values, and reports what the backend
   * was handed each time — the gate behind `project-rooms` §3.3.
   *
   * **What it must return is the BACKEND's input, never the caller's.** Each
   * element is everything the adapter handed its backend for that turn on
   * whatever channel it delivers the append through: the SDK launch options for
   * claude-code, the composed prompt for codex, the synthetic part for
   * opencode. A driver that echoed the string it was given back would assert
   * only that the suite can pass an argument.
   *
   * **The second turn is the whole point.** A room's conventions change when a
   * merge lands, and the block that carries them has to reach the NEXT turn of
   * a conversation that is already running — including one whose process is
   * still warm. A runtime that binds the append at session start and rides it
   * afterwards fails this case, and the caller has to deliver the block some
   * other way (a tagged `additionalContext` entry) rather than believe a seam
   * that quietly stopped moving.
   *
   * Wire this, or declare {@link systemPromptAppendUnprovenReason}. A runtime
   * that supplies neither fails the case rather than skipping it, for the same
   * reason `userLastMessageAt` does: "nobody decided" is not one of the two
   * honest answers.
   *
   * @param runtime - The runtime under test.
   * @param sessionId - The session BOTH turns run on.
   * @param appends - The append for turn one, then the append for turn two.
   * @returns What the backend received for turn one, then for turn two.
   */
  systemPromptAppendTurns?: (
    runtime: AgentRuntime,
    sessionId: string,
    appends: readonly [string, string]
  ) => Promise<readonly [string, string]>;
  /**
   * Why this suite cannot see what this runtime's backend was handed, in a
   * sentence somebody wrote — required rather than a boolean for the same
   * reason as {@link autonomyDefaultReason}, and whitespace declares nothing.
   *
   * Two legitimate uses, and they are different claims. `test-mode` answers
   * from a scripted fixture and has no model to give a system prompt to at
   * all. A LIVE-binary smoke run has a model but no seam to read its input
   * off, so the same suite that proves the property in mocked mode cannot
   * prove it there. Both are "unproven here", which is what the field says —
   * neither is a claim that the append is dropped.
   *
   * A production runtime declaring this in its MOCKED run is telling you a
   * caller's per-run instructions may be silently dropped on it, with nothing
   * in the suite that would notice.
   */
  systemPromptAppendUnprovenReason?: string;
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

/**
 * Which of the two honest answers this runtime signed up for, if either.
 *
 * Exported and separate from the assertions below for the same reason
 * {@link evaluateSessionListStream} is: the suite only ever meets adapters that
 * are supposed to pass, so a green run is no evidence these rules fired.
 * `runtime-conformance-last-user-message.test.ts` drives them directly.
 *
 * @param supplies - Whether {@link RuntimeConformanceOpts.userLastMessageAtSession} was wired.
 * @param omittedReason - The runtime's {@link RuntimeConformanceOpts.userLastMessageAtOmittedReason}.
 * @returns Null when the runtime picked an arm, else the failure message.
 */
export function chooseUserLastMessageAtArm(
  supplies: boolean,
  omittedReason: string | undefined
): string | null {
  const declared = (omittedReason ?? '').trim().length > 0;
  if (supplies && declared) {
    return (
      'this runtime both supplies Session.userLastMessageAt and declares it cannot ' +
      '(userLastMessageAtSession + userLastMessageAtOmittedReason). Pick one — the ' +
      'reason string exists to be DELETED when the field is implemented.'
    );
  }
  if (supplies || declared) return null;
  return (
    'a runtime must either supply Session.userLastMessageAt (wire userLastMessageAtSession) ' +
    'or declare in a sentence why it cannot (userLastMessageAtOmittedReason). Choosing ' +
    'neither leaves the sidebar ordering Today on a field nobody decided about, and ' +
    'whitespace declares nothing.'
  );
}

/**
 * The presence half of the `Session.userLastMessageAt` contract, applied to one
 * probe session (spec `sidebar-now-today-library` BC-16).
 *
 * `userLastMessageAt < updatedAt` is asserted as a **fixture obligation, not a
 * runtime invariant**. Plenty of real conversations end on the person's turn
 * and have both facts legitimately equal; nothing forbids a runtime from
 * reporting that. But such a conversation proves nothing here, because a
 * runtime that simply renamed `updatedAt` would pass on it. So the probe is
 * required to hand over a conversation the agent worked on afterwards, and a
 * fixture that cannot discriminate is rejected rather than passing.
 *
 * @param session - The Session the runtime's list path reported for the probe.
 * @returns Null when the reading satisfies the contract, else the failure message.
 */
export function evaluateUserLastMessageAtPresence(session: Session): string | null {
  const reported = session.userLastMessageAt;
  if (reported === undefined) {
    return (
      'this runtime declares it can say when the person last wrote, but its probe ' +
      'session reports nothing'
    );
  }
  const at = Date.parse(reported);
  if (Number.isNaN(at)) return `userLastMessageAt '${reported}' is not a date`;
  const updated = Date.parse(session.updatedAt);
  if (Number.isNaN(updated)) return `updatedAt '${session.updatedAt}' is not a date`;
  if (at >= updated) {
    return (
      `userLastMessageAt (${reported}) is not EARLIER than updatedAt (${session.updatedAt}). ` +
      'Either your probe fixture has no agent activity after the person’s last message — ' +
      'in which case it cannot discriminate and needs one, since a runtime that renamed ' +
      'updatedAt would pass on it — or this runtime is in fact reporting updatedAt under ' +
      'a second name.'
    );
  }
  return null;
}

/**
 * The omission half: a runtime that declared it cannot say when the person last
 * wrote must report NOTHING even after a person has written.
 *
 * `undefined` is the only accepted answer. A null, an empty string or a
 * placeholder all reach the client as a value it would order Today on, which is
 * precisely the guess the contract forbids.
 *
 * A null session is a FAILURE, not a pass: the turn completed, so a runtime that
 * cannot resolve the session it just ran gives this case nothing to look at and
 * would report green having asserted nothing.
 *
 * @param session - What the runtime reported for a session that just took a user
 *   message.
 * @param omittedReason - The declared reason, quoted back in the failure.
 * @returns Null when the runtime honestly said nothing, else the failure message.
 */
export function evaluateUserLastMessageAtOmission(
  session: Session | null,
  omittedReason: string | undefined
): string | null {
  if (session === null) {
    return (
      'getSession returned null for a session that had just completed a turn, so this ' +
      'case had no reported field to look at and asserted nothing.'
    );
  }
  if (session.userLastMessageAt === undefined) return null;
  return (
    `this runtime declared it cannot say when the person last wrote ("${omittedReason}") ` +
    `but reported ${JSON.stringify(session.userLastMessageAt)} after a user message. ` +
    'Implementing the field means deleting that reason and wiring userLastMessageAtSession.'
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
 * The blocks DorkOS wraps around a person's message before handing it to a
 * runtime — the runtime-neutral agent context (`runtimes/shared/agent-context.ts`),
 * the per-turn `AdditionalContext` entries (ADR-0273, `ContextKind`), OpenCode's
 * `<gen_ui>` and `<room_tools>` preamble, and the `<dork-kickoff>` birth-turn
 * envelope.
 *
 * Listed rather than imported: these tags are written as literals at the seams
 * that build them, there is no shared registry to read, and a conformance suite
 * that imported one adapter's constants would stop being runtime-neutral.
 *
 * The list is therefore best-effort, and safely so: a tag missing from it only
 * makes this half of the check weaker, never wrong. The exact match on the
 * trigger content beside it needs no list at all, and is the half that actually
 * caught DOR-1659.
 *
 * `env` is the one entry a model could plausibly type on its own, so in LIVE
 * mode it is the one that could fail on an honest answer. It stays because it
 * names a block DorkOS really does inject and dropping it would trade real
 * coverage for a hypothetical, and because the failure is self-describing: the
 * assertion message names the tag, so an answer that genuinely said `<env>`
 * reads as exactly that rather than as a mystery. Narrow the PROMPT before
 * narrowing this list.
 */
const INJECTED_CONTEXT_TAGS = [
  'gen_ui',
  'agent_identity',
  'agent_persona',
  'agent_safety_boundaries',
  'agent_memory',
  'session_model',
  'dorkos_context',
  'user_profile',
  'env',
  'room_tools',
  'room_context',
  'relay_context',
  'git_status',
  'ui_state',
  'staged_context',
  'seed_context',
  'dork-kickoff',
];

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
 * The three disposition flags P4 made first-class, required and compile-time
 * forced (ADR-0256 precedent). Held in their OWN list, and asserted by the
 * dedicated C6 case rather than folded into {@link BOOLEAN_CAPABILITY_FLAGS},
 * because they are the flags the whole degradation ladder routes on: a runtime
 * that declares one it cannot honor sends a person's steer somewhere it did not
 * go, so a cast that slips a non-boolean past the compiler must still be caught.
 */
const DISPOSITION_CAPABILITY_FLAGS = [
  'supportsPersistentSession',
  'supportsSteer',
  'supportsContextStaging',
] as const satisfies readonly (keyof RuntimeCapabilities)[];

/** The two non-turn-opening delivery modes {@link AgentRuntime.deliverIntoTurn} takes. */
const DELIVER_MODES = ['steer', 'stage'] as const;

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
 * The event types that carry an agent's OWN output, as opposed to bookkeeping.
 *
 * Used where a case has to tell "the turn said something" from "the turn
 * happened": a terminal `done`, a `session_status` and an `error` are all
 * events, and none of them is the agent answering.
 */
const CONTENT_EVENT_TYPES = new Set([
  'text_delta',
  'tool_call_start',
  'tool_result',
  'thinking_delta',
]);

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
    listableSessionAt,
    makeFailingRuntime,
    authFailure,
    makeCompactingRuntime,
    mediaTurn,
    durableHistory,
    expiredQuestionHistory,
    presenceTurn,
    warmSession,
    dispositionTurn,
    terminalOnce,
    queueDurability,
    hangingInterrupt,
    autonomyDefaultReason,
    sessionListSilentReason,
    userLastMessageAtSession,
    userLastMessageAtOmittedReason,
    systemPromptAppendTurns,
    systemPromptAppendUnprovenReason,
    echoesTriggerReason,
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
   * through unnoticed. The id needs no bridging any more: `SessionOpts.permissionMode`
   * carries the runtime-declared id it always held in practice (DOR-885), so the
   * declared default travels into `ensureSession` exactly as its runtime named it.
   *
   * @param runtime - The runtime instance under test in THIS test.
   */
  function resolvePermissionMode(runtime: AgentRuntime): PermissionModeId {
    if (permissionModeOverride !== undefined) return permissionModeOverride;
    return runtime.getCapabilities().permissionModes.default ?? 'default';
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

  /**
   * Seed a session this runtime will LIST, running at `cwd` — the declared
   * wiring when one is given, else a plain `ensureSession`.
   *
   * @param runtime - The runtime instance under test.
   * @param cwd - The working directory the session must run in.
   */
  async function seedListableSession(runtime: AgentRuntime, cwd: string): Promise<string> {
    if (listableSessionAt) return listableSessionAt(runtime, cwd);
    const sessionId = nextSessionId();
    runtime.ensureSession(sessionId, { permissionMode: resolvePermissionMode(runtime), cwd });
    return sessionId;
  }

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

      it('lists a session started INSIDE the project, and never a lookalike sibling (DOR-1550)', async () => {
        // The other half of the membership rule. A person opens a project and
        // starts an agent in `packages/api`; that session is the project's
        // session, and every runtime used to decide otherwise by comparing the
        // two directory strings for equality. DOR-674 fixed OpenCode's sidecar
        // listing and deferred this invariant because claude-code would have
        // failed it; DOR-1550 is where the rest of the set caught up.
        const runtime = makeRuntime();
        const subfolder = `${projectDir}/packages/api`;
        const inside = await seedListableSession(runtime, subfolder);
        // `<project>-2` shares a character prefix with the project and shares no
        // path SEGMENT with it — the trap a `startsWith` check falls into, and
        // the control that keeps the case above from passing by listing
        // everything on the machine.
        const sibling = await seedListableSession(runtime, `${projectDir}-2`);
        // And the project's own directory, so a wiring that seeds nothing
        // listable fails here rather than silently proving nothing.
        const own = await seedListableSession(runtime, projectDir);

        const listed = await runtime.listSessions(projectDir);
        const ids = listed.map((s) => s.id);
        expect(ids, 'the project’s own session must list at all').toContain(own);
        expect(ids, 'a session started in a subfolder belongs to the project').toContain(inside);
        expect(ids, 'a sibling project’s session is not this project’s').not.toContain(sibling);
        // Each row still says where it is really running — a listing that
        // rewrote `cwd` to the project would hide which folder an agent is in.
        expect(listed.find((s) => s.id === inside)?.cwd).toBe(subfolder);
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
          if (session.userLastMessageAt !== undefined) {
            expect(typeof session.userLastMessageAt).toBe('string');
          }
        }

        await expect(runtime.getSession(projectDir, nextSessionId())).resolves.toBeNull();
      });

      it('C10: getSessionCwd answers without a directory lookup, never throws, and follows a warmed binding', async (ctx) => {
        // The cwd-free counterpart of getSession (DOR-1322): a route resolving
        // a session's messages without a caller-supplied cwd asks this FIRST.
        // Optional: a runtime with no live per-session binding (or none at
        // all) omits it, and callers fall back to an explicit projectDir.
        const runtime = makeRuntime();
        const getSessionCwd = runtime.getSessionCwd?.bind(runtime);
        if (getSessionCwd === undefined) {
          // A SKIP, not a pass, for C7's reason: an `it` that returns early is
          // indistinguishable from one that asserted something.
          ctx.skip(
            'this runtime does not implement `getSessionCwd`, so callers fall back to an ' +
              'explicit `projectDir` (see AgentRuntime.getSessionCwd)'
          );
          return;
        }

        // (1) ANSWERABLE for a session it has never heard of, never a throw —
        // a route on a graceful-degradation path cannot afford a lookup that
        // dereferences a missing entry.
        const strangerId = nextSessionId();
        expect(
          () => getSessionCwd(strangerId),
          'getSessionCwd must answer for a session it has never heard of, not throw'
        ).not.toThrow();
        expect(
          getSessionCwd(strangerId),
          'an id this runtime has never heard of must answer undefined, never a guessed directory'
        ).toBeUndefined();

        // (2) The answer FOLLOWS THE MECHANISM — checkable exactly where the
        // suite can move a session into the state that binding lives in.
        if (!warmSession) return;

        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));
        await warmSession(runtime, sessionId);

        expect(
          getSessionCwd(sessionId),
          'a warmed session`s live binding must be answered, matching the directory it was warmed with'
        ).toBe(projectDir);
      });

      it('C12: getSessionAccount names the credential a turn ran on, stably, or does not exist', async (ctx) => {
        // The account half of C10, and the seam the sign-in watch keys its
        // episodes on (DOR-1682): with no way to ask which credential a turn
        // used, a clean turn on a healthy Claude account cleared a condition a
        // DEAD one had raised — an all-clear that never happened.
        //
        // Optional, and omitting it is the RIGHT answer for a runtime with one
        // set of credentials (codex and opencode each have one home directory).
        // The watch reads the absence as "do not distinguish" and behaves
        // exactly as it did before accounts existed.
        const runtime = makeRuntime();
        const getSessionAccount = runtime.getSessionAccount?.bind(runtime);
        if (getSessionAccount === undefined) {
          // A SKIP, not a pass, for C7's reason: an `it` that returns early is
          // indistinguishable from one that asserted something.
          ctx.skip(
            'this runtime does not implement `getSessionAccount`, so every one of its turns runs ' +
              'on the same credential and the sign-in watch keys on the runtime alone ' +
              '(see AgentRuntime.getSessionAccount)'
          );
          return;
        }

        // (1) ANSWERABLE for a session it has never heard of, never a throw. The
        // caller is an observer wrapped around somebody else's turn, so a lookup
        // that dereferences a missing entry would fail a turn it only watches.
        const strangerId = nextSessionId();
        expect(
          () => getSessionAccount(strangerId),
          'getSessionAccount must answer for a session it has never heard of, not throw'
        ).not.toThrow();
        expect(
          getSessionAccount(strangerId),
          'an id this runtime has never heard of must answer undefined, never a guessed account — ' +
            'a guess files a dead credential under the wrong key, which is wrong in both directions'
        ).toBeUndefined();

        // (2) It NAMES the account once a turn has actually run. A runtime that
        // answers undefined here has implemented nothing the watch can use, and
        // is better off omitting the method — the absence is a supported,
        // documented answer and a constant undefined only pretends otherwise.
        if (!warmSession) return;

        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));
        await warmSession(runtime, sessionId);

        const account = getSessionAccount(sessionId);
        expect(
          typeof account,
          'a session that has taken a turn must have its account named — a runtime that can never ' +
            'name one should omit getSessionAccount rather than always answer undefined'
        ).toBe('string');
        expect(account, 'an empty account name distinguishes nothing').not.toBe('');

        // (3) The SAME string for a DIFFERENT session on the same account, which
        // is the property the watch actually depends on and the one a per-session
        // check cannot see. Its two edges are never the same session: one turn
        // discovers the dead credential, and a LATER turn on some other session
        // is what proves it working again. So an identity that varies by how a
        // session was started reads as two accounts, and the condition raised
        // under one spelling can never be resolved by the other — a notice that
        // stands for the life of the install.
        //
        // What this half can and cannot catch, stated so nobody over-reads it:
        // it fails any runtime whose identity is DERIVED per session (a session
        // id folded in, a counter, a fresh object's `toString`). It cannot fail a
        // runtime whose identity merely varies with how a session was STARTED,
        // because the suite has one way of starting one. That case needs a
        // fixture that can produce two spellings, which only the adapter's own
        // suite can build — claude-code's lives beside its conformance call.
        const secondId = nextSessionId();
        runtime.ensureSession(secondId, sessionOpts(runtime));
        await warmSession(runtime, secondId);

        expect(
          getSessionAccount(secondId),
          'two sessions on one account must answer the SAME string — canonicalize the identity in ' +
            'the adapter rather than handing on however the caller happened to spell it'
        ).toBe(account);
      });

      it('says when the person last wrote, or says why it cannot (BC-16)', async () => {
        // Purpose: `Session.userLastMessageAt` is half the sidebar's Today
        // order key, and the contract is "omission, never a guess". Two honest
        // answers exist — a real timestamp, or nothing — and a runtime that
        // picked neither is the third, which this case exists to prevent. The
        // rules live in the exported evaluators so a proof-of-failure test can
        // drive them with sessions no shipped runtime would produce.
        expect(
          chooseUserLastMessageAtArm(
            userLastMessageAtSession !== undefined,
            userLastMessageAtOmittedReason
          )
        ).toBeNull();

        if (userLastMessageAtSession !== undefined) {
          const session = await userLastMessageAtSession(makeRuntime());
          expect(evaluateUserLastMessageAtPresence(session)).toBeNull();
          return;
        }

        // The omission half: a runtime that declared it cannot say must report
        // NOTHING even once a person has written — never a null, an empty
        // string, or the row's own updatedAt.
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));
        await drainTurn(runtime, sessionId);
        const session = await runtime.getSession(projectDir, sessionId);
        expect(
          evaluateUserLastMessageAtOmission(session, userLastMessageAtOmittedReason)
        ).toBeNull();
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

      it('updateSession answers with an outcome, and says pending only when it means it', async () => {
        // ## The shape (DOR-1435)
        //
        // `updateSession` used to answer a bare boolean, so "saved" and "in
        // force on the turn already running" were the same word. They are not:
        // the choice is persisted before the running turn is told (ADR-0260),
        // and two of the three shipped adapters cannot tell it at all — Claude's
        // CLI stops calling back under a mode that never asks, and Codex's
        // sandbox is fixed when the turn starts. A runtime that cannot confirm a
        // TIGHTENING reached the run says so, and the PATCH route turns that
        // into a `202`.
        //
        // Two things are pinned here, both cheap and both easy to get wrong in a
        // new adapter. First, the outcome is an OBJECT — a fifth runtime still
        // returning `true` would otherwise sail through, and the route reads
        // `.updated`, so `true` reads as "session not found" and answers 404.
        // Second, `permissionModePendingUntilNextTurn` is `true` or ABSENT and
        // never `false`: the wire schema types it `z.literal(true).optional()`,
        // so a literal `false` would be stripped at the boundary and a runtime
        // author would think they had reported something.
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));

        const result = await runtime.updateSession(sessionId, {
          permissionMode: resolvePermissionMode(runtime),
        });

        expect(
          typeof result,
          'updateSession must answer with a SessionUpdateResult object, not a bare boolean'
        ).toBe('object');
        expect(typeof result.updated, 'SessionUpdateResult.updated must be a boolean').toBe(
          'boolean'
        );
        expect(
          result.updated,
          'a session this suite just created must be found by updateSession'
        ).toBe(true);
        expect(
          result.permissionModePendingUntilNextTurn,
          'permissionModePendingUntilNextTurn must be true or absent — never false, which the wire schema strips'
        ).not.toBe(false);
        // Re-picking the mode the session is already on takes nothing away, so
        // there is nothing to be pending about, turn or no turn.
        expect(
          result.permissionModePendingUntilNextTurn,
          'a no-op mode change reported itself as not yet in force'
        ).toBeUndefined();
      });

      it('updateSession answers `updated: false` for a session it does not have', async () => {
        // The one case the boolean carried and the object must keep carrying:
        // the route turns it into a 404. A runtime that auto-creates on PATCH
        // (claude-code, codex) has no such case and answers true — both are
        // conformant, which is why this asserts the TYPE and the route's read,
        // not a particular verdict.
        const runtime = makeRuntime();
        const result = await runtime.updateSession(nextSessionId(), {
          permissionMode: resolvePermissionMode(runtime),
        });
        expect(typeof result.updated).toBe('boolean');
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

      it('never speaks the trigger back, nor any context DorkOS wrapped around it', async () => {
        // A turn's output is the model's answer. The prompt DorkOS wrote — the
        // person's words plus whatever identity, environment and room context
        // the adapter injected around them — is INPUT, and a runtime that
        // replays it as output is not merely untidy: that stream is what a room
        // post is collected from (`room-turn-runner.ts`), what a task-run
        // summary's first 500 characters are taken from, and what the durable
        // event log stores, so an echo puts other people's `<room_context>` text
        // into a shared room and keeps it there. Caught for real in OpenCode
        // (DOR-1659), where the sidecar publishes the user's own message parts
        // on the same wire as the assistant's; asserted here for every runtime
        // because nothing about the mistake is OpenCode-specific.
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));

        const events = await drainTurn(runtime, sessionId);
        const spoken = events
          .filter((event) => event.type === 'text_delta' || event.type === 'thinking_delta')
          .map((event) => (event.data as { text?: unknown }).text)
          .filter((text): text is string => typeof text === 'string')
          .join('');

        // Every assertion below is a `not.toContain` on one string, so a fixture
        // that stopped producing output would satisfy all of them saying
        // nothing — the zero-subject shape REVIEW.md names. Prove there is a
        // subject before judging it.
        expect(
          spoken,
          'the turn produced no output at all — this check would pass vacuously'
        ).not.toBe('');

        if (echoesTriggerReason === undefined) {
          expect(
            spoken,
            'the turn streamed the message it was triggered with back as its own output'
          ).not.toContain(messageContent);
        }
        for (const tag of INJECTED_CONTEXT_TAGS) {
          expect(
            spoken,
            `the turn streamed its injected <${tag}> context block back as its own output`
          ).not.toContain(`<${tag}>`);
        }
      });
    });

    describe('media a turn produces (DOR-1663)', () => {
      // Before this block the conformance suite contained no occurrence of
      // "image", "attachment", "media" or "mime" at all. Every runtime dropped
      // every picture a model or a tool produced, none of them said so, and the
      // suite reported the identical green for all three — which is how a
      // person paid for an image, saw a turn finish, and never found out where
      // it went. The point of what follows is that the runtimes must stop
      // looking the same from the outside.
      //
      // All three production adapters now declare `mediaOutput: 'attachments'`
      // and drive a `mediaTurn` (DOR-1664), so the `else` arm below is reached
      // only by a runtime that genuinely carries no media — today, test-mode,
      // whose scripted turns have none. It asserts the ABSENCE rather than
      // skipping, so a runtime that starts carrying pictures without saying so
      // fails here.

      const declaresMedia = (runtime: AgentRuntime): boolean =>
        runtime.getCapabilities().mediaOutput !== 'none';

      it('declares what it does with media, one way or the other', () => {
        const capabilities = makeRuntime().getCapabilities();
        expect(
          capabilities.mediaOutput,
          'every runtime must say what happens to an image its model or its tools produce — ' +
            "'none' is a perfectly good answer, and silence is not"
        ).toBeDefined();
        expect(['none', 'attachments']).toContain(capabilities.mediaOutput);
      });

      // Keyed on the CAPABILITY, not on the driver — the same rule (and the
      // same reasoning) as the `warmSession` case below.
      it('a runtime declaring media output wires a `mediaTurn` driver', () => {
        const runtime = makeRuntime();
        if (!declaresMedia(runtime)) {
          expect(
            mediaTurn,
            "a `mediaTurn` driver was wired by a runtime that declares `mediaOutput: 'none'"
          ).toBeUndefined();
          return;
        }
        expect(
          mediaTurn,
          'this runtime declares it carries media but wired no `mediaTurn` driver, so nothing ' +
            'here would prove the claim (see RuntimeConformanceOpts.mediaTurn)'
        ).toBeDefined();
      });

      if (mediaTurn) {
        it('announces an image as a REFERENCE, never as bytes on the stream', async () => {
          const events = await mediaTurn();
          const images = events.filter((event) => event.type === 'image_attachment');
          expect(
            images.length,
            'a runtime that declares it carries media must emit an `image_attachment` for a turn ' +
              'that produced one'
          ).toBeGreaterThan(0);

          // ONE PICTURE, ONE ANNOUNCEMENT. A backend that republishes its part
          // snapshots — OpenCode's `message.part.updated` is cumulative and
          // fires repeatedly for the same part — will announce the same image
          // more than once unless the adapter guards it, and a client that
          // appends a part per event then draws it twice. Stated as "no
          // duplicate ids" rather than a count so it holds for a turn that
          // legitimately produced several pictures.
          //
          // This only bites if the driver actually republishes. A driver whose
          // scripted backend publishes each part once passes here for a reason
          // unrelated to the property.
          const ids = images.map(
            (event) => (event.data as { attachmentId?: unknown }).attachmentId
          );
          expect(
            new Set(ids).size,
            `the same picture was announced more than once (${JSON.stringify(ids)}) — one image, ` +
              'one `image_attachment`, however many times the backend republishes the part'
          ).toBe(ids.length);

          for (const image of images) {
            const parsed = SessionImageEventSchema.safeParse(image.data);
            expect(parsed.success, `image_attachment payload is malformed: ${image.data}`).toBe(
              true
            );
            if (!parsed.success) continue;
            // The invariant the whole design turns on. This stream is replayed
            // in full on every reconnect, and its replay buffers hold a bounded
            // WINDOW — so an inlined picture is re-sent forever and spends on
            // itself the window the turn's own words needed.
            expect(
              parsed.data.url.startsWith('data:'),
              'an image must be announced by URL, not inlined as a data: payload — the session ' +
                'stream is replayed whole, and its replay buffers hold a bounded window that ' +
                'inlined pictures would spend on themselves instead of on the transcript'
            ).toBe(false);
            expect(
              parsed.data.mediaType.startsWith('image/'),
              'an image_attachment must declare an image media type'
            ).toBe(true);
          }
        });
      } else {
        it('an ordinary turn from a runtime declaring no media output emits none', async ({
          skip,
        }) => {
          const runtime = makeRuntime();
          if (declaresMedia(runtime)) {
            skip('runtime declares media output — the case above proves it instead');
            return;
          }
          const sessionId = nextSessionId();
          runtime.ensureSession(sessionId, sessionOpts(runtime));

          const events = await drainTurn(runtime, sessionId);
          expect(
            events.filter((event) => event.type === 'image_attachment'),
            "a runtime declaring `mediaOutput: 'none'` must not emit image_attachment — if it " +
              'started carrying media, the declaration is what has to change first'
          ).toEqual([]);
        });
      }
    });

    describe('a session that holds its process open (C4, C5)', () => {
      const declaresPersistence = (runtime: AgentRuntime): boolean =>
        runtime.getCapabilities().supportsPersistentSession === true;

      // Keyed on the CAPABILITY, not on the driver. Keyed on the driver, a
      // runtime that declared `supportsPersistentSession: true` and simply
      // forgot to wire one would skip in silence — the suite would report
      // "nothing proves this" about the one runtime that most needs proving.
      // Declaring the capability is what creates the obligation; the driver is
      // how it is met, and a missing driver is now a failure rather than a skip.
      it('a runtime declaring persistent sessions wires a `warmSession` driver', () => {
        const runtime = makeRuntime();
        if (!declaresPersistence(runtime)) {
          expect(
            warmSession,
            'a `warmSession` driver was wired by a runtime that does not declare `supportsPersistentSession`'
          ).toBeUndefined();
          return;
        }
        expect(
          warmSession,
          'this runtime declares `supportsPersistentSession` but wired no `warmSession` driver, ' +
            'so C4 and C5 would assert nothing about the capability it claims ' +
            '(see RuntimeConformanceOpts.warmSession)'
        ).toBeDefined();
      });

      if (warmSession) {
        it('C4: reports idle with no turn while it sits warm', async () => {
          // The presence contract already forbids `streaming` with an empty
          // `inProgressTurn`, because an empty array is absence wearing the
          // shape of presence. WARM is a NEW way to get that wrong: the process
          // is alive while nothing at all is running, so a runtime that reported
          // warmth as activity would pin every idle chat to "working".
          const runtime = makeRuntime();
          const sessionId = nextSessionId();
          runtime.ensureSession(sessionId, sessionOpts(runtime));

          await warmSession(runtime, sessionId);

          const observation = await observePresence(runtime, sessionId, 'after-turn', projectDir);
          expect(validatePresenceReport(observation), presenceMessage(observation)).toEqual([]);
          expect(
            observation.lifecycle,
            'a warm session is holding a process, not running a turn — and not failing one either'
          ).toBe('idle');
          expect(
            observation.inProgressTurn,
            'a session with nothing running must report no turn at all'
          ).toBeNull();
          // And the warmth itself is reported where warmth belongs. Without
          // this the case would pass on a runtime that never warmed anything.
          expect(
            runtime.getSessionWarmth?.(sessionId),
            'the driver was supposed to leave this session warm'
          ).toBe('warm');
        });

        it('C5: a reap is invisible — the next turn is well formed either way', async () => {
          const runtime = makeRuntime();
          const sessionId = nextSessionId();
          runtime.ensureSession(sessionId, sessionOpts(runtime));

          await warmSession(runtime, sessionId);
          const onWarmProcess = await drainTurn(runtime, sessionId);

          await runtime.reapSession?.(sessionId);
          expect(
            runtime.getSessionWarmth?.(sessionId),
            'the process was supposed to be given back'
          ).toBe('cold');

          const afterReap = await drainTurn(runtime, sessionId);

          // Same shape, both times. The reap took the process away and the
          // person cannot tell: each turn ends in exactly one terminal, carries
          // the agent's actual words, and FAILS AT NEITHER — which is the whole
          // promise of a short idle window being safe.
          //
          // "carried something other than `done`" is deliberately not the test.
          // An `[error, done]` turn satisfies it, so a relaunch that died on the
          // way back up would report a failure to the person and still be called
          // invisible — the exact defect this case exists to catch.
          for (const [label, events] of [
            ['on the warm process', onWarmProcess],
            ['after the reap', afterReap],
          ] as const) {
            for (const event of events) StreamEventSchema.parse(event);
            expect(
              events.filter((event) => event.type === 'done'),
              `the turn ${label} did not end in exactly one terminal`
            ).toHaveLength(1);
            expect(
              events.filter((event) => event.type === 'error'),
              `the turn ${label} failed, so the reap was anything but invisible`
            ).toHaveLength(0);
            expect(
              events.some((event) => CONTENT_EVENT_TYPES.has(event.type)),
              `the turn ${label} carried none of the agent's own output`
            ).toBe(true);
          }
        });

        it('C8: settleOpenTurn answers honestly for a session with nothing open, and never throws', async () => {
          // A held process is the ONLY thing that can strand a turn: everywhere
          // else a turn is bounded by the stream the runtime hands back. So the
          // repair the server runs before every turn (DOR-1295,
          // `settle-open-turn.ts`) is an obligation this capability creates, and
          // this is where it is held rather than asked for in a doc.
          const runtime = makeRuntime();
          expect(
            runtime.settleOpenTurn,
            'this runtime declares `supportsPersistentSession`, so a turn of its own can outlive ' +
              'the stream that carried it — and without `settleOpenTurn` the server has no way ' +
              'to end one before opening the next (see AgentRuntime.settleOpenTurn)'
          ).toBeDefined();

          // A session it has never heard of. The server asks before every turn,
          // including the first one on a brand-new session, so throwing here
          // would make a repair the thing that fails a person's first message.
          await expect(
            runtime.settleOpenTurn!(nextSessionId()),
            'threw (or claimed to settle something) for a session it has never seen'
          ).resolves.toBe(false);

          // And a session that is warm and IDLE — holding a process, running
          // nothing. This is the half a constant `true` cannot survive: it is
          // the state the answer is most tempting to get wrong, because there IS
          // a live process behind it, and a runtime that reported "yes, I
          // settled something" here would be claiming to have ended a turn that
          // never existed — which the server logs as a person's previous reply
          // having failed. A constant `false` passes all three checks, and for a
          // runtime whose turn cannot outlive its stream that is the honest
          // answer rather than a dodge; what C8 pins is that the answer is never
          // an invention.
          const sessionId = nextSessionId();
          runtime.ensureSession(sessionId, sessionOpts(runtime));
          await warmSession(runtime, sessionId);
          expect(
            runtime.getSessionWarmth?.(sessionId),
            'the driver was supposed to leave this session warm'
          ).toBe('warm');
          await expect(
            runtime.settleOpenTurn!(sessionId),
            'a warm session is holding a process, not running a turn — there was nothing to settle'
          ).resolves.toBe(false);

          // Idempotent, and still honest the second time.
          await expect(runtime.settleOpenTurn!(sessionId)).resolves.toBe(false);
        });
      } else {
        it.skip(
          'SKIPPED: this runtime does not declare `supportsPersistentSession`, so it holds no ' +
            'process between turns and there is no warmth to report (a runtime that DOES declare ' +
            'it fails the case above instead of reaching this skip)',
          () => {}
        );
      }
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

    describe('credential failure', () => {
      it('answers in DorkOS words that name this runtime, and keeps the backend text in details (DOR-1656)', async (ctx) => {
        if (!authFailure) {
          // A SKIP, not a pass: an `it` that returns early is
          // indistinguishable from one that asserted something.
          ctx.skip(
            'no authFailure driver was wired for this runtime, so a credential failure could ' +
              'not be scripted here (see RuntimeConformanceOpts.authFailure)'
          );
          return;
        }

        const runtime = authFailure.makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));

        const events = await drainTurn(runtime, sessionId);

        const errorEvent = events.find((event) => event.type === 'error');
        expect(
          errorEvent,
          'a turn that failed on an expired credential must yield an `error` StreamEvent'
        ).toBeDefined();

        const parsed = ErrorEventSchema.safeParse(errorEvent!.data);
        expect(
          parsed.success,
          `malformed error event data: ${parsed.success ? '' : parsed.error.message}`
        ).toBe(true);
        const data = parsed.data!;

        // Without the category the client renders a generic failure with no way
        // back — no "Fix sign-in", no route to Settings → Runtimes.
        expect(
          data.category,
          'a credential failure must be categorised auth_error so the client can offer a way ' +
            'back in, rather than a dead-end execution error'
        ).toBe('auth_error');

        // One voice. Equality rather than a keyword match, because "not the
        // vendor's words" and "this runtime's own name" are the same claim, and
        // a substring check on either half passes on copy that fails the other.
        expect(
          data.message,
          'a person reading this must get DorkOS`s sentence naming THIS runtime, not the ' +
            'backend`s internals and not another runtime`s name — share the copy via ' +
            'describeAuthError(runtime.type) instead of writing a string here'
        ).toBe(describeAuthError(runtime.type));

        // Nothing is lost by speaking plainly: the backend's own words stay
        // reachable behind the client's Details disclosure.
        expect(
          data.details ?? '',
          'the backend`s own failure text must survive in `details` — replacing it in `message` ' +
            'is a translation, not a deletion'
        ).toContain(authFailure.vendorText);

        // Failure must not break the every-path-ends-in-done contract.
        expect(events[events.length - 1]!.type).toBe(TERMINAL_EVENT_TYPE);
      });

      it('survives a reload as that same typed error part, never as agent speech (DOR-1678)', async (ctx) => {
        if (!authFailure) {
          // Same SKIP, same reason as the live half above.
          ctx.skip(
            'no authFailure driver was wired for this runtime, so a credential failure could ' +
              'not be scripted here (see RuntimeConformanceOpts.authFailure)'
          );
          return;
        }
        const { hydratedHistory, vendorText } = authFailure;
        if (!hydratedHistory) {
          ctx.skip(
            'this runtime scripts a credential failure but wires no way to read its history ' +
              'back, so what a reopened session shows is unproven here (see ' +
              'RuntimeConformanceOpts.authFailure.hydratedHistory)'
          );
          return;
        }

        const runtime = authFailure.makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));

        const history = await hydratedHistory(runtime, sessionId, messageContent);

        // Dropped is the failure mode nobody notices: a reader that maps only
        // what the agent SAID gives a turn that failed before it spoke no parts
        // at all, and the whole message disappears — the reopened transcript
        // then shows the question and nothing after it, as if the agent had
        // simply never answered (DOR-1666).
        const parts = history.flatMap((message) => message.parts ?? []);
        const errors = parts.filter((part) => part.type === 'error');
        expect(
          errors.length,
          'a reopened session must show the credential failure EXACTLY once. Zero means the ' +
            'turn that failed before the agent spoke was dropped, and the transcript reads as ' +
            'though nobody ever answered; more than one means a reload stacks up repeat ' +
            '"Fix sign-in" cards for a single expiry'
        ).toBe(1);
        const error = errors[0]!;

        // The same three rules the live half applies, because "what a person
        // reads" cannot depend on whether they happened to reload.
        expect(
          error.category,
          'a reloaded credential failure must keep the auth_error category — without it the ' +
            'reopened session shows a dead-end error where the live turn offered a way back in'
        ).toBe('auth_error');
        expect(
          error.message,
          'a reloaded credential failure must say the same DorkOS sentence the live turn did, ' +
            'naming THIS runtime — share the copy via describeAuthError(runtime.type)'
        ).toBe(describeAuthError(runtime.type));
        expect(
          error.details ?? '',
          'the backend’s own failure text must still be reachable in `details` after a reload, ' +
            'the same as live — translated, not deleted'
        ).toContain(vendorText);

        // And never attributed to the agent. This is the half the per-runtime
        // pins were written for: a transcript reader that lands the vendor's
        // sentence in a text part reports it as something the agent SAID, in
        // the agent's own voice, with no error treatment and no way back in.
        const spoken = [
          ...history.map((message) => message.content),
          ...parts.flatMap((part) =>
            part.type === 'text' || part.type === 'thinking' ? [part.text] : []
          ),
        ];
        for (const said of spoken) {
          expect(
            said,
            'the backend’s credential text must never come back as something the agent said — ' +
              'it belongs in an error part’s `details`, not in speech'
          ).not.toContain(vendorText);
        }
      });
    });

    /**
     * The `reason` half of §4's table, as a rule rather than as a per-cell copy.
     *
     * `reason` is documented as "present whenever it adds information the
     * outcome does not carry", which is not a matter of taste in three of the
     * five cases:
     *
     * - `not-running` and `unconfirmed` and `failed` MUST carry one. Each is an
     *   ending a person is shown or asked to act on, and the reason is the only
     *   thing that says whether the stop was declined, timed out, or never left
     *   the building.
     * - `acked` must NOT. §4 lists no reason on any acked cell, and every reason
     *   in the vocabulary names why a graceful path was abandoned — which by
     *   definition did not happen when the agent itself confirmed.
     * - `closed` is the one genuine MAY: claude-code always has a reason (which
     *   escalation ran), codex has none to give (it has no graceful path to
     *   abandon).
     *
     * @param verb - Which call produced the receipt, for the failure message.
     * @param receipt - The receipt to check.
     */
    function assertReasonPresence(verb: string, receipt: InterruptReceipt): void {
      if (receipt.outcome === 'acked') {
        expect(
          receipt.reason,
          `${verb} answered \`acked\` with a reason. Every reason names why a graceful stop was ` +
            'abandoned, and nothing was abandoned when the agent confirmed the stop itself'
        ).toBeUndefined();
        return;
      }
      if (receipt.outcome === 'closed') return;
      expect(
        receipt.reason,
        `${verb} answered \`${receipt.outcome}\` with no reason. This is an ending a person is ` +
          'shown or asked to act on, and the outcome alone cannot say whether the stop was ' +
          'declined, timed out, or never delivered (spec `runtime-interrupt-receipts` §4)'
      ).toBeDefined();
    }

    describe('interrupt semantics', () => {
      it('I1: with no turn open, interruptQuery resolves not-running — never failed', async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));

        const receipt = await runtime.interruptQuery(sessionId);
        expect(
          receipt.outcome,
          'a stop that arrives after the turn finished on its own is a RACE, not a failure — ' +
            '`not-running` is what says so, and it is the one ending the client stays quiet ' +
            'about. Answering `failed` here would put "Couldn’t stop it. Try again." over a ' +
            'session with nothing left to stop'
        ).toBe('not-running');
        expect(
          receipt.reason,
          '`not-running` carries `no-open-turn`: the outcome says nothing ended, the reason ' +
            'says why'
        ).toBe('no-open-turn');
      });

      it('I2: a receipt from a LIVE turn parses, names THIS runtime, and carries its reason', async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));

        // **A turn must actually be OPEN here, and that is the whole setup.**
        // Every adapter's first branch is "no session, no turn -> not-running",
        // so a version of this case that interrupted an idle session was only
        // ever re-testing I1's precondition: it inspected the one receipt that
        // is minted before any per-runtime mapping runs. Measured, not
        // theorised — with that setup, pointing a runtime's LIVE mapping at
        // another runtime's name left the whole suite green.
        let live: InterruptReceipt;
        if (hangingInterrupt) {
          // The same staging C11 uses, for the same reason: on a runtime whose
          // interrupt awaits a backend ack, only this driver can produce a
          // genuinely active turn. Staged on REAL timers (a driver's own setup
          // leans on macrotask delays), then the bound is advanced through so
          // the receipt lands without spending three real seconds.
          await hangingInterrupt(runtime, sessionId);
          onTestFinished(() => {
            vi.useRealTimers();
          });
          vi.useFakeTimers();
          const pending = runtime.interruptQuery(sessionId);
          await vi.advanceTimersByTimeAsync(10_000);
          live = await pending;
          vi.useRealTimers();
        } else {
          // No driver means this runtime's interrupt has nothing to await, so
          // its turn can be opened the ordinary way and left running: pull ONE
          // event off `sendMessage` and stop reading. The generator is returned
          // in teardown rather than drained — a drained turn is a CLOSED turn,
          // which is exactly what this case must not inspect.
          const turn = runtime.sendMessage(sessionId, messageContent, { cwd: projectDir });
          onTestFinished(() => {
            void turn.return(undefined);
          });
          await turn.next();
          live = await runtime.interruptQuery(sessionId);
        }

        expect(
          live.outcome,
          'the stop was aimed at a turn this case had just opened, so `not-running` means the ' +
            'setup failed to open one — and every assertion below would then be about the ' +
            'pre-mapping receipt rather than about this runtime`s own mapping'
        ).not.toBe('not-running');

        // Both stop-shaped verbs, live receipt included, because a receipt that
        // named the wrong runtime — or carried an outcome outside the five —
        // would reach the UI as a sentence about somebody else's agent.
        for (const [verb, receipt] of [
          ['interruptQuery (live turn)', live],
          ['stopTask', await runtime.stopTask(sessionId, 'task-that-does-not-exist')],
        ] as const) {
          expect(
            InterruptReceiptSchema.safeParse(receipt).success,
            `${verb} must answer the InterruptReceipt vocabulary and nothing else — ` +
              `got ${JSON.stringify(receipt)}`
          ).toBe(true);
          expect(
            receipt.runtime,
            `${verb}'s receipt must name the adapter that produced it: the receipt travels ` +
              'across runtimes (ADR-0310), and the copy that says "{Runtime} didn’t confirm ' +
              'it" reads this field'
          ).toBe(runtime.type);
          assertReasonPresence(verb, receipt);
        }
      });

      it('I5: a stop aimed at a session this runtime never saw resolves, never rejects', async () => {
        const runtime = makeRuntime();

        // Never `ensureSession`d: the adapter has no state for this id at all,
        // which is the cheapest way to reach whatever internal lookup its stop
        // path starts with. Adapters MUST NOT throw for an ordinary refusal —
        // `failed` is the receipt for that (ADR 260816-143752's rule for
        // `deliverIntoTurn`, applied to the stop verbs) — and a rejection here
        // would escape the interrupt route into a 500 that loses the queue it
        // had already cleared.
        await expect(
          runtime.interruptQuery('00000000-0000-4000-8000-00000000dead'),
          'interruptQuery must resolve a receipt for an unknown session, not reject'
        ).resolves.toBeDefined();
        await expect(
          runtime.stopTask('00000000-0000-4000-8000-00000000dead', 'no-such-task'),
          'stopTask must resolve a receipt for an unknown session, not reject'
        ).resolves.toBeDefined();
      });

      it('C11: interruptQuery against a backend that never answers still resolves within a bound', async () => {
        const runtime = makeRuntime();
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));

        if (!hangingInterrupt) {
          // No driver: this runtime's interrupt path has no backend round
          // trip to wait on — codex's is a synchronous `controller.abort()`,
          // test-mode's never leaves the process — so nothing here can be
          // made to hang. Prove that deterministically rather than against a
          // wall-clock budget (flaky under load, and a fixed millisecond
          // figure is a number to argue with): arm fake timers and never
          // advance them, so any path that needs even one real timer tick —
          // a `setTimeout`-based bound included — can never settle no matter
          // how long this waits. Then drain only MICROTASKS. A truly
          // synchronous interrupt settles within a handful of `await
          // Promise.resolve()` hops; a sentinel that is still NOT_SETTLED
          // after many says this runtime silently grew a real async hop and
          // is now owed a `hangingInterrupt` driver instead of this branch.
          const NOT_SETTLED = Symbol('not-settled');
          onTestFinished(() => {
            vi.useRealTimers();
          });
          vi.useFakeTimers();
          let settled: InterruptReceipt | typeof NOT_SETTLED = NOT_SETTLED;
          void runtime.interruptQuery(sessionId).then((result) => {
            settled = result;
          });
          for (let i = 0; i < 50 && settled === NOT_SETTLED; i++) {
            await Promise.resolve();
          }
          expect(
            settled,
            'no hangingInterrupt driver was wired for this runtime, which claims its interrupt ' +
              'has nothing to await — with fake timers armed and never advanced, only a real ' +
              'microtask hop could settle this, and none did (see ' +
              'RuntimeConformanceOpts.hangingInterrupt)'
          ).not.toBe(NOT_SETTLED);
          expect(InterruptReceiptSchema.safeParse(settled).success).toBe(true);
          return;
        }

        // Staged BEFORE fake timers arm: a driver's own setup can lean on real
        // macrotask delays (a persistent double's simulated IPC round trip,
        // `vi.waitFor`'s polling) that fake time would freeze right along
        // with the wall clock this case exists to race — hanging the SETUP
        // instead of the property under test, and (worse) leaving fake timers
        // armed for every test after this one once the suite's own timeout
        // abandons a stuck `it` without ever reaching a `finally`.
        const expectedSettle = await hangingInterrupt(runtime, sessionId);

        // A `finally` is not enough here: when the mutant under test (the
        // bound removed) makes this hang, vitest's own test-timeout abandons
        // the `it` WITHOUT ever resuming this async function — so a `finally`
        // below the await never runs, and fake timers stay armed for every
        // test after this one in the same file (measured: 4 collateral reds).
        // `onTestFinished` is vitest's own teardown hook, invoked on the
        // abandonment path too, so it is what actually restores the clock.
        onTestFinished(() => {
          vi.useRealTimers();
        });
        vi.useFakeTimers();
        const result = runtime.interruptQuery(sessionId);
        // A ceiling every runtime's OWN ack bound must clear, not any one
        // runtime's specific number — each justifies its own near where it
        // lives (`bounded-stop.ts` for claude-code, `runtime-constants.ts`
        // for opencode).
        await vi.advanceTimersByTimeAsync(10_000);
        await expect(
          result,
          'a bounded interrupt must settle once the suite has advanced well past any ' +
            'reasonable ack timeout — an unbounded one hangs here until the TEST ITSELF ' +
            'times out, which is the mutant this case exists to catch. It must also settle to ' +
            'EXACTLY the receipt the driver declared, not merely some receipt — the whole ' +
            'point of the vocabulary is that a runtime which escalated to a close (`closed`) ' +
            'and one which could not confirm anything (`unconfirmed`) are different endings, ' +
            'and a runtime that silently swapped them is what this pin catches.'
        ).resolves.toEqual(expectedSettle);
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

      it('a question NOBODY answered says so in history, and claims no answer (DOR-1293)', async ({
        skip,
      }) => {
        const runtime = makeRuntime();
        if (!runtime.getCapabilities().supportsQuestionPrompt) {
          skip('runtime declares no question prompt');
          return;
        }
        if (!expiredQuestionHistory) {
          skip('no expiredQuestionHistory driver wired — see the option’s TSDoc');
          return;
        }
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));

        const history = await expiredQuestionHistory(runtime, sessionId, messageContent);
        const asked = history
          .flatMap((m) => m.toolCalls ?? [])
          .filter((tc) => tc.questions !== undefined);

        expect(
          asked.length,
          'a question the person was asked must survive into history — otherwise there is nowhere to say how it ended'
        ).toBeGreaterThan(0);
        for (const question of asked) {
          // The whole of DOR-1293: "no answers" is what an unanswered question
          // and an answered one somebody ELSE submitted look equally like, so
          // history has to state the difference rather than leave the renderer
          // to guess — which it did, in favour of a green "Question answered".
          expect(question.questionOutcome).toBe('expired');
          expect(question.answers).toBeUndefined();
          // And never as a PERMISSION receipt. All three interaction kinds share
          // a cancellation path, so a timed-out question resolves `expired`
          // exactly as a timed-out approval does — reading the kind back out of
          // the outcome is what printed "Expired — denied" over questions
          // nobody was ever asked to approve.
          expect(question.approvalOutcome).toBeUndefined();
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
          RuntimeCapabilities['permissionModes'] | undefined;
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

    describe('dispositions (C1, C2, C3, C6, C7, C9)', () => {
      const declaresSteer = (runtime: AgentRuntime): boolean =>
        runtime.getCapabilities().supportsSteer === true;
      const declaresStage = (runtime: AgentRuntime): boolean =>
        runtime.getCapabilities().supportsContextStaging === true;
      const declaresDisposition = (runtime: AgentRuntime): boolean =>
        declaresSteer(runtime) || declaresStage(runtime);
      const declares = (runtime: AgentRuntime, mode: (typeof DELIVER_MODES)[number]): boolean =>
        mode === 'steer' ? declaresSteer(runtime) : declaresStage(runtime);

      it('C6: declares the three disposition flags as real booleans', () => {
        // Compile-time forced already; asserted here so a cast that slips a
        // non-boolean past the compiler onto the flag the ladder ROUTES on cannot
        // dodge conformance.
        const capabilities = makeRuntime().getCapabilities();
        for (const flag of DISPOSITION_CAPABILITY_FLAGS) {
          expect(typeof capabilities[flag], `capabilities.${flag} must be a boolean`).toBe(
            'boolean'
          );
        }
      });

      it('C7: canSteerSession tracks the mechanism a steer needs, and never outruns supportsSteer', async (ctx) => {
        // The per-SESSION half of steering (DOR-1268). Optional: a runtime whose
        // steering is uniform omits it and its static flag stands for every
        // session. One that implements it is held to the claims below, because
        // the composer offers a cut-in on the strength of this answer.
        const runtime = makeRuntime();
        const canSteerSession = runtime.canSteerSession?.bind(runtime);
        if (canSteerSession === undefined) {
          // Reported as a SKIP, not as a pass: an `it` that returns early looks
          // identical to one that asserted something, and a green tick over zero
          // assertions is the shape this whole suite exists to refuse.
          ctx.skip(
            'this runtime does not implement `canSteerSession`, so its static `supportsSteer` is ' +
              'the answer for every one of its sessions (see AgentRuntime.canSteerSession)'
          );
          return;
        }

        // (1) A session it has never heard of is ANSWERABLE, not a throw. The
        // client asks about whatever session is on screen, including one this
        // process has never dispatched for, and a lookup that dereferenced a
        // missing entry would take the composer down with it.
        const strangerId = nextSessionId();
        expect(
          () => canSteerSession(strangerId),
          'canSteerSession must answer for a session it has never heard of, not throw'
        ).not.toThrow();
        const stranger = canSteerSession(strangerId);
        expect(typeof stranger, 'canSteerSession must answer a boolean').toBe('boolean');

        // (2) It NARROWS the static flag, never widens it. A runtime that cannot
        // steer at all has no steerable session, and claiming one would put a
        // Steer in front of a person that the ladder is bound to degrade.
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));
        if (!declaresSteer(runtime)) {
          expect(
            stranger || canSteerSession(sessionId),
            'a runtime declaring supportsSteer: false must report no session as steerable'
          ).toBe(false);
          return;
        }

        // (3) The answer FOLLOWS THE MECHANISM rather than the adapter — which is
        // the entire reason the method exists, and the only claim that a constant
        // cannot satisfy. Checkable exactly where the suite can move a session
        // between the two states: a runtime holding a process between turns, with
        // a `warmSession` driver to reach the warm one.
        if (!warmSession) {
          expect(
            runtime.getCapabilities().supportsPersistentSession,
            'a runtime that implements canSteerSession without holding a process between turns ' +
              'has no state for the answer to follow — say what varies, or drop the method and ' +
              'let supportsSteer stand'
          ).toBe(false);
          return;
        }

        const cold = canSteerSession(sessionId);
        await warmSession(runtime, sessionId);
        const warm = canSteerSession(sessionId);

        // A session HOLDING the process a steer pushes into is steerable. A
        // constant `false` fails here.
        expect(
          warm,
          'a session holding this runtime`s process must report steerable — a steer has somewhere to go'
        ).toBe(true);
        // And one that holds no process yet has nothing to cut into. A constant
        // `true` fails here, which is exactly the defect DOR-1268 shipped: the
        // composer offered a cut-in on a session that could not take one.
        expect(
          cold,
          'a session holding no process cannot report steerable — there is nothing to push into, ' +
            'and saying otherwise is the promise DOR-1268 was filed for'
        ).toBe(false);
      });

      it('C9: canStageSession tracks the seam a stage needs, and never outruns supportsContextStaging', async (ctx) => {
        // The per-SESSION half of staging (DOR-1307), and the exact counterpart
        // of C7 (C8 was already spoken for by `settleOpenTurn`). Optional on the
        // same terms as C7: a runtime whose staging is uniform
        // omits it and its static flag stands for every session. One that
        // implements it is held to the claims below, because the server routes a
        // stage to the NATIVE path on the strength of this answer — and for
        // claude-code the native path is what starts a process.
        const runtime = makeRuntime();
        const canStageSession = runtime.canStageSession?.bind(runtime);
        if (canStageSession === undefined) {
          // A SKIP, not a pass, for C7's reason: an `it` that returns early is
          // indistinguishable from one that asserted something.
          ctx.skip(
            'this runtime does not implement `canStageSession`, so its static `supportsContextStaging` ' +
              'is the answer for every one of its sessions (see AgentRuntime.canStageSession)'
          );
          return;
        }

        // (1) ANSWERABLE for a session it has never heard of, never a throw —
        // the ladder asks about whatever session the message arrived for.
        const strangerId = nextSessionId();
        expect(
          () => canStageSession(strangerId),
          'canStageSession must answer for a session it has never heard of, not throw'
        ).not.toThrow();
        const stranger = canStageSession(strangerId);
        expect(typeof stranger, 'canStageSession must answer a boolean').toBe('boolean');

        // (2) It NARROWS the static flag, never widens it. A runtime that cannot
        // stage at all has no stageable session, and claiming one would send the
        // ladder down a native path that does not exist.
        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));
        if (!declaresStage(runtime)) {
          expect(
            stranger || canStageSession(sessionId),
            'a runtime declaring supportsContextStaging: false must report no session as stageable'
          ).toBe(false);
          return;
        }

        // (3) The answer FOLLOWS THE MECHANISM rather than the adapter, which is
        // the whole reason the method exists and the one claim a constant cannot
        // satisfy.
        if (!warmSession) {
          expect(
            runtime.getCapabilities().supportsPersistentSession,
            'a runtime that implements canStageSession without holding a process between turns ' +
              'has no state for the answer to follow — say what varies, or drop the method and ' +
              'let supportsContextStaging stand'
          ).toBe(false);
          return;
        }

        const cold = canStageSession(sessionId);
        await warmSession(runtime, sessionId);
        const warm = canStageSession(sessionId);

        // A session HOLDING the process a stage appends to is stageable. A
        // constant `false` fails here.
        expect(
          warm,
          'a session holding this runtime`s process must report stageable — a stage has a transcript to reach'
        ).toBe(true);
        // And one holding no process has no transcript to append to. A constant
        // `true` fails here, which is exactly the defect DOR-1307 shipped: the
        // server took the native path, and the adapter's only way to honour it
        // was to boot an agent the operator never opted into.
        expect(
          cold,
          'a session holding no process cannot report stageable — there is nothing to append to, ' +
            'and saying otherwise is what made Add context start a process (DOR-1307)'
        ).toBe(false);
      });

      it('C1: a disposition it does not declare is absent or refused as unsupported, never thrown', async () => {
        // The not-declared arm, proven at rest — no open turn needed. Either the
        // method is not there at all (honest ONLY when the runtime declares
        // neither mode), or it degrades a mode it does not support as
        // `unsupported` without ever throwing.
        const runtime = makeRuntime();

        if (runtime.deliverIntoTurn === undefined) {
          expect(
            !declaresSteer(runtime) && !declaresStage(runtime),
            'a runtime that omits deliverIntoTurn must declare neither steer nor stage — the ladder ' +
              'calls it for a declared disposition, so a missing method behind a declared one strands it'
          ).toBe(true);
          return;
        }

        const sessionId = nextSessionId();
        runtime.ensureSession(sessionId, sessionOpts(runtime));
        for (const mode of DELIVER_MODES) {
          if (declares(runtime, mode)) continue;
          const receipt = await runtime.deliverIntoTurn(sessionId, messageContent, {
            mode,
            messageId: randomUUID(),
          });
          expect(receipt.delivered, `an undeclared ${mode} must not report delivered`).toBe(false);
          expect(receipt.reason, `an undeclared ${mode} must degrade as unsupported`).toBe(
            'unsupported'
          );
        }
      });

      it('C1: a runtime declaring a disposition wires a dispositionTurn driver', () => {
        // Keyed on the CAPABILITY, mirroring the warmSession stance: declaring a
        // disposition is what creates the obligation to prove it into an open
        // turn, and a runtime that declared one and simply forgot the driver would
        // otherwise skip in silence about the very thing it claims.
        const runtime = makeRuntime();
        if (!declaresDisposition(runtime)) {
          expect(
            dispositionTurn,
            'a dispositionTurn driver was wired by a runtime that declares neither steer nor stage'
          ).toBeUndefined();
          return;
        }
        expect(
          dispositionTurn,
          'this runtime declares steer or stage but wired no dispositionTurn driver, so C1 would ' +
            'assert nothing about the open-turn delivery it claims (see RuntimeConformanceOpts.dispositionTurn)'
        ).toBeDefined();
      });

      if (dispositionTurn) {
        it('C1: a declared disposition reaches the model inside the open turn, minting no new turn_start', async () => {
          const runtime = makeRuntime();
          const sessionId = nextSessionId();
          runtime.ensureSession(sessionId, sessionOpts(runtime));
          expect(
            runtime.deliverIntoTurn,
            'a runtime that reaches this case declares a disposition, so it must implement deliverIntoTurn'
          ).toBeDefined();

          let midRan = false;
          await dispositionTurn(runtime, sessionId, messageContent, {
            midTurn: async () => {
              midRan = true;
              // The driver was supposed to leave a turn genuinely open; a steer
              // delivered onto an idle session would prove nothing.
              const open = await runtime.getSessionSnapshot(sessionOpts(runtime), sessionId);
              expect(
                open.status.lifecycle,
                'the dispositionTurn driver did not leave a turn open to deliver into'
              ).toBe('streaming');
              // Capture the OPEN turn's IDENTITY — its `turn_start`'s seq. "No new
              // turn_start" is the whole property C1 names, and this seq is the one
              // fact that pins it: a steer that JOINS this turn leaves the same
              // turn_start in place, while a steer implemented as
              // close-this-turn-then-open-another mints a new turn_start with a new
              // seq. Read before the steer so the after-reading has a concrete
              // identity to be equal to.
              const openTurn = open.inProgressTurn;
              expect(
                openTurn,
                'the dispositionTurn driver must leave one open turn to steer into'
              ).not.toBeNull();
              const openTurnStarts = openTurn!.filter((event) => event.type === 'turn_start');
              expect(
                openTurnStarts,
                'an open turn window carries exactly one turn_start'
              ).toHaveLength(1);
              const turnIdentity = openTurnStarts[0]!.seq;

              // Called on `runtime`, never a detached reference: an adapter's
              // deliverIntoTurn may read `this` (claude-code reaches its
              // persistent dispatcher through it), so pulling the method off the
              // object would strip the binding and throw before it decided
              // anything.
              if (declaresSteer(runtime)) {
                const receipt = await runtime.deliverIntoTurn!(
                  sessionId,
                  'steer into the running turn',
                  {
                    mode: 'steer',
                    messageId: randomUUID(),
                  }
                );
                expect(
                  receipt.delivered,
                  'a runtime that declares steer must deliver a steer into an open turn — declaring ' +
                    'a capability it cannot honor is the exact lie C1 exists to catch'
                ).toBe(true);
                // The property, checked DIRECTLY rather than by proxy: the window
                // still carries exactly ONE turn_start, and it is the SAME one — same
                // seq — the steer joined. Lifecycle alone cannot tell "joined the
                // turn" from "closed it and opened a new one", because a reopened turn
                // is streaming and non-null too; the seq can, and does.
                const after = await runtime.getSessionSnapshot(sessionOpts(runtime), sessionId);
                expect(
                  after.status.lifecycle,
                  'a steer must join the open turn, not replace it with a new one'
                ).toBe('streaming');
                const afterTurn = after.inProgressTurn;
                expect(
                  afterTurn,
                  'the steered turn must still be the one open turn'
                ).not.toBeNull();
                const afterTurnStarts = afterTurn!.filter((event) => event.type === 'turn_start');
                expect(
                  afterTurnStarts,
                  'a steer must open no new turn — the window still carries exactly one turn_start'
                ).toHaveLength(1);
                expect(
                  afterTurnStarts[0]!.seq,
                  'the steered turn must be the SAME turn the steer joined — a new turn_start seq ' +
                    'here is exactly the second turn C1 forbids'
                ).toBe(turnIdentity);
              }

              if (declaresStage(runtime)) {
                const receipt = await runtime.deliverIntoTurn!(
                  sessionId,
                  'stage onto the transcript',
                  {
                    mode: 'stage',
                    messageId: randomUUID(),
                  }
                );
                expect(
                  receipt.delivered,
                  'a runtime that declares context staging must deliver a stage'
                ).toBe(true);
              }
            },
          });
          expect(midRan, 'the dispositionTurn driver never called midTurn with a turn open').toBe(
            true
          );
        });
      } else {
        it.skip(
          'SKIPPED: no dispositionTurn driver — nothing proves this runtime delivers a declared ' +
            'disposition into an open turn (a runtime that DECLARES one fails the case above instead ' +
            'of reaching this skip; see RuntimeConformanceOpts.dispositionTurn)',
          () => {}
        );
      }

      if (terminalOnce) {
        it('C2: a window emits exactly one turn_end, however many native results it carried', async () => {
          const turnEnds = await terminalOnce();
          expect(
            turnEnds,
            'a turn window that carried two native results must still synthesize exactly one ' +
              'turn_end — a second would double-settle the lifecycle and re-flush the turn (task 0.1)'
          ).toBe(1);
        });
      } else {
        it.skip(
          'SKIPPED: no terminalOnce driver — nothing proves this runtime collapses a multi-result ' +
            'window to one turn_end (see RuntimeConformanceOpts.terminalOnce)',
          () => {}
        );
      }

      if (queueDurability) {
        it('C3: the queue runs a message behind a failed turn, and never into an open interaction', async () => {
          const report = await queueDurability();
          expect(
            report.ranBehindFailedTurn,
            'a message queued behind a turn that FAILED must still run — a failed turn frees the ' +
              'queue like any other rather than eating the message behind it'
          ).toBe(true);
          expect(
            report.heldWhileInteractionPending,
            'a queued message must NOT run while an interaction is open — firing a prompt into an ' +
              'open approval is read as the person’s reply'
          ).toBe(true);
          expect(
            report.ranAfterInteractionResolved,
            'a queued message must run once the interaction it waited on is resolved'
          ).toBe(true);
        });
      } else {
        it.skip(
          'SKIPPED: no queueDurability driver — nothing proves the server queue runs behind a ' +
            'failure and holds for an open interaction (see RuntimeConformanceOpts.queueDurability)',
          () => {}
        );
      }
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

    describe('systemPromptAppend delivery (project-rooms §3.3)', () => {
      it('either proves a changed append is delivered or says why it cannot be proven here', () => {
        if (systemPromptAppendTurns) {
          expect(
            (systemPromptAppendUnprovenReason ?? '').trim(),
            'this run wired `systemPromptAppendTurns`, so the property IS provable here and a reason it is not would be dead copy'
          ).toBe('');
          return;
        }
        expect(
          (systemPromptAppendUnprovenReason ?? '').trim().length,
          'this run wired no `systemPromptAppendTurns` driver and gave no reason it could not, so nothing here proves a caller’s per-run instructions reach the model at all (see RuntimeConformanceOpts.systemPromptAppendTurns)'
        ).toBeGreaterThan(0);
      });

      if (systemPromptAppendTurns) {
        it('a CHANGED append reaches the next turn of a session already running', async () => {
          // Distinct, unguessable markers rather than prose: the second turn's
          // input has to be checked for the ABSENCE of the first append too, and
          // two English sentences can share enough substrings to make that check
          // pass by accident.
          const first = `<dorkos_conformance_append_one/> the append this session started under`;
          const second = `<dorkos_conformance_append_two/> the append a later change asked for`;

          const runtime = makeRuntime();
          const sessionId = nextSessionId();
          runtime.ensureSession(sessionId, sessionOpts(runtime));

          const [firstDelivered, secondDelivered] = await systemPromptAppendTurns(
            runtime,
            sessionId,
            [first, second]
          );

          expect(
            firstDelivered,
            'the first turn’s backend input did not carry its append'
          ).toContain(first);
          expect(
            firstDelivered,
            'the first turn’s backend input carried an append that had not been asked for yet'
          ).not.toContain('<dorkos_conformance_append_two/>');
          // THE GATE. A runtime that binds its append at session start and rides
          // it afterwards fails exactly here, and it has to: a room's conventions
          // change when a merge lands, and a block that only ever reaches the
          // first turn is a block nobody will notice has gone stale.
          expect(
            secondDelivered,
            'the changed append never reached the second turn — this runtime binds it at session start, so a caller whose instructions change mid-conversation is talking to a model that cannot hear the change'
          ).toContain(second);
          expect(
            secondDelivered,
            'the second turn’s backend input still carried the append the session started under'
          ).not.toContain('<dorkos_conformance_append_one/>');
        });
      }
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
