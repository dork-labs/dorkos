/**
 * Observe every runtime turn for sign-in failures and recovery.
 * Episodes belong to individual accounts. Only proof from that same account
 * clears one; each episode keeps its own timestamp for notification dedupe.
 *
 * A single failure is held for {@link SIGNIN_RECHECK_WINDOW_MS} before anybody
 * is told (DOR-4424): one re-check runs, and a repair inside the window drops
 * the notice unsaid. A second failure on the same account says it at once.
 * @module services/observability/runtime-signin-watch
 */
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import { detectAuthError } from '@dorkos/shared/runtime-error-classification';
import type { StreamEvent } from '@dorkos/shared/types';
import { logger } from '../../lib/logger.js';
import { canonicalAccountPath } from '../core/usage/runtime-accounts.js';
import {
  accountSignedOutAt,
  accountSigninState,
  recordAccountSignin,
  resetAccountSignins,
} from './account-signin-state.js';

/** One edge of one runtime's sign-in condition. */
export interface RuntimeSigninEvent {
  /** The runtime type, e.g. `claude-code`. */
  runtime: string;
  /** The exact account root, absent only when the runtime cannot name one. */
  accountRoot?: string;
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

/** One turn that chose DorkOS credits and could not have them. */
export interface CreditsRefusedEvent {
  /** The runtime type, e.g. `claude-code`. */
  runtime: string;
  /** The session whose turn was refused. */
  sessionId: string;
  /** The refusal's own sentence. */
  message: string;
}

/** Told about every turn refused because DorkOS credits could not pay for it. */
export type CreditsRefusedSink = (event: CreditsRefusedEvent) => void;

/**
 * The second thing this seam watches for (ADR 261001-000811): a turn on DorkOS
 * credits refused before it reached anything, so nothing was sent and nothing
 * paid. Its own sink, because it is not a sign-in failure and must never open
 * or close a sign-in episode; it rides this wrap only because this is the one
 * place a scheduled task's, a room's and a relay delivery's turns all pass.
 */
let creditsRefusedSink: CreditsRefusedSink | null = null;

/**
 * Install (or tear down) what hears about refused credits turns.
 *
 * @param next - The sink, or `null` to tear it down.
 */
export function setCreditsRefusedSink(next: CreditsRefusedSink | null): void {
  creditsRefusedSink = next;
}

/** The code a refused credits turn's error carries (`CreditsUnavailableError`). */
const CREDITS_UNAVAILABLE_CODE = 'credits_unavailable';

/** The sentence of a refused credits turn's error event, or null for any other event. */
function creditsRefusalOf(event: StreamEvent): string | null {
  if (event.type !== 'error') return null;
  const data = event.data as { code?: string; message?: string } | undefined;
  return data?.code === CREDITS_UNAVAILABLE_CODE ? (data.message ?? '') : null;
}

/** Tell the credits sink, never letting it cost the turn. */
function noteCreditsRefused(runtime: string, sessionId: string, message: string): void {
  try {
    creditsRefusedSink?.({ runtime, sessionId, message });
  } catch (err) {
    logger.warn('[Runtimes] Could not report a refused credits turn', { err, runtime });
  }
}

/**
 * How long one sign-in failure waits before anybody is told. A blip that a
 * re-check, a later turn or a sign-in repairs inside it raises nothing.
 */
export const SIGNIN_RECHECK_WINDOW_MS = 30_000;

/** What one re-check learned, for the log only: `ok` means its probe read the plan. */
export type SigninRecheckResult = 'ok' | 'failed' | 'unknown';

/**
 * Re-checks one account after its first failure, never inside the turn. What
 * it resolves to clears nothing: a re-check clears only by proving the account
 * through {@link noteSigninProven} with its own start time, so a shared probe
 * that began before the failure cannot clear it.
 */
export type SigninRecheck = (
  runtime: string,
  accountRoot: string | undefined
) => Promise<SigninRecheckResult>;

/** What proved a sign-in works again, for the one log line a clear writes. */
export type SigninClearCause = 'turn' | 'probe' | 'login' | 'accept';

/** The re-check until boot wires one: it learns nothing. */
const noRecheck: SigninRecheck = async () => 'unknown';

let recheck: SigninRecheck = noRecheck;
let recheckWindowMs = SIGNIN_RECHECK_WINDOW_MS;

/**
 * Install (or tear down) the re-check a single failure runs, and its window.
 *
 * @param next - The re-check, or `null` for none.
 * @param windowMs - How long a single failure is held. Tests may shorten it.
 */
export function setSigninRecheck(
  next: SigninRecheck | null,
  windowMs: number = SIGNIN_RECHECK_WINDOW_MS
): void {
  recheck = next ?? noRecheck;
  recheckWindowMs = windowMs;
}

/** One account's live episode. */
interface SigninEpisodeEntry {
  /** When its first failure was noticed, in ms. The episode's identity. */
  since: number;
  /** The account as the failing turn named it: what the sink is told. */
  account: string | undefined;
  /** Whether the sink was told. False while the re-check window is open. */
  announced: boolean;
  /** The window's timer, while it is open. */
  timer?: ReturnType<typeof setTimeout>;
}

/** Each account holds its own episode, under its runtime. */
interface SigninEpisode {
  /** Episodes by canonical account path; null is an unattributed credential. */
  accounts: Map<string | null, SigninEpisodeEntry>;
}

/** Live episodes, removed only by proof about that same account. */
const failingSince = new Map<string, SigninEpisode>();

/**
 * The key one account's episode is filed under. Canonical, so `/a/.claude`,
 * `/a/.claude/` and a symlink to it are one account wherever the news comes from.
 */
function episodeKey(account: string | undefined): string | null {
  return account === undefined ? null : canonicalAccountPath(account, undefined);
}

/** The live episode for one account, if any. */
function liveEntry(runtimeType: string, key: string | null): SigninEpisodeEntry | undefined {
  return failingSince.get(runtimeType)?.accounts.get(key);
}

/** Drop one account's episode and its timer. */
function forget(runtimeType: string, key: string | null): void {
  const episode = failingSince.get(runtimeType);
  const entry = episode?.accounts.get(key);
  if (!episode || !entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  episode.accounts.delete(key);
  if (episode.accounts.size === 0) failingSince.delete(runtimeType);
}

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
 * Record each failure at once; hold the first one's notice for the re-check
 * window, and say it now when a second failure arrives inside it.
 */
function noteSigninFailure(runtimeType: string, account: string | undefined): void {
  recordAccountSignin(runtimeType, account, 'signed-out');
  if (!sink) return;
  const key = episodeKey(account);
  const held = liveEntry(runtimeType, key);
  if (held) {
    // Twice inside the window is no blip.
    if (!held.announced) announce(runtimeType, key, held);
    return;
  }
  const entry: SigninEpisodeEntry = { since: Date.now(), account, announced: false };
  const episode = failingSince.get(runtimeType) ?? { accounts: new Map() };
  episode.accounts.set(key, entry);
  failingSince.set(runtimeType, episode);
  entry.timer = setTimeout(() => announce(runtimeType, key, entry), recheckWindowMs);
  // A held notice must never keep the process alive.
  entry.timer.unref?.();
  startRecheck(runtimeType, account);
}

/** Tell the sink about a held failure, unless it was repaired or reset since. */
function announce(runtimeType: string, key: string | null, entry: SigninEpisodeEntry): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = undefined;
  if (entry.announced || liveEntry(runtimeType, key) !== entry) return;
  entry.announced = true;
  const told =
    sink !== null &&
    report({
      runtime: runtimeType,
      ...(entry.account ? { accountRoot: entry.account } : {}),
      edge: 'failing',
      since: new Date(entry.since).toISOString(),
    });
  // Nobody was told, so nothing may stand: the next failure must be heard.
  if (!told) forget(runtimeType, key);
}

/**
 * Run the one re-check a held failure gets. Its answer clears nothing here (see
 * {@link SigninRecheck}); its errors never reach the turn.
 */
function startRecheck(runtimeType: string, account: string | undefined): void {
  const failed = (err: unknown): void =>
    logger.debug('[Runtimes] A sign-in re-check could not run', { err, runtime: runtimeType });
  let pending: Promise<SigninRecheckResult>;
  try {
    pending = Promise.resolve(recheck(runtimeType, account));
  } catch (err) {
    failed(err);
    return;
  }
  pending
    .then((result) =>
      logger.debug('[Runtimes] A sign-in re-check finished', { runtime: runtimeType, result })
    )
    .catch(failed);
}

/**
 * Proof that started at a known time: a turn that reached the provider, or a
 * probe that read the plan. It proves only the account it ran on, and only if
 * it began after the failure was noticed — a probe or turn already under way
 * when the sign-in died says nothing about the sign-in as it is now.
 *
 * @param runtimeType - The runtime that ran.
 * @param account - Its account root in any spelling, or absent for runtimes without accounts.
 * @param startedAt - When the turn or probe began, in ms.
 * @param cause - What proved it, written to the log when this clears a signed-out state.
 */
export function noteSigninProven(
  runtimeType: string,
  account: string | undefined,
  startedAt: number,
  cause: SigninClearCause
): void {
  // The LATEST failure, not the episode's first: a probe that began between
  // two failures was already outrun by the second. The signed-out mark is
  // stamped on every failure; the episode's `since` stands in only without it.
  const noticedAt =
    accountSignedOutAt(runtimeType, account) ?? liveEntry(runtimeType, episodeKey(account))?.since;
  if (noticedAt !== undefined && noticedAt >= startedAt) return;
  noteSigninRepaired(runtimeType, account, cause);
}

/**
 * Proof that one account's sign-in works: a turn, a probe, a login or an
 * accepted sign-in. It clears only that account. A failure still inside its
 * re-check window is dropped unsaid, so no recovery is announced either.
 *
 * @param runtimeType - The runtime signed in.
 * @param account - Its account root in any spelling, or absent for runtimes without accounts.
 * @param cause - What proved it, written to the log when this clears a signed-out state.
 */
export function noteSigninRepaired(
  runtimeType: string,
  account: string | undefined,
  cause: SigninClearCause
): void {
  const wasSignedOut = accountSigninState(runtimeType, account) === 'signed-out';
  recordAccountSignin(runtimeType, account, 'signed-in');
  const key = episodeKey(account);
  const entry = liveEntry(runtimeType, key);
  if (entry) forget(runtimeType, key);
  if (!wasSignedOut && !entry) return;
  logger.info('[Runtimes] Sign-in cleared', { runtime: runtimeType, account, cause });
  if (!entry?.announced) return;
  report({
    runtime: runtimeType,
    // The failing edge's spelling, so both edges name one subject.
    ...(entry.account ? { accountRoot: entry.account } : {}),
    edge: 'recovered',
    since: new Date(entry.since).toISOString(),
  });
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
 * Which of a runtime's accounts a session's turns run on, or `undefined` when
 * nobody can say.
 *
 * Asked LATE — at the edge that needs it, never when the turn is set up —
 * because a brand-new session's account is decided by the launch, and the launch
 * has not happened until the first event is pulled. Asking early would answer
 * `undefined` for exactly the turn a dead credential fails on.
 *
 * The contract says this never throws. It is wrapped anyway: this whole module
 * is an observer sitting on somebody else's turn, and an adapter bug must cost
 * the account distinction, never the turn or the notice.
 *
 * An empty string is read as `undefined` — a blank account name distinguishes
 * nothing, and treating it as an identity would file one account's failures
 * under a key no clean turn could ever match.
 */
function accountOf(runtime: AgentRuntime, sessionId: string): string | undefined {
  try {
    const account = runtime.getSessionAccount?.(sessionId);
    return account ? account : undefined;
  } catch (err) {
    logger.debug('[Runtimes] Could not read which account a turn ran on', {
      err,
      runtime: runtime.type,
    });
    return undefined;
  }
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
  runtime: AgentRuntime,
  sessionId: string,
  source: AsyncGenerator<StreamEvent>
): AsyncGenerator<StreamEvent> {
  const startedAt = Date.now();
  let sawAuthError = false;
  let reachedProvider = false;
  try {
    for await (const event of source) {
      const refusal = creditsRefusalOf(event);
      if (refusal !== null) {
        noteCreditsRefused(runtime.type, sessionId, refusal);
      } else if (isAuthErrorEvent(event)) {
        sawAuthError = true;
        noteSigninFailure(runtime.type, accountOf(runtime, sessionId));
      } else if (PROVIDER_CONTACT_EVENTS.has(event.type)) {
        reachedProvider = true;
      }
      yield event;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as { code?: unknown } | null)?.code === CREDITS_UNAVAILABLE_CODE) {
      noteCreditsRefused(runtime.type, sessionId, message);
    } else if (detectAuthError({ message })) {
      noteSigninFailure(runtime.type, accountOf(runtime, sessionId));
    }
    throw err;
  }
  if (!sawAuthError && reachedProvider) {
    noteSigninProven(runtime.type, accountOf(runtime, sessionId), startedAt, 'turn');
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
 * `target` — not the proxy — is what the watched turn is handed, so
 * {@link accountOf}'s `getSessionAccount` call resolves against the instance
 * that owns the session state, for the same reason the `Reflect.get` below
 * passes `target` as its receiver.
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
          watchTurn(target, sessionId, target.sendMessage(sessionId, content, opts));
      }
      // Receiver is the real target (not the proxy) so getters/methods that
      // touch private fields resolve against the instance that owns them.
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Whether an account (or any account of a runtime) still has a live episode,
 * including one still held in its re-check window. Used during boot to avoid
 * retiring a condition this process already observed.
 * @param runtimeType - The runtime to ask about.
 * @param accountRoot - Ask about this account only when present, in any spelling.
 */
export function isSigninFailing(runtimeType: string, accountRoot?: string): boolean {
  return accountRoot === undefined
    ? failingSince.has(runtimeType)
    : liveEntry(runtimeType, episodeKey(accountRoot)) !== undefined;
}

/**
 * Forget every sign-in episode this process is holding open, and every held
 * notice with it.
 *
 * @internal Exported for testing only.
 */
export function resetSigninEpisodes(): void {
  for (const episode of failingSince.values()) {
    for (const entry of episode.accounts.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
  }
  failingSince.clear();
  resetAccountSignins();
}
