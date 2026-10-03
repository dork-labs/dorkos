/**
 * DorkOS credits as one more entry in a runtime's Runs on list (ADR
 * `261001-000811`, spec `dorkos-account-by-default` §1).
 *
 * The endpoint speaks the verbatim vendor protocols, so no runtime needs a new
 * client: what one needs is a base URL and a token, and both are runtime values
 * this module obtains from `POST /v1/inference/tokens`. Nothing here bakes in a
 * host; the endpoints arrive on the wire.
 *
 * ## Who decides, and what this module may never do
 *
 * Who pays for a turn is always a choice a person made, or a default they were
 * told about. That choice lives where every other Runs on choice lives (for
 * Claude Code, the account ladder: a session's own pick, its agent's account,
 * the machine default; a project rule can only block credits), never in this module. This module only
 * answers ONE question for a launch that already chose credits: here is the
 * environment that makes it so, or a refusal.
 *
 * Three rules follow, and each is pinned by a test:
 *
 * - **Fail closed.** A launch that chose credits with no live token is REFUSED
 *   ({@link CreditsUnavailableError}); it never quietly runs on the runtime's
 *   own sign-in, which would bill somebody who chose not to be billed.
 * - **Nothing to a runtime that did not ask.** {@link resolveCreditsLaunchEnv}
 *   refuses a runtime that does not declare `capabilities.credits`, so a token
 *   can never reach a launch that would mishandle it.
 * - **Nothing to a launch on its own sign-in.** No function here is called for
 *   such a launch, and the launch sites strip both credit variables from it.
 *
 * ## The kill switch
 *
 * `DORKOS_CLOUD_CREDITS` is read ONCE at module scope and can only turn credits
 * OFF (`0`, `false`, `no`, `off`). Off, every credits launch refuses with a
 * sentence saying credits are turned off on this computer; nothing falls back.
 *
 * ## The token is a credential
 *
 * It is held in memory and never written to config, never logged, never sent
 * to the client. It does not need to be stored: the link credential that mints
 * it (`cloud.instanceToken`) is already kept, so {@link startCreditsLifecycle}
 * mints a fresh one at startup and again before each one expires. A launch
 * that finds none waits for one bounded mint ({@link ensureCreditsToken}) and
 * refuses when that fails.
 *
 * @module services/core/cloud/credits-inference
 */
import {
  InferenceTokenRevokeResponseSchema,
  InferenceTokenSchema,
  V1_ROUTES,
  v1Path,
  type InferenceToken,
} from '@dork-labs/cloud-api';
import { CloudApiResponseError } from '@dork-labs/cloud-api/client';
import type { CloudCreditsRuntimeState, CloudCreditsStatus } from '@dorkos/shared/cloud-schemas';
import type { RuntimeCapabilities, RuntimeCreditsProtocol } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../lib/logger.js';
import { configManager } from '../config-manager.js';
import { creditsKilled } from './credits-availability.js';
import { noteCreditsAccount } from './credits-defaults.js';
import {
  captureCloudV1Context,
  isCloudLinked,
  problemOf,
  readCloudInstanceToken,
  resolveCloudIdentity,
  type CloudV1Context,
} from './v1-client.js';

/** Mint this long before a token expires. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Never schedule a refresh sooner than this, so a short token cannot spin. */
const MIN_REFRESH_DELAY_MS = 30_000;
/** After a failed refresh, try again this much later. */
const RETRY_DELAY_MS = 60_000;
/** How long a launch waits for one mint before it refuses. */
const CREDITS_LAUNCH_WAIT_MS = 8_000;

/** A minted token is usable only while its original local link remains current. */
let minted: { token: InferenceToken; isCurrent: () => boolean } | null = null;
let attemptGeneration = 0;
/** The one mint in flight, shared by every launch waiting on it. */
let inflight: Promise<boolean> | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Injectable clock so the expiry check is testable without waiting. */
let now: () => number = () => Date.now();

/**
 * Replace the module's in-memory state. Test seam only; production mints
 * through {@link primeCreditsInference}.
 *
 * @param state - The token to hold (or `null` to clear) and an optional clock.
 * @internal
 */
export function __setCreditsStateForTests(state: {
  token: InferenceToken | null;
  now?: () => number;
  isCurrent?: () => boolean;
}): void {
  minted =
    state.token === null
      ? null
      : { token: state.token, isCurrent: state.isCurrent ?? (() => true) };
  attemptGeneration += 1;
  inflight = null;
  now = state.now ?? (() => Date.now());
}

