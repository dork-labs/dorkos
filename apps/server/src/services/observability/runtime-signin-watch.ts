/**
 * Notices, at the one seam every turn passes through, that a runtime's sign-in
 * has stopped working — and that it is working again (DOR-1654, DOR-1657).
 *
 * ## The problem this exists for
 *
 * Every runtime already classifies a credential failure: its event mappers call
 * `detectAuthError` and tag the turn's typed `error` event
 * `category: 'auth_error'`. An INTERACTIVE chat then draws a "Fix sign-in" card
 * off that tag, because the turn is fed through a `SessionStateProjector` and
 * the client reads `SessionStatus.lastError`.
 *
 * Nothing else did. A scheduled run consumes `sendMessage` itself
 * (`services/tasks/run-stream.ts`), and its `onEvent` only harvests
 * `text_delta`; the relay's two handlers (`packages/relay/src/adapters/
 * claude-code/{agent,task}-handler.ts`) consume it themselves too, and read only
 * an error's `code`. None of the three attaches a projector. So the tag was
 * computed and then dropped, and a 3am task that died on an expired token
 * reached nobody until morning.
 *
 * ## Why this is a wrap on the registry, and not three patches
 *
 * The three background paths share no error-handling code — that is the finding
 * that shaped this file. Room turns DO go through `triggerTurn`; scheduled runs
 * and relay deliveries do not, and the relay's copies live in `packages/relay`,
 * which cannot import from `apps/server` at all. There is no existing seam all
 * three pass through.
 *
 * What they DO share is `runtime.sendMessage()`, and — every one of them — a
 * runtime instance that came from `runtimeRegistry`. Tasks resolve one through
 * `SchedulerRuntimes`, rooms call `runtimeRegistry.get(...)`, and the relay is
 * handed a map built from `runtimeRegistry.listRuntimes()` at boot. So the
 * registration seam is the one place that sees them all, which is exactly the
 * argument `services/observability/trace-runtime.ts` already makes for tracing —
 * this is its sibling, wrapped at the same line, and deliberately shaped the
 * same way.
 *
 * **Being registered is not by itself enough, and the relay is the proof.**
 * A caller that kept its own reference to the runtime it constructed holds the
 * RAW object, not the registry's wrapper, and turns taken through that
 * reference are invisible here. `index.ts` had exactly one: the relay's runtime
 * map appended `relayAgentRuntime` — the raw `ClaudeCodeRuntime` — after the
 * registry's own entries, and last-write-wins replaced the wrapped claude-code
 * entry with it. That flowed into `deps.agentManager` (`defaultRuntimeFor`
 * reads that map) and was re-forced over the map by `ClaudeCodeAdapter`'s
 * constructor, so every Telegram/Slack-bridged turn ran unwatched. Fixed at the
 * map (`index.ts`, `watchedRelayRuntime`) and covered by
 * `runtime-signin.test.ts`'s relay case. If another seam ever caches a runtime
 * it built rather than asking the registry, it needs the same treatment.
 *
 * ## Why it says nothing itself, and why it lives here
 *
 * It reports to a SINK rather than calling `notify()`, and that is a module-graph
 * decision, not a style one. `runtime-registry.ts` is imported by some forty
 * modules; reaching the notification pipeline from it drags the relay channel,
 * the notification store and the whole escalation stack behind every one of
 * them, and closes a real import cycle (the relay's own services read
 * `runtimeRegistry` back — measured with `madge`, and it broke three route
 * suites whose partial `ulidx` mock the new edge exposed). **Nothing in this file
 * may import the notification pipeline.** `notifications/emitters/
 * runtime-signin.ts` owns what to say and installs the sink at boot.
 *
 * It sits beside `trace-runtime.ts` because that is what it is: the second
 * observer of the runtime boundary, wrapped at the same line, and the registry
 * already imports this barrel to get the first one. Being here also keeps it
 * inside the reach of `dispatcher-single-ingress.test.ts`, which excludes
 * `services/runtimes/**` — a wrapper that calls `.sendMessage` should stay
 * something that guard can see and that its allow-list has to justify.
 *
 * ## Why it does not ask whether a turn was "background"
 *
 * Because the condition is not about the turn. An expired credential stops
 * EVERY agent on that runtime, and the turn that trips over it first is an
 * accident of timing, not the subject. So this reports one failure per RUNTIME
 * and lets the sink say one thing about it.
 *
 * A consequence worth stating plainly: an interactive chat that hits an expired
 * token now also raises a machine-wide condition, on top of the "Fix sign-in"
 * card it already drew. That is not a duplicate — the card answers "what
 * happened to this turn", and the condition answers "what is wrong with this
 * machine", which is still true after the person closes the tab.
 *
 * ## Why it watches the turns that WORK too (DOR-1657)
 *
 * Because a standing condition needs an owner. Reaching a phone happens only
 * through the escalation ladder, the ladder carries only standing kinds, and a
 * standing kind needs a store that answers "is this still waiting?" plus an edge
 * where it stops (ADR 260819-234828). For a credential, nothing owned either —
 * which is exactly why DOR-1654 shipped `signin.required` as a plain event.
 *
 * This module is that owner. {@link failingSince} IS the store: a runtime is in
 * it when its last turn died on its sign-in and no turn since has gone through.
 * And the edge is **the next turn on that runtime that reaches the provider
 * without a credential failure.** Nothing else can answer it honestly: a
 * credential is not something DorkOS can inspect, only something it can try.
 *
 * Three judgement calls in that sentence, each deliberate:
 *
 * - **"Reaches the provider"**, not "finishes". Finishing proves nothing, and
 *   claude-code is the proof: it catches a pre-stream failure and yields a typed
 *   `execution_error`, returning normally, so `spawn ENOENT` is indistinguishable
 *   from a good turn by completion alone. Recovery therefore needs positive
 *   evidence the model answered — see {@link PROVIDER_CONTACT_EVENTS}.
 * - **"Without a credential failure"** rather than "successfully". A turn that
 *   answered and then failed on a tool, a rate limit or a 500 still got past the
 *   sign-in, which is the only question here. Being stricter would leave
 *   conditions standing forever; being wrong this way costs one extra episode,
 *   because a sign-in that is still dead re-stands on the very next turn.
 * - **A turn that was ALREADY RUNNING when the failure was noticed does not
 *   count.** It authenticated before the credential died, so its success is
 *   evidence about a moment that has already passed — and clearing on it would
 *   take the notice down while the sign-in is still broken.
 *
 * @module services/observability/runtime-signin-watch
 */
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import { detectAuthError } from '@dorkos/shared/runtime-error-classification';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../lib/logger.js';

