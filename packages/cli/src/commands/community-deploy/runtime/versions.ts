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
  readonly code: 'CLI_NOT_FOUND' | 'AUTH_REQUIRED' | 'ACCESS_DENIED' | 'PROVIDER_UNAVAILABLE';

  /**
   * Create one actionable provider failure without copying provider output.
   *
   * @param provider - The service whose read failed.
   * @param code - What kind of failure it was.
   * @param access - For `ACCESS_DENIED`: the credential and organization to name.
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
        : code === 'AUTH_REQUIRED'
          ? `${provider === 'fly' ? 'Fly' : 'Neon'} sign-in is required. Run ${help.command}, then retry. ${help.auth}`
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
    this.code = code === 'ACCESS_DENIED' && !access ? 'PROVIDER_UNAVAILABLE' : code;
  }
}

/**
 * Convert a bounded provider-process failure into provider-specific preflight guidance.
 *
 * A read the service refused outright (see `isProviderAccessRefusal`) says so, naming the
 * credential and organization from `access`. For Fly that refusal also covers an expired or
 * revoked token, and the message says so. Any other failure keeps the general message, which
 * fits an outage, an old CLI or a missing sign-in.
 *
 * @param provider - The service whose read failed.
 * @param error - What the read threw.
 * @param access - The credential and organization the read used; without it a refusal is worded
 *   as unavailable.
 */
export function classifyCommunityProviderPreflightFailure(
  provider: CommunityProvider,
  error: unknown,
  access?: CommunityPreflightAccess
): never {
  if (error instanceof CommunityProviderPreflightError) throw error;
  if (error instanceof ProviderCommandError) {
    if (error.code === 'SPAWN')
      throw new CommunityProviderPreflightError(provider, 'CLI_NOT_FOUND');
    if (error.refused && access) {
      throw new CommunityProviderPreflightError(provider, 'ACCESS_DENIED', access);
    }
  }
  throw new CommunityProviderPreflightError(provider, 'PROVIDER_UNAVAILABLE');
}

/** Stable local-version refusal. */
export class CommunityCliVersionError extends Error {
  /** CLI whose installed version is below the signed release minimum. */
  readonly cli: 'fly' | 'neonctl';

  /** Create a version error without local paths or command output. */
  constructor(cli: CommunityCliVersionError['cli']) {
    const link = cli === 'fly' ? PROVIDER_HELP.fly.install : PROVIDER_HELP.neon.install;
    super(`${cli} does not meet this Community release's minimum version. Update it from ${link}`);
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
  const [flyVersion, neonVersion] = await Promise.all([
    runProviderCommand({
      ...fly,
      args: ['version', '--json'],
      parse: (stdout) => FlyVersionSchema.parse(JSON.parse(stdout)).Version,
    }).catch((error: unknown) => classifyCommunityProviderPreflightFailure('fly', error)),
    runProviderCommand({
      ...neon,
      args: ['--version'],
      parse: (stdout) => VersionSchema.parse(stdout.trim()),
    }).catch((error: unknown) => classifyCommunityProviderPreflightFailure('neon', error)),
  ]);
  if (compare(flyVersion.value, minimums.fly) < 0) throw new CommunityCliVersionError('fly');
  if (compare(neonVersion.value, minimums.neon) < 0) {
    throw new CommunityCliVersionError('neonctl');
  }
}