/** Whether the held token is present, still current and inside its validity window. */
function live(): InferenceToken | null {
  if (minted === null) return null;
  if (!minted.isCurrent() || Date.parse(minted.token.expiresAt) <= now()) {
    minted = null;
    return null;
  }
  return minted.token;
}

/**
 * The held token when it has more than the refresh margin left, else `null`.
 * A launch is never handed a token about to expire: a turn started on one
 * would fail partway through, so the launch mints a fresh one first.
 */
function handoutable(): InferenceToken | null {
  const token = live();
  if (token === null) return null;
  return Date.parse(token.expiresAt) - now() > REFRESH_MARGIN_MS ? token : null;
}

/**
 * The held token while it is live, else `null`. Never mints.
 * @internal Exported for tests; production reads it through {@link ensureCreditsToken}.
 */
export function heldCreditsToken(): InferenceToken | null {
  return live();
}

/**
 * Mint an inference token and hold it, returning whether credits are usable.
 *
 * `false` with no request when the kill switch is on or the instance is not
 * linked. Failures are logged without any response value and swallowed: a
 * cloud outage refuses credits launches and never blocks anything else.
 */
async function primeCreditsInference(): Promise<boolean> {
  return primeCreditsInferenceGated(creditsKilled(), captureCloudV1Context);
}

/**
 * The gate in front of every production mint, with the kill switch as an
 * argument so a test can prove it stops the request. Production has one
 * caller, which supplies the module constant.
 *
 * @param killed - Whether the kill switch is on.
 * @param capture - Captures the link context to mint under.
 * @internal
 */
export async function primeCreditsInferenceGated(
  killed: boolean,
  capture: () => CloudV1Context | null
): Promise<boolean> {
  if (killed) return false;
  return primeCreditsInferenceWithContext(capture());
}

/**
 * Testable mint core. Production enters only through
 * {@link primeCreditsInferenceGated}.
 *
 * @param context - The captured link context, or `null` when unlinked.
 * @internal
 */
export async function primeCreditsInferenceWithContext(
  context: CloudV1Context | null
): Promise<boolean> {
  const attempt = ++attemptGeneration;
  if (context === null) {
    minted = null;
    return false;
  }
  try {
    const { instanceId, accountKey } = await resolveCloudIdentity(context);
    if (!context.isCurrent() || attempt !== attemptGeneration) return false;
    // Which account the credits choices belong to, when that was not known
    // (a link made before it was recorded); a new link sets it itself.
    if (accountKey !== null) noteCreditsAccount(accountKey);
    if (instanceId === null) {
      minted = null;
      return false;
    }
    const token = await context.client.post(V1_ROUTES.inferenceTokens, InferenceTokenSchema, {
      body: { instanceId },
    });
    if (!context.isCurrent() || attempt !== attemptGeneration) return false;
    minted = { token, isCurrent: context.isCurrent };
    scheduleRefresh(token);
    return true;
  } catch (error) {
    const status =
      problemOf(error)?.status ?? (error instanceof CloudApiResponseError ? error.status : null);
    if (
      context.isCurrent() &&
      attempt === attemptGeneration &&
      status !== null &&
      [401, 403, 404].includes(status)
    ) {
      minted = null;
    }
    // Even schema errors can quote response values; keep credentials out of logs.
    logger.warn('[Cloud] Could not obtain an inference token', {
      status,
      code: problemOf(error)?.code,
    });
    return false;
  }
}

/** Mint once, sharing the attempt with every caller that arrives while it runs. */
function mintOnce(): Promise<boolean> {
  if (inflight) return inflight;
  const attempt = primeCreditsInference().finally(() => {
    if (inflight === attempt) inflight = null;
  });
  inflight = attempt;
  return attempt;
}

/** Arm the timer that mints the next token before this one expires. */
function scheduleRefresh(token: InferenceToken, delayOverride?: number): void {
  if (!lifecycleRunning) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  const due = Date.parse(token.expiresAt) - REFRESH_MARGIN_MS - now();
  const delay = delayOverride ?? Math.max(MIN_REFRESH_DELAY_MS, due);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void mintOnce().then((ok) => {
      // Keep trying while the link stands: an outage at refresh time must not
      // leave the next launch to find an expired token with nothing coming.
      if (!ok && isCloudLinked() && minted === null) retryLater();
    });
  }, delay);
  refreshTimer.unref?.();
}

