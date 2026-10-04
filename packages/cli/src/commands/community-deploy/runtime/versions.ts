/**
 * Machine-readable local CLI version checks for Community deployment.
 *
 * @module commands/community-deploy/runtime/versions
 */
import { z } from 'zod';
import { ProviderCommandError, runProviderCommand } from '../provider-process.js';
import type { FlySessionReadOptions } from '../tigris-session.js';
import type { NeonReadOptions } from '../neon-read.js';
import { describeCommunityCredential } from './credential-env.js';

const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
/**
 * `Name` is the base name of the running executable (flyctl `buildinfo`). The binary ships as
 * `flyctl` with a `fly` link, and Linux resolves the link, so the same install reports either.
 */
const FlyVersionSchema = z
  .object({ Name: z.string().regex(/^(?:fly|flyctl)(?:\.exe)?$/u), Version: VersionSchema })
  .passthrough();

type CommunityProvider = 'fly' | 'neon';

const PROVIDER_HELP = {
  fly: {
    install: 'https://fly.io/docs/flyctl/install/',
    auth: 'https://fly.io/docs/flyctl/auth-token/',
    command: 'fly auth login',
  },
  neon: {
    install: 'https://neon.com/docs/reference/neon-cli',
    auth: 'https://neon.com/docs/reference/cli-auth',
    command: 'neonctl auth',
  },
} as const;

/** Which credential a preflight read used, and for which organization, to word a refusal. */
export interface CommunityPreflightAccess {
  /** The environment `fly` or `neonctl` was given. Only variable names are ever printed. */
  env: Readonly<Record<string, string | undefined>>;
  /** The organization the person chose, as they typed it. */
  organization: string;
}

/** Provider-specific, secret-free preflight failure with an actionable official destination. */
export class CommunityProviderPreflightError extends Error {
  /** Provider whose local CLI could not complete an authenticated read. */
  readonly provider: CommunityProvider;
  /** Stable local action classification. */
  readonly code:
    'CLI_NOT_FOUND' | 'ACCESS_DENIED' | 'KEY_KIND_UNSUPPORTED' | 'PROVIDER_UNAVAILABLE';

  /**
   * Create one actionable provider failure without copying provider output.
   *
   * @param provider - The service whose read failed.
   * @param code - What kind of failure it was.
   * @param access - For `ACCESS_DENIED` and `KEY_KIND_UNSUPPORTED`: the credential (and
   *   organization) to name. Without it either is worded, and coded, as unavailable.
   */
  constructor(
    provider: CommunityProvider,
    code: CommunityProviderPreflightError['code'],
    access?: CommunityPreflightAccess
  ) {
    const help = PROVIDER_HELP[provider];
    const message =
      code === 'CLI_NOT_FOUND'
        ? `${provider === 'fly' ? 'Fly CLI' : 'Neon CLI'} is required. Install it from ${help.install}`
        : code === 'KEY_KIND_UNSUPPORTED' && access
          ? // Only Neon answers this way (`isProviderKeyKindLimit`). It names the key's kind, not
            // the organization, so the message names the kinds that work instead.
            `Neon turned down one of the reads setup needs because of the kind of key ${access.env.NEON_API_KEY ? 'in NEON_API_KEY' : 'your Neon sign-in uses'}. Setup works with an organization key, a personal key, or a ${help.command} sign-in. ${help.auth}`
          : code === 'ACCESS_DENIED' && access
            ? provider === 'fly'
              ? // Fly answers `unauthorized` both for a token without access and for one that has
                // expired or was revoked, so the message names both.
                `${describeCommunityCredential('fly', access.env)} can't read organization ${access.organization}. It may have expired, or it may not have access there. Setup needs a token or sign-in that can create apps in it.`
              : `${describeCommunityCredential('neon', access.env)} can't read organization ${access.organization}. Setup needs a key or sign-in that can create projects in it.`
            : `${provider === 'fly' ? 'Fly' : 'Neon'} preflight is unavailable. Check provider status, CLI compatibility, and sign-in with ${help.command}, then retry. ${help.install}`;
    super(message);
    this.name = 'CommunityProviderPreflightError';
    this.provider = provider;
    this.code =
      (code === 'ACCESS_DENIED' || code === 'KEY_KIND_UNSUPPORTED') && !access
        ? 'PROVIDER_UNAVAILABLE'
        : code;
  }
}

/**
 * Turn a bounded provider-process failure into provider-specific preflight guidance.
 *
 * A read the service refused outright (see `isProviderAccessRefusal`) says so, naming the
 * credential and organization from `access`. For Fly that refusal also covers an expired or
 * revoked token, and the message says so. A read whose endpoint does not serve this kind of key
 * at all (see `isProviderKeyKindLimit`) says that instead, because the key may well reach the
 * organization. Any other failure keeps the general message, which fits an outage, an old CLI or
 * a missing sign-in.
 *
 * @param provider - The service whose read failed.
 * @param error - What the read threw.
 * @param access - The credential and organization the read used; without it a refusal is worded
 *   as unavailable.
 */
function describeCommunityProviderPreflightFailure(
  provider: CommunityProvider,
  error: unknown,
  access?: CommunityPreflightAccess
): CommunityProviderPreflightError {
  if (error instanceof CommunityProviderPreflightError) return error;
  if (error instanceof ProviderCommandError) {
    if (error.code === 'SPAWN')
      return new CommunityProviderPreflightError(provider, 'CLI_NOT_FOUND');
    if (error.refused && access) {
      return new CommunityProviderPreflightError(provider, 'ACCESS_DENIED', access);
    }
    if (error.keyKindLimited && access && provider === 'neon') {
      return new CommunityProviderPreflightError(provider, 'KEY_KIND_UNSUPPORTED', access);
    }
  }
  return new CommunityProviderPreflightError(provider, 'PROVIDER_UNAVAILABLE');
}

