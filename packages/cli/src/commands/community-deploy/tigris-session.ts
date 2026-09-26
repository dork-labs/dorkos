/**
 * Secret-safe local Fly session and app-secret inventory for Tigris launch steps.
 *
 * @module commands/community-deploy/tigris-session
 */
import { z } from 'zod';
import { SAFE_PROVIDER_IDENTIFIER_PATTERN } from './provider-identifiers.js';
import { ProviderMutationError } from './provider-mutation.js';
import { runProviderCommand } from './provider-process.js';

const SAFE_SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const SAFE_DIGEST = /^[A-Za-z0-9][A-Za-z0-9:+/=_-]{0,255}$/u;
const EXPECTED_TIGRIS_SECRET_NAMES = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const;

const TokenEnvelopeSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[\x21-\x7e]+$/u),
  })
  .strict();

const SecretInventorySchema = z.array(
  z
    .object({
      name: z.string().regex(SAFE_SECRET_NAME),
      digest: z.string().regex(SAFE_DIGEST),
      status: z.enum(['Deployed', 'Staged', 'Partial', 'Unknown']).optional(),
    })
    .strict()
);

/** Stable failure from local Fly session and secret-inventory validation. */
export class TigrisSessionError extends Error {
  /** Safe classification suitable for diagnostics and a non-secret journal. */
  readonly code: 'INVALID_INPUT' | 'MISSING_TIGRIS_SECRETS' | 'CREDENTIAL_DISPOSED';

  /**
   * Create a secret-free Tigris session error.
   *
   * @param code - Stable failure classification.
   */
  constructor(code: TigrisSessionError['code']) {
    super(`Tigris session failed (${code})`);
    this.name = 'TigrisSessionError';
    this.code = code;
  }
}

/** In-memory Fly session credential that redacts serialization and supports explicit disposal. */
export class FlySessionCredential {
  #token: string | undefined;

  /**
   * Wrap a validated local Fly session token without exposing it as object data.
   *
   * @param token - Validated token emitted by the pinned local Fly CLI.
   */
  constructor(token: string) {
    this.#token = token;
  }

  /**
   * Use the token inside one bounded callback.
   *
   * @param consumer - In-memory consumer such as the fixed-endpoint GraphQL client.
   * @returns The consumer result.
   */
  async use<T>(consumer: (token: string) => Promise<T>): Promise<T> {
    if (this.#token === undefined) throw new TigrisSessionError('CREDENTIAL_DISPOSED');
    return consumer(this.#token);
  }

  /** Drop this wrapper's reference to the session token. */
  dispose(): void {
    this.#token = undefined;
  }

  /** Return a safe marker for string interpolation. */
  toString(): string {
    return '[REDACTED Fly session credential]';
  }

  /** Return a safe marker for JSON serialization. */
  toJSON(): string {
    return '[REDACTED Fly session credential]';
  }
}

/** Non-secret Fly app-secret inventory row. */
export interface FlySecretInventoryItem {
  /** Secret name. */
  name: string;
  /** Provider-issued non-secret value digest. */
  digest: string;
  /** Deployment posture when the CLI can determine it. */
  status?: 'Deployed' | 'Staged' | 'Partial' | 'Unknown';
}

/** Options shared by the pinned local Fly CLI reads. */
export interface FlySessionReadOptions {
  /** Absolute or PATH-resolved Fly CLI executable. */
  executable: string;
  /** Minimal environment needed to reach the existing local Fly profile. */
  env: Readonly<Record<string, string>>;
  /** Command deadline in milliseconds. */
  timeoutMs: number;
  /** Operator cancellation shared by the complete guided launch. */
  signal?: AbortSignal;
}

/**
 * Read the current local Fly session into a redacting, disposable in-memory wrapper.
 *
 * @param options - Pinned executable and bounded process settings.
 * @returns The local session credential wrapper.
 */
export async function readFlySessionCredential(
  options: FlySessionReadOptions
): Promise<FlySessionCredential> {
  const result = await runProviderCommand({
    ...options,
    args: ['auth', 'token', '--json', '--quiet'],
    parse: (stdout) => {
      const parsed = TokenEnvelopeSchema.parse(JSON.parse(stdout));
      return new FlySessionCredential(parsed.token);
    },
  });
  return result.value;
}

/**
 * Read non-secret secret names, digests, and deployment posture for one verified Fly app.
 *
 * @param options - Pinned executable and bounded process settings.
 * @param appName - Verified Fly app name selected by the immutable plan.
 * @returns Validated non-secret secret inventory.
 */
export async function readFlySecretInventory(
  options: FlySessionReadOptions,
  appName: string
): Promise<FlySecretInventoryItem[]> {
  if (!SAFE_PROVIDER_IDENTIFIER_PATTERN.test(appName)) {
    throw new TigrisSessionError('INVALID_INPUT');
  }
  const result = await runProviderCommand({
    ...options,
    args: ['secrets', 'list', '--app', appName, '--json'],
    parse: (stdout) => {
      const inventory = SecretInventorySchema.parse(JSON.parse(stdout));
      if (new Set(inventory.map((item) => item.name)).size !== inventory.length) {
        throw new TigrisSessionError('INVALID_INPUT');
      }
      return inventory;
    },
  });
  return result.value;
}

/**
 * Prove that Fly attached both Tigris credential names without exposing either value.
 *
 * @param inventory - Validated non-secret Fly app-secret inventory.
 * @returns Only the two expected Tigris inventory rows in stable order.
 */
export function verifyTigrisSecretNames(
  inventory: readonly FlySecretInventoryItem[]
): [FlySecretInventoryItem, FlySecretInventoryItem] {
  const byName = new Map(inventory.map((item) => [item.name, item]));
  const accessKey = byName.get(EXPECTED_TIGRIS_SECRET_NAMES[0]);
  const secretKey = byName.get(EXPECTED_TIGRIS_SECRET_NAMES[1]);
  if (!accessKey || !secretKey) throw new TigrisSessionError('MISSING_TIGRIS_SECRETS');
  return [accessKey, secretKey];
}

/**
 * Prove both Tigris credential names exist and neither carries a value from a removed bucket.
 *
 * After a verified removal of an earlier bucket, the journal keeps the digests its credentials had.
 * A re-created bucket must set new values for both names, so a digest equal to any removed one means
 * the app still holds stale credentials and the step must stop instead of deploying with them.
 *
 * @param inventory - Validated non-secret Fly app-secret inventory.
 * @param removedDigests - Credential digests recorded for each removed bucket, oldest first.
 * @returns Only the two expected Tigris inventory rows in stable order.
 */
export function verifyFreshTigrisSecrets(
  inventory: readonly FlySecretInventoryItem[],
  removedDigests: readonly Readonly<Record<string, string>>[]
): [FlySecretInventoryItem, FlySecretInventoryItem] {
  const rows = verifyTigrisSecretNames(inventory);
  if (
    removedDigests.some((digests) =>
      rows.some((row) => digests[row.name] !== undefined && digests[row.name] === row.digest)
    )
  ) {
    throw new ProviderMutationError('INVALID_RESPONSE');
  }
  return rows;
}