/** Try a mint again after {@link RETRY_DELAY_MS}. */
function retryLater(): void {
  if (!lifecycleRunning) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void mintOnce().then((ok) => {
      if (!ok && isCloudLinked() && minted === null) retryLater();
    });
  }, RETRY_DELAY_MS);
  refreshTimer.unref?.();
}

let lifecycleRunning = false;
let stopWatchingLink: (() => void) | null = null;

/**
 * Keep a live token while this instance is linked: mint one at startup, mint
 * again before each expires, and mint (or drop) when the link changes. Without
 * this, a restart left credits launches with nothing to run on until somebody
 * pressed a button, and an expired token was found only by the turn it broke.
 *
 * A no-op while the kill switch is on. Returns the stop function.
 */
export function startCreditsLifecycle(): () => void {
  if (creditsKilled() || lifecycleRunning) return stopCreditsLifecycle;
  lifecycleRunning = true;
  if (isCloudLinked()) void mintOnce().then((ok) => !ok && isCloudLinked() && retryLater());
  let seenToken = readCloudInstanceToken();
  stopWatchingLink = configManager.onChange((change) => {
    if (!change.paths.some((path) => path === 'cloud' || path === 'cloud.instanceToken')) return;
    // Only a changed link credential matters: the `cloud` block also carries
    // the person's credits choices, and saving one must not mint.
    const token = readCloudInstanceToken();
    if (token === seenToken) return;
    seenToken = token;
    if (isCloudLinked()) {
      void mintOnce();
    } else {
      minted = null;
      attemptGeneration += 1;
    }
  });
  return stopCreditsLifecycle;
}

/** Stop the refresh timer and the link watch. */
export function stopCreditsLifecycle(): void {
  lifecycleRunning = false;
  stopWatchingLink?.();
  stopWatchingLink = null;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}

/**
 * The live token, or one bounded mint's worth of waiting for one.
 *
 * @param timeoutMs - How long to wait for the mint before giving up.
 * @returns The live token, or `null` when there is none to be had.
 */
async function ensureCreditsToken(
  timeoutMs: number = CREDITS_LAUNCH_WAIT_MS
): Promise<InferenceToken | null> {
  const held = handoutable();
  if (held) return held;
  if (creditsKilled() || !isCloudLinked()) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    await Promise.race([mintOnce(), timeout]);
  } finally {
    clearTimeout(timer);
  }
  return handoutable();
}

/** How long an unlink waits for the held token's revoke before it moves on. */
const REVOKE_WAIT_MS = 3_000;

/**
 * Drop the held token and ask the service to revoke it under the link
 * credential that minted it. Everything it needs is captured SYNCHRONOUSLY on
 * the call (an unlink calls it before the link is cleared), and only the
 * request is awaited, so a token can never outlive the link it was minted
 * under. Best effort and bounded: the local token is gone either way, and a
 * revoke that fails or takes too long is logged without any response value.
 */
export async function revokeHeldCreditsToken(): Promise<void> {
  const held = minted;
  minted = null;
  inflight = null;
  attemptGeneration += 1;
  if (held === null) return;
  const context = captureCloudV1Context();
  if (context === null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      context.client.post(
        v1Path.inferenceTokenRevoke(held.token.tokenId),
        InferenceTokenRevokeResponseSchema,
        { body: {} }
      ),
      new Promise((resolve) => {
        timer = setTimeout(resolve, REVOKE_WAIT_MS);
      }),
    ]);
  } catch (error) {
    const status = problemOf(error)?.status ?? null;
    logger.warn('[Cloud] Could not revoke the credits token on unlink', { status });
  } finally {
    clearTimeout(timer);
  }
}

/** Why a launch that chose credits cannot have them. */
export type CreditsUnavailableReason =
  | 'off'
  | 'not-linked'
  | 'unreachable'
  | 'not-supported'
  | 'folder-sign-in'
  | 'stopped'
  | 'no-models';

/**
 * A launch chose DorkOS credits and cannot have them, so it is refused rather
 * than run on anything else. The message is the sentence a person reads; the
 * runtime's chat turns `code` into the Retry and Use-your-own-sign-in actions.
 */
export class CreditsUnavailableError extends Error {
  /** Stable code the client keys the actions on. */
  readonly code = 'credits_unavailable';

  /**
   * Build the refusal for one launch.
   *
   * @param reason - Why credits are unavailable.
   * @param runtimeLabel - The runtime's display name, for the sentence.
   */
  constructor(
    readonly reason: CreditsUnavailableReason,
    readonly runtimeLabel: string
  ) {
    super(creditsRefusalSentence(reason, runtimeLabel));
    this.name = 'CreditsUnavailableError';
  }
}

