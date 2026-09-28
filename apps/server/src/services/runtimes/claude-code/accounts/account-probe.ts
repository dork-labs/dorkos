/**
 * Read an idle Claude account's usage without running a turn (spec
 * `claude-account-fleet` D3).
 *
 * The usage store only learns about an account while a session runs on it. An
 * account nobody has used today therefore reads `unknown`, which is exactly the
 * account a person would like to move work onto. The probe fills that gap the
 * way the runtime already warms its command list: it boots the official Claude
 * Code binary on an idle prompt that never yields a message, asks it for the
 * `/usage` data, and closes it. No user message is sent, so no model turn runs
 * and nothing is billed; `persistSession: false` leaves no transcript.
 *
 * What it never does (spec invariant 3, guarded by `__tests__/compliance.test.ts`):
 * read a sign-in token or a credentials file, or call a usage endpoint itself.
 * Everything comes from the binary, run in the account's own config folder.
 *
 * On demand only (the route and the `accounts_probe` tool): never at boot and
 * never on a timer. Single-flight per account, with a 60 s floor between tries.
 *
 * @module services/runtimes/claude-code/accounts/account-probe
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { logger } from '../../../../lib/logger.js';
import type { AccountUsageStore } from '../../../core/usage/account-usage-store.js';
import { getAccountUsageStore } from '../../../core/usage/current-usage-store.js';
import { resolveAccountRef, type RuntimeAccount } from '../../../core/usage/runtime-accounts.js';
import { runtimeEnvironment } from '../../shared/runtime-environment-config.js';
import { claudeConfigDirEnv, isClaudeAccountRoot } from '../claude-config-dir.js';
import { createIdlePrompt, resolveClaudeBinaryBeforePath } from '../sdk/sdk-utils.js';
import { mapSdkUsageWindows } from '../sdk/subscription-usage.js';

/** How one probe ended. */
export type AccountProbeOutcome = 'ok' | 'unavailable' | 'failed' | 'throttled';

/** The answer to one probe: the account's usage as the store now holds it, and how the probe went. */
export interface AccountProbeResult {
  /** The account's usage after the probe (unchanged unless `probe` is `ok`). */
  account: AccountUsage;
  /** `ok` recorded new readings; every other outcome recorded nothing. */
  probe: AccountProbeOutcome;
  /**
   * A short machine-readable reason for `failed` (`not-an-account`, `timeout`,
   * `usage-unsupported`, `no-readings`, or the error's first line) and `throttled`.
   */
  reason?: string;
}

/** The probe was asked about an id the Claude Code registry does not hold. */
export class UnknownAccountError extends Error {
  /** The route maps this to a 404 with this code. */
  readonly code = 'UNKNOWN_ACCOUNT';

  /**
   * Build the error for one id.
   *
   * @param accountId - The id that named nothing.
   */
  constructor(readonly accountId: string) {
    super(`No Claude Code account is called "${accountId}".`);
    this.name = 'UnknownAccountError';
  }
}

/** The usage store is not running yet (early boot), so there is nothing to probe into. */
export class AccountUsageUnavailableError extends Error {
  constructor() {
    super('Account usage is not available yet.');
    this.name = 'AccountUsageUnavailableError';
  }
}

/** The slice of the SDK `Query` the probe uses. */
export type ProbeQuery = Pick<
  ReturnType<typeof query>,
  'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET' | 'close'
>;

/** Builds the probe's query; the SDK's `query` in production, a fake in tests. */
export type ProbeQueryFactory = (params: Parameters<typeof query>[0]) => ProbeQuery;

/** Injectable collaborators, all defaulted for production. */
export interface AccountProbeDeps {
  /** Builds the SDK query (default: the SDK's `query`). */
  queryFactory?: ProbeQueryFactory;
  /** The usage store (default: the process's installed store). */
  store?: AccountUsageStore;
  /** Clock in ms (default: `Date.now`). */
  now?: () => number;
  /** How long the usage call may take (default {@link PROBE_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** The DorkOS data directory (default: `resolveDorkHome()`). */
  dorkHome?: string;
  /** The Claude Code binary to spawn (default: the runtime's installed resolver). */
  binaryPath?: string | undefined;
  /** Whether a folder is a Claude account (default: `isClaudeAccountRoot`). */
  isAccountRoot?: (dir: string) => boolean;
}

/** The shortest gap between two probes of one account. */
export const PROBE_FLOOR_MS = 60_000;

/** How long the usage call may take before the probe gives up. */
export const PROBE_TIMEOUT_MS = 15_000;

/** Probes running now, by account, so concurrent callers share one. */
const inFlight = new Map<string, Promise<AccountProbeResult>>();

/** When each account was last probed (the start of the attempt), in ms. */
const lastAttemptAt = new Map<string, number>();

/**
 * Resolves the binary a probe spawns. The runtime installs its own resolver
 * ({@link setAccountProbeBinaryResolver}) so a probe runs the same binary a
 * session would; until then only the rungs that spawn nothing are walked.
 */
let binaryResolver: () => string | undefined = () => resolveClaudeBinaryBeforePath() ?? undefined;

/**
 * Install the resolver for the Claude Code binary a probe spawns: the runtime's
 * own, so a probe and a session always run the same binary.
 *
 * @param resolve - Returns the binary's path, or `undefined` to let the SDK resolve it.
 */
