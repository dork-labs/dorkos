/**
 * Notices, at the one seam every turn passes through, that a runtime's sign-in
 * has stopped working (DOR-1654).
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
 * token now also produces an inbox row, on top of the "Fix sign-in" card it
 * already drew. That is not a duplicate — the card answers "what happened to
 * this turn", and the row answers "what is wrong with this machine", which is
 * still true after the person closes the tab. `turn.completed` makes the same
 * call for the same reason (see its entry in `notification-registry.ts`).
 *
 * @module services/observability/runtime-signin-watch
 */
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import { detectAuthError } from '@dorkos/shared/runtime-error-classification';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../lib/logger.js';

/** Told that one runtime's sign-in is dead, at most once per window. */
export type SigninFailureSink = (runtimeType: string) => void;

/**
 * How long one runtime stays latched after it has been reported.
 *
 * **This is a race guard, not the policy.** How often DorkOS is willing to say
 * this is declared once, on the `signin.required` entry in
 * `notification-registry.ts`, where every other kind's loudness is declared too.
 * This window exists only because that one is enforced against a store and
 * cannot be consulted synchronously — see {@link reportedAt}.
 *
 * Set to the same hour so neither silently becomes the effective answer: longer
 * here would override the declared policy, shorter would make this pointless.
 * `runtime-signin.test.ts` pins the two equal so they cannot drift apart in a
 * later edit that only touches one of them.
 */
export const SIGNIN_LATCH_WINDOW_MS = 60 * 60 * 1000;

/** What to tell, once boot has wired something that can say it. */
let sink: SigninFailureSink | null = null;

/**
 * When each runtime was last reported, by runtime type.
 *
 * **Process-local and deliberately so.** Its whole job is the window a stored
 * dedupe cannot cover: `notify()` is async and asks the store "have I said
 * this?" before it inserts, so twenty task runs failing at 3.00.00 on one dead
 * credential can all read "no" before any of them has written a row. A
 * synchronous in-memory check closes that race the moment the first one arrives.
 * It is bounded by the number of registered runtimes (three), needs no cleanup,
 * and losing it on restart is correct rather than a gap: the notification
 * registry's own hour-long window survives the restart and is what stops a
 * second row.
 */
const reportedAt = new Map<string, number>();

/**
 * Install what to do when a runtime's sign-in fails. Called once by the
 * composition root.
 *
 * @param next - The sink, or `null` to tear it down.
 */
export function setSigninFailureSink(next: SigninFailureSink | null): void {
  sink = next;
}

/**
 * Give up the latch on a runtime, so the next failing turn reports it again.
 *
 * **The latch has to be claimed BEFORE the sink runs** — that is the whole
 * point of it, since the race it closes is twenty concurrent turns arriving
 * before any row exists. The cost is that a claim is optimistic: if the sink
 * then fails to record anything, the runtime would sit silent for an hour on
 * the strength of a notification that never happened. A sink that knows nothing
 * was recorded calls this, and the next turn tries again.
 *
 * @param runtimeType - The runtime to un-latch.
 */
export function releaseSigninLatch(runtimeType: string): void {
  reportedAt.delete(runtimeType);
}

/**
 * Report that a runtime's sign-in is dead, at most once per runtime per window.
 *
 * @param runtimeType - The runtime whose credential failed.
 */
function noteSigninFailure(runtimeType: string): void {
  const now = Date.now();
  const last = reportedAt.get(runtimeType);
  if (last !== undefined && now - last < SIGNIN_LATCH_WINDOW_MS) return;
  reportedAt.set(runtimeType, now);

  logger.info('[Runtimes] A turn failed on its sign-in', { runtime: runtimeType });
  // Never lets a notification failure cost the turn that produced it.
  try {
    sink?.(runtimeType);
  } catch (err) {
    logger.warn('[Runtimes] Could not report a dead sign-in', { err, runtime: runtimeType });
  }
}

/** Whether a stream event is a runtime saying its credential is no good. */
function isAuthErrorEvent(event: StreamEvent): boolean {
  if (event.type !== 'error') return false;
  const data = event.data as { category?: string } | undefined;
  return data?.category === 'auth_error';
}

/**
 * Watch one turn for a credential failure. Every event passes through untouched.
 *
 * Both shapes are covered, because runtimes produce both: a typed `error` event
 * the adapter already tagged, and a raw throw that never reached a mapper. The
 * throw is re-classified here rather than assumed — `detectAuthError` is the
 * same conservative test every mapper uses — and is always re-thrown, so this
 * can never change what a caller sees.
 */
async function* watchTurn(
  runtimeType: string,
  source: AsyncGenerator<StreamEvent>
): AsyncGenerator<StreamEvent> {
  try {
    for await (const event of source) {
      if (isAuthErrorEvent(event)) noteSigninFailure(runtimeType);
      yield event;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (detectAuthError({ message })) noteSigninFailure(runtimeType);
    throw err;
  }
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
 * Forget every runtime this process has already reported.
 *
 * @internal Exported for testing only.
 */
export function resetSigninLatch(): void {
  reportedAt.clear();
}