/**
 * The plain sentence for a refused credits launch.
 *
 * @param reason - Why credits are unavailable.
 * @param runtimeLabel - The runtime's display name.
 */
function creditsRefusalSentence(reason: CreditsUnavailableReason, runtimeLabel: string): string {
  switch (reason) {
    case 'off':
      return `DorkOS credits are turned off on this computer, so nothing was sent. Use your ${runtimeLabel} sign-in instead, or turn credits back on.`;
    case 'not-linked':
      return `Couldn't reach DorkOS credits: this computer isn't signed in to a DorkOS account, so nothing was sent. Sign in again, or use your ${runtimeLabel} sign-in.`;
    case 'not-supported':
      return `${runtimeLabel} can't run on DorkOS credits yet, so nothing was sent. Use your ${runtimeLabel} sign-in.`;
    case 'unreachable':
      return `Couldn't reach DorkOS credits, so nothing was sent. Try again, or use your ${runtimeLabel} sign-in.`;
    case 'folder-sign-in':
      return `This folder's ${runtimeLabel} settings name their own sign-in, so it can't run on DorkOS credits and nothing was sent. Use your ${runtimeLabel} sign-in here, or stop using credits in this project.`;
    case 'no-models':
      return `DorkOS credits don’t cover a ${runtimeLabel} model yet, so nothing was sent. Use your ${runtimeLabel} sign-in instead.`;
    case 'stopped':
      return `DorkOS credits stopped working partway through this turn. Try again, or use your ${runtimeLabel} sign-in.`;
  }
}

/**
 * The environment one protocol needs to run on a held token. Pure, so the
 * shape is testable without minting.
 *
 * @param token - The live inference token.
 * @param protocol - The protocol the runtime speaks.
 */
export function creditsEnvFor(
  token: InferenceToken,
  protocol: RuntimeCreditsProtocol
): Record<string, string> {
  switch (protocol) {
    case 'anthropic-messages':
      return {
        ANTHROPIC_BASE_URL: token.endpoints.anthropicMessages,
        ANTHROPIC_AUTH_TOKEN: token.token,
      };
  }
}

/**
 * The environment a launch that CHOSE credits runs with, or the refusal.
 *
 * Call this only for a launch whose Runs on choice is credits. It refuses,
 * never returns an empty object, so a caller cannot mistake "no credits" for
 * "run on whatever else is there".
 *
 * @param capabilities - The launching runtime's declared capabilities.
 * @param runtimeLabel - The runtime's display name, for the refusal sentence.
 * @param waitMs - How long to wait for a mint when no token is held.
 * @throws {CreditsUnavailableError} When credits cannot pay for this launch.
 */
export async function resolveCreditsLaunchEnv(
  capabilities: Pick<RuntimeCapabilities, 'credits'>,
  runtimeLabel: string,
  waitMs: number = CREDITS_LAUNCH_WAIT_MS
): Promise<Record<string, string>> {
  const protocol = capabilities.credits?.protocol;
  if (protocol === undefined) throw new CreditsUnavailableError('not-supported', runtimeLabel);
  if (creditsKilled()) throw new CreditsUnavailableError('off', runtimeLabel);
  if (!isCloudLinked()) throw new CreditsUnavailableError('not-linked', runtimeLabel);
  const token = await ensureCreditsToken(waitMs);
  if (token === null) throw new CreditsUnavailableError('unreachable', runtimeLabel);
  return creditsEnvFor(token, protocol);
}

/**
 * The runtimes credits reach, derived from what each one DECLARES, so a status
 * line can never say a runtime runs on credits that does not.
 *
 * @param runtimes - Every registered runtime's capabilities.
 */
export function creditsWiringReport(
  runtimes: ReadonlyArray<Pick<RuntimeCapabilities, 'type' | 'credits'>>
): CloudCreditsStatus {
  const state = (type: string): CloudCreditsRuntimeState =>
    runtimes.some((runtime) => runtime.type === type && runtime.credits !== undefined)
      ? 'wired'
      : 'follow-up';
  const linked = isCloudLinked();
  return {
    enabled: !creditsKilled() && linked,
    killed: creditsKilled(),
    linked,
    ready: live() !== null,
    runtimes: {
      'claude-code': state('claude-code'),
      opencode: state('opencode'),
      codex: state('codex'),
    },
  };
}