export function setAccountProbeBinaryResolver(resolve: () => string | undefined): void {
  binaryResolver = resolve;
}

/**
 * Forget every in-flight probe and every last-attempt time.
 *
 * @internal Tests only: the throttle is process-wide on purpose.
 */
export function resetAccountProbeState(): void {
  inFlight.clear();
  lastAttemptAt.clear();
}

/**
 * Probe one Claude Code account's usage without running a turn.
 *
 * `default` is this computer's own sign-in (or the registered account it is
 * another name for); any other id must be registered.
 *
 * @param accountId - A registry id, or `default`.
 * @param deps - Injectable collaborators.
 * @returns The account's usage and how the probe went. Never rejects for a
 *   probe failure: that reads as `failed` with nothing recorded.
 * @throws {UnknownAccountError} When no Claude Code account has that id.
 * @throws {AccountUsageUnavailableError} When the usage store is not running.
 */
export async function probeAccount(
  accountId: string,
  deps: AccountProbeDeps = {}
): Promise<AccountProbeResult> {
  const store = deps.store ?? getAccountUsageStore();
  if (!store) throw new AccountUsageUnavailableError();
  const account = resolveAccountRef(store.listAccounts('claude-code'), 'claude-code', accountId);
  if (!account) throw new UnknownAccountError(accountId);

  // Keyed by the account the id resolved to, so `default` and the row it is an
  // alias of share one flight and one floor.
  const key = account.id;
  const running = inFlight.get(key);
  if (running) return running;

  const now = deps.now ?? Date.now;
  const last = lastAttemptAt.get(key);
  if (last !== undefined && now() - last < PROBE_FLOOR_MS) {
    return { account: store.usageOfAccount(account), probe: 'throttled', reason: 'too-soon' };
  }

  lastAttemptAt.set(key, now());
  const flight = runProbe(account, store, deps).finally(() => inFlight.delete(key));
  inFlight.set(key, flight);
  return flight;
}

/** One probe of a resolved account. */
async function runProbe(
  account: RuntimeAccount,
  store: AccountUsageStore,
  deps: AccountProbeDeps
): Promise<AccountProbeResult> {
  const failed = (reason: string): AccountProbeResult => ({
    account: store.usageOfAccount(account),
    probe: 'failed',
    reason,
  });
  const root = account.path;
  const isAccountRoot = deps.isAccountRoot ?? isClaudeAccountRoot;
  if (!root || !isAccountRoot(root)) return failed('not-an-account');

  const queryFactory = deps.queryFactory ?? query;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const binary = 'binaryPath' in deps ? deps.binaryPath : binaryResolver();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: ReturnType<typeof createIdlePrompt> | undefined;
  let probe: ProbeQuery | undefined;
  try {
    // A folder of its own, so the probe never reads a project's CLAUDE.md or
    // settings, and never leaves anything in a person's work.
    const cwd = path.join(deps.dorkHome ?? resolveDorkHome(), 'cache', 'account-probe');
    await mkdir(cwd, { recursive: true });
    idle = createIdlePrompt();
    probe = queryFactory({
      prompt: idle.prompt,
      options: {
        cwd,
        // No hooks, no CLAUDE.md, no plugins, no MCP servers: nothing that could
        // do work of its own while the CLI is up.
        settingSources: [],
        // No transcript: the probe is not a session.
        persistSession: false,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
        // The account's own folder. `~/.claude` reaches the CLI as an unset
        // variable, the one spelling its sign-in answers to.
        env: runtimeEnvironment('claude-code', 'warmup', { ...claudeConfigDirEnv(root) }),
      },
    });
    const usageCall = probe.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof usageCall !== 'function') return failed('usage-unsupported');
    const response = await Promise.race([
      usageCall.call(probe, { skipBehaviors: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError()), timeoutMs);
      }),
    ]);
    if (response.rate_limits_available === false) {
      // An API key or a cloud platform, not a Claude plan: no plan limits to read.
      return { account: store.usageOfAccount(account), probe: 'unavailable' };
    }
    const observations = mapSdkUsageWindows(response, new Date((deps.now ?? Date.now)()));
    // Plan limits apply but no window carried a reading: nothing to record, and
    // `ok` would claim a check that learned nothing.
    if (observations.length === 0) return failed('no-readings');
    store.record('claude-code', { path: root }, observations, {
      subscriptionType: response.subscription_type ?? null,
    });
    return { account: store.usageOfAccount(account), probe: 'ok' };
  } catch (err) {
    if (err instanceof ProbeTimeoutError) return failed('timeout');
    logger.debug('[account-probe] probe failed; nothing recorded', {
      accountId: account.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return failed(shortReason(err));
  } finally {
    if (timer) clearTimeout(timer);
    // Both, on every path: closing the prompt closes stdin, and only closing the
    // query ends the CLI child (see `warmCommands` in claude-code-runtime.ts).
    idle?.close();
    probe?.close();
  }
}

/** The usage call did not answer in time. */
class ProbeTimeoutError extends Error {}

/** A failure's message, cut to one short line. */
function shortReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const line = message.split('\n')[0]?.trim() ?? '';
  return line.length === 0 ? 'error' : line.slice(0, 160);
}