/** One edge of one runtime's sign-in condition. */
export interface RuntimeSigninEvent {
  /** The runtime type, e.g. `claude-code`. */
  runtime: string;
  /** Whether the sign-in just stopped working, or just started working again. */
  edge: 'failing' | 'recovered';
  /**
   * When THIS episode began. ISO 8601 UTC.
   *
   * **The episode's identity, not decoration.** A credential can die, be fixed,
   * and die again, and those are two different things to be told about. Both
   * edges of one episode carry the same string, so the condition is announced,
   * escalated and retired under one key — and two episodes are never mistaken
   * for one, which is what would let the escalation ledger swallow the second
   * ping forever (the shape DOR-1387 hit on `session.error`).
   */
  since: string;
}

/** Told when a runtime's sign-in stops working, and when it works again. */
export type RuntimeSigninSink = (event: RuntimeSigninEvent) => void;

/** What to tell, once boot has wired something that can say it. */
let sink: RuntimeSigninSink | null = null;

/**
 * When each currently-failing runtime's episode began, by runtime type. Epoch ms.
 *
 * **This is the store that makes `signin.required` a standing condition**
 * (DOR-1657): a runtime is in here exactly while its last turn died on its
 * sign-in and no turn since has gone through. A standing kind is required to
 * have one (ADR 260819-234828), and for a credential nothing else could be it —
 * a token is not something DorkOS can inspect, only something it can try.
 *
 * It is also, unchanged from DOR-1654, the synchronous race guard: `notify()` is
 * async, so twenty task runs failing at 3.00.00 on one dead credential could all
 * read "nothing said yet" before any of them had said anything. A synchronous
 * in-memory claim closes that the moment the first one arrives.
 *
 * **Process-local, and that costs something worth naming.** Losing it on restart
 * means a runtime that is still broken re-stands on its next failing turn under
 * a NEW episode key — so a second inbox row and a second phone ping about one
 * unbroken stretch of breakage. That is *not* the same bound the escalation
 * ladder documents for its own in-memory timers: the ladder is saved by the
 * ledger, which recognises a subject it has already escalated, and a new episode
 * key is by construction a subject it has never seen. The row written at the
 * raise edge is what keeps a restart from erasing the RECORD; nothing keeps it
 * from repeating the alarm.
 *
 * Boot deliberately does not re-arm from the unresolved rows in the store, even
 * though it could find them. An unresolved row means "nobody has seen a working
 * turn on this runtime since", which is not the same as "the credential is still
 * dead" — the operator may have fixed it while the server was down. Pushing on
 * that guess is a false alarm, and a false alarm is worse than a late one here:
 * the next failing turn re-stands the condition within one turn anyway.
 *
 * It does the other half, though: boot CLOSES those rows rather than leaving
 * them (`emitters/runtime-signin.ts`). Not re-arming is only half an answer
 * while a surface reads history as the present tense — the web app's standing
 * banner does exactly that — so a row this process can never resolve would
 * otherwise claim a dead sign-in forever.
 *
 * **Keyed by runtime TYPE, which is wrong for multi-account claude-code.** A
 * credential belongs to an account root (`CLAUDE_CONFIG_DIR`), and DorkOS
 * supports several; a clean turn on one account therefore clears a condition
 * raised by another, reading as an all-clear that has not happened. It is not
 * fixable from here: the account is a private field of `ClaudeCodeRuntime`'s
 * session store, resolved asynchronously far deeper than this seam, and reaching
 * it needs a new method on the shared `AgentRuntime` interface plus an
 * implementation in all three runtimes. Scoped to claude-code — codex and
 * opencode each have exactly one home directory. The failure mode is a premature
 * all-clear, corrected by the next failing turn on the affected account, rather
 * than permanent silence (DOR-1657 follow-up).
 */