/**
 * Throw the preflight guidance for one failed read ({@link describeCommunityProviderPreflightFailure}).
 *
 * @param provider - The service whose read failed.
 * @param error - What the read threw.
 * @param access - The credential and organization the read used.
 */
export function classifyCommunityProviderPreflightFailure(
  provider: CommunityProvider,
  error: unknown,
  access?: CommunityPreflightAccess
): never {
  throw describeCommunityProviderPreflightFailure(provider, error, access);
}

/**
 * Which failure speaks when several preflight reads fail; lower speaks first. A missing CLI is
 * the first thing to fix; a refusal names the credential and organization; a key-kind limit names
 * the credential; "unavailable" is the catch-all, so it only speaks when nothing more specific
 * did (DOR-2700). Keyed by code, so a new code cannot go unranked.
 */
const PREFLIGHT_FAILURE_RANK: Readonly<Record<CommunityProviderPreflightError['code'], number>> = {
  CLI_NOT_FOUND: 0,
  ACCESS_DENIED: 1,
  KEY_KIND_UNSUPPORTED: 2,
  PROVIDER_UNAVAILABLE: 3,
};

function failureRank(reason: unknown): number {
  return reason instanceof CommunityProviderPreflightError
    ? PREFLIGHT_FAILURE_RANK[reason.code]
    : Object.keys(PREFLIGHT_FAILURE_RANK).length;
}

/**
 * Wait for every read, then resolve with all their values or reject with one failure chosen by
 * what failed, never by which read finished first: the most specific failure by
 * {@link PREFLIGHT_FAILURE_RANK}, and among equals the one listed first. So the same
 * outcomes always give the same message (DOR-2700, where a refusal and an "unavailable" raced).
 *
 * @param reads - The reads to settle, in a fixed order.
 * @returns Every read's value, in order.
 */
export async function settleCommunityPreflightReads<const T extends readonly unknown[]>(
  reads: T
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  const settled = await Promise.allSettled(reads);
  let chosen: PromiseRejectedResult | undefined;
  for (const result of settled) {
    if (result.status !== 'rejected') continue;
    if (!chosen || failureRank(result.reason) < failureRank(chosen.reason)) chosen = result;
  }
  if (chosen) throw chosen.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as {
    -readonly [P in keyof T]: Awaited<T[P]>;
  };
}

/**
 * Run one provider's preflight reads together and classify their failures for that provider, so
 * an access refusal from any read wins over another read being unavailable, whatever the order
 * they finish in.
 *
 * @param provider - The service the reads ask.
 * @param reads - The reads, in a fixed order.
 * @param access - The credential and organization the reads used, to word a refusal.
 * @returns Every read's value, in order.
 */
export function settleCommunityProviderPreflight<const T extends readonly unknown[]>(
  provider: CommunityProvider,
  reads: T,
  access?: CommunityPreflightAccess
): Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }> {
  return settleCommunityPreflightReads(
    reads.map((read) =>
      Promise.resolve(read).catch((error: unknown) =>
        classifyCommunityProviderPreflightFailure(provider, error, access)
      )
    )
  ) as Promise<{ -readonly [P in keyof T]: Awaited<T[P]> }>;
}

/** Stable local-version refusal. */
export class CommunityCliVersionError extends Error {
  /** CLI whose installed version is below the signed release minimum. */
  readonly cli: 'fly' | 'neonctl';

  /** Create a version error without local paths or command output. */
  constructor(cli: CommunityCliVersionError['cli']) {
    const link = cli === 'fly' ? PROVIDER_HELP.fly.install : PROVIDER_HELP.neon.install;
    super(
      `${cli} does not meet this space server release’s minimum version. Update it from ${link}`
    );
    this.name = 'CommunityCliVersionError';
    this.cli = cli;
  }
}

function compare(left: string, right: string): number {
  const tuple = (value: string) =>
    VersionSchema.parse(value).split('-', 1)[0]!.split('.').map(Number);
  const a = tuple(left);
  const b = tuple(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! !== b[index]!) return a[index]! - b[index]!;
  }
  return 0;
}

/** Read both installed versions and enforce the signed manifest minimums. */
export async function assertCommunityCliVersions(
  fly: FlySessionReadOptions,
  neon: NeonReadOptions,
  minimums: { fly: string; neon: string }
): Promise<void> {
  const [flyVersion, neonVersion] = await settleCommunityPreflightReads([
    settleCommunityProviderPreflight('fly', [
      runProviderCommand({
        ...fly,
        args: ['version', '--json'],
        parse: (stdout) => FlyVersionSchema.parse(JSON.parse(stdout)).Version,
      }),
    ]).then(([version]) => version),
    settleCommunityProviderPreflight('neon', [
      runProviderCommand({
        ...neon,
        args: ['--version'],
        parse: (stdout) => VersionSchema.parse(stdout.trim()),
      }),
    ]).then(([version]) => version),
  ]);
  if (compare(flyVersion.value, minimums.fly) < 0) throw new CommunityCliVersionError('fly');
  if (compare(neonVersion.value, minimums.neon) < 0) {
    throw new CommunityCliVersionError('neonctl');
  }
}
