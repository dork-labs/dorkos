/**
 * Whether a Claude Code session bills per token rather than against its
 * account's subscription (spec `claude-account-fleet` §6 U). A per-token
 * session's `usage` is its own pay-as-you-go cost, never its folder's
 * subscription windows.
 *
 * Decided from PRESENCE alone, never from a secret's value: the names of the
 * variables set in a launch's final environment, the `apiKeySource` the binary
 * reports on session init, and, for a session not launched here, whether a key
 * reference is configured, the credits flag is on, or this process's own
 * environment carries a key. Nothing here resolves, decrypts or spawns anything
 * (the account compliance guard pins that this module never imports the
 * credential resolver or provider).
 *
 * @module services/runtimes/claude-code/messaging/per-token-billing
 */
import { configManager } from '../../../core/config-manager.js';
import { creditsFlagEnabled } from '../../../core/cloud/credits-inference.js';

/** Variables whose presence makes the binary bill a key or a gateway token, not a sign-in. */
const PER_TOKEN_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

/** `apiKeySource` values that mean the subscription sign-in pays. */
const SUBSCRIPTION_KEY_SOURCES: ReadonlySet<string> = new Set(['none', 'oauth']);

/**
 * The provider id whose stored reference becomes Claude's key at launch. It
 * mirrors `ANTHROPIC_PROVIDER_ID` in the credential environment module, which
 * this module must not import because that module resolves the reference's
 * value; a test pins the two equal.
 */
export const ANTHROPIC_PROVIDER = 'anthropic';

/**
 * Whether a launch environment bills per token.
 *
 * @param env - The environment the child process receives.
 */
export function envBillsPerToken(env: Readonly<Record<string, string | undefined>>): boolean {
  return PER_TOKEN_ENV_VARS.some((name) => (env[name] ?? '') !== '');
}

/**
 * Whether the binary's reported key source bills per token: anything but
 * `none` or `oauth` (an environment key, a helper, a managed or org key).
 *
 * @param apiKeySource - The `apiKeySource` from the session-init message.
 */
export function keySourceBillsPerToken(apiKeySource: string): boolean {
  return !SUBSCRIPTION_KEY_SOURCES.has(apiKeySource);
}

/** What a prediction reads: presence markers only. */
export interface PerTokenSignals {
  /** Whether a Claude key reference is configured (its value is never resolved). */
  keyReferenceConfigured: boolean;
  /** Whether the DorkOS credits flag is on for this process. */
  creditsOn: boolean;
  /** Whether this process's own environment sets a per-token variable. */
  inheritedKey: boolean;
}

/**
 * Read the presence markers. Anything that cannot be read counts as present,
 * so a doubt reads as per token.
 */
export function readPerTokenSignals(): PerTokenSignals {
  let keyReferenceConfigured = true;
  try {
    const ref = (configManager.get('providers') as Record<string, unknown> | undefined)?.[
      ANTHROPIC_PROVIDER
    ];
    keyReferenceConfigured = typeof ref === 'string' ? ref.trim() !== '' : ref != null;
  } catch {
    // An unreadable config is a doubt.
  }
  let creditsOn = true;
  try {
    creditsOn = creditsFlagEnabled();
  } catch {
    // A doubt.
  }
  // eslint-disable-next-line no-restricted-syntax -- presence of two names in this process's own environment, never their values
  const inheritedKey = envBillsPerToken(process.env);
  return { keyReferenceConfigured, creditsOn, inheritedKey };
}

/**
 * What a launch made now would bill, for a session not launched in this
 * process: per token when a key reference is configured, the credits flag is
 * on, or this process's environment carries a key; per token too when any of
 * that cannot be read, so a session is never shown a subscription bar it may
 * not have.
 *
 * @param signals - The presence markers; read from this process by default.
 */
export function predictLaunchBillsPerToken(
  signals: PerTokenSignals = readPerTokenSignals()
): boolean {
  return signals.keyReferenceConfigured || signals.creditsOn || signals.inheritedKey;
}