const failingSince = new Map<string, number>();

/**
 * Install what to do when a runtime's sign-in changes state. Called once by the
 * composition root.
 *
 * @param next - The sink, or `null` to tear it down.
 */
export function setRuntimeSigninSink(next: RuntimeSigninSink | null): void {
  sink = next;
}

/**
 * Report that a runtime's sign-in is dead, once per episode.
 *
 * Claims the episode BEFORE telling anybody, because the race it closes is
 * concurrent turns arriving before anything has been said. Nothing is claimed
 * when there is no sink to tell: a runtime latched with nobody listening would
 * stand silently forever, and every later failure would find it already standing.
 *
 * @param runtimeType - The runtime whose credential failed.
 */
function noteSigninFailure(runtimeType: string): void {
  if (!sink) return;
  if (failingSince.has(runtimeType)) return;

  const since = Date.now();
  failingSince.set(runtimeType, since);
  logger.info('[Runtimes] A turn failed on its sign-in', { runtime: runtimeType });

  // The claim is optimistic — it has to be made before anybody is told, or
  // concurrent turns all report the same thing. So a sink that could not do its
  // job gives the claim back: the episode is now released by a RESOLUTION rather
  // than by a clock, and a runtime latched on an announcement that never
  // happened would sit silent until somebody restarted the server.
  if (!report({ runtime: runtimeType, edge: 'failing', since: new Date(since).toISOString() })) {
    failingSince.delete(runtimeType);
  }
}

/**
 * Report that a runtime whose sign-in had failed is working again — the
 * resolution edge of the standing condition (DOR-1657).
 *
 * @param runtimeType - The runtime whose turn went through.
 * @param turnStartedAt - When that turn began. Epoch ms. A turn that was already
 *   running when the failure was noticed authenticated before the credential
 *   died, so it says nothing about the state the condition describes.
 */
function noteSigninRecovery(runtimeType: string, turnStartedAt: number): void {
  const since = failingSince.get(runtimeType);
  if (since === undefined) return;
  // `>=`, not `>`: a turn that started in the very millisecond the failure was
  // recorded cannot be shown to have authenticated after it, and the tie has to
  // fall on the side that leaves the condition standing. A wrong all-clear
  // silences a live problem; a wrong hold is corrected by the next turn.
  if (since >= turnStartedAt) return;

  failingSince.delete(runtimeType);
  logger.info('[Runtimes] A turn went through on a sign-in that had failed', {
    runtime: runtimeType,
  });
  report({ runtime: runtimeType, edge: 'recovered', since: new Date(since).toISOString() });
}

/**
 * Tell the sink, never letting it cost the turn that produced the news.
 *
 * @returns Whether the sink took it. `false` means nobody was told.
 */
function report(event: RuntimeSigninEvent): boolean {
  try {
    sink?.(event);
    return true;
  } catch (err) {
    logger.warn('[Runtimes] Could not report a sign-in change', { err, runtime: event.runtime });
    return false;
  }
}

/**
 * The events that prove a turn actually reached the provider and was let in.
 *
 * **An allowlist, and fail-closed on purpose.** The obvious test — "the turn ran
 * to the end without an auth error" — is WRONG, and claude-code is the proof:
 * it catches a pre-stream failure and YIELDS a typed `execution_error`, then
 * returns normally (`runtimes/claude-code/messaging/message-sender.ts`). A
 * `spawn ENOENT`, a missing binary, a dead sidecar — every one of them looks
 * bit-for-bit like a completed turn from out here, and none of them says a word
 * about the credential. Resolving on one takes the banner down and cancels the
 * phone ping while the sign-in is still dead.
 *
 * So the question is not "did it finish?" but "did the model answer?". Each
 * member here is something only the provider can produce: words, thinking, a
 * tool call it decided to make, or a prompt it raised mid-turn. Every one of
 * them is emitted by all three runtimes (claude-code, codex, opencode).
 *
 * Deliberately EXCLUDED, having been checked rather than assumed:
 * - `done` and `session_status` — terminal markers that ride the failure path
 *   too. Codex emits `error` then `done`, and keeps `done` even when it
 *   suppresses a duplicate error (`runtimes/codex/event-mapper.ts`).
 * - `error` of any category — the case this whole allowlist exists for.
 * - Everything DorkOS generates locally without asking a provider: hook events,
 *   `memory_recall`, `context_usage`, `system_status`, `operation_progress`.
 *
 * A new event type that belongs here will not be in the set until somebody adds
 * it, and that is the safe direction to be wrong in: the condition stays
 * standing, which is self-correcting the moment any real content arrives. The
 * opposite mistake is a silent all-clear on a sign-in that is still broken.
 *
 * The nearest sibling is `runtimes/claude-code/messaging/empty-stream-guard.ts`'s
 * `CONTENT_EVENT_TYPES`, which asks a related but different question — "did this
 * turn produce anything for the person who asked?". Not imported from there:
 * that one is claude-code's own, and this observer is deliberately runtime-
 * agnostic.
 */
const PROVIDER_CONTACT_EVENTS = new Set<string>([
  'text_delta',
  'subagent_text_delta',
  'thinking_delta',
  'tool_call_start',
  'tool_call_delta',
  'tool_call_end',
  'tool_result',
  'compact_boundary',
  // The model answered by asking something back. It still answered.
  'approval_required',
  'question_prompt',
]);

/** Whether a stream event is a runtime saying its credential is no good. */
function isAuthErrorEvent(event: StreamEvent): boolean {
  if (event.type !== 'error') return false;
  const data = event.data as { category?: string } | undefined;
  return data?.category === 'auth_error';
}

/**
 * Watch one turn for a credential failure, and for the absence of one. Every
 * event passes through untouched.
 *
 * Both failure shapes are covered, because runtimes produce both: a typed
 * `error` event the adapter already tagged, and a raw throw that never reached a
 * mapper. The throw is re-classified here rather than assumed —
 * `detectAuthError` is the same conservative test every mapper uses — and is
 * always re-thrown, so this can never change what a caller sees.
 *
 * Recovery needs BOTH halves and neither is sufficient alone. The turn has to
 * reach its end without a credential failure — the `catch` and an abandoning
 * caller both skip the line below, so that half is structural — AND it has to
 * have produced something only the provider could have produced. See
 * {@link PROVIDER_CONTACT_EVENTS} for why finishing on its own proves nothing.
 */
async function* watchTurn(
  runtimeType: string,
  source: AsyncGenerator<StreamEvent>
): AsyncGenerator<StreamEvent> {
  const startedAt = Date.now();
  let sawAuthError = false;
  let reachedProvider = false;
  try {
    for await (const event of source) {
      if (isAuthErrorEvent(event)) {
        sawAuthError = true;
        noteSigninFailure(runtimeType);
      } else if (PROVIDER_CONTACT_EVENTS.has(event.type)) {
        reachedProvider = true;
      }
      yield event;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (detectAuthError({ message })) noteSigninFailure(runtimeType);
    throw err;
  }
  if (!sawAuthError && reachedProvider) noteSigninRecovery(runtimeType, startedAt);
}

/**
 * Wrap a runtime so a dead sign-in is noticed whoever started the turn.
 *
 * Always on, unlike its tracing sibling: a turn nobody is watching is precisely
 * the case this exists for, so there is no configuration under which it should
 * be the one thing not running. A thin Proxy intercepts only `sendMessage` and
 * passes every other member straight through, bound to the real runtime so
 * private state stays intact.
 *
 * @param runtime - The runtime to watch.
 * @returns A watching proxy over it.
 */
export function watchRuntimeSignin(runtime: AgentRuntime): AgentRuntime {
  return new Proxy(runtime, {
    get(target, prop) {
      if (prop === 'sendMessage') {
        return (
          sessionId: string,
          content: string,
          opts?: MessageOpts
        ): AsyncGenerator<StreamEvent> =>
          watchTurn(target.type, target.sendMessage(sessionId, content, opts));
      }
      // Receiver is the real target (not the proxy) so getters/methods that
      // touch private fields resolve against the instance that owns them.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Whether this process is currently holding an episode open for a runtime.
 *
 * The one read of {@link failingSince} from outside, and it exists for boot:
 * `emitters/runtime-signin.ts` closes the raise rows a restart orphaned, and it
 * must not close one for a runtime that has ALREADY failed again since this
 * process started — that row is about now, not about the last process.
 *
 * @param runtimeType - The runtime to ask about.
 */
export function isSigninFailing(runtimeType: string): boolean {
  return failingSince.has(runtimeType);
}

/**
 * Forget every sign-in episode this process is holding open.
 *
 * @internal Exported for testing only.
 */
export function resetSigninEpisodes(): void {
  failingSince.clear();
}
