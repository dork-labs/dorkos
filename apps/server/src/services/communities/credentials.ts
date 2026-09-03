/**
 * Per-community credential resolution — the one place a community's secret is
 * held, and the one place it is generated.
 *
 * Modelled directly on `resolveBetterAuthSecret`, because that function already
 * solved this problem for the Better Auth secret and its properties are exactly
 * the ones this needs: a machine-managed value in a `0600` file, generated on
 * first use, never logged, never surfaced in any UI, config file or API
 * response, and never passed across the `CommunityAdapter` port.
 *
 * Precedence: environment override → persisted file → generate-and-persist. The
 * generated file is created exclusively (`@dorkos/shared/secret-file`), so two
 * first uses at once settle on one credential rather than overwriting each
 * other's.
 *
 * Lax permissions are **repaired and warned**, never rejected: locking the owner
 * out of their own instance is the worse failure.
 *
 * @module services/communities/credentials
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { claimSecretText } from '@dorkos/shared/secret-file';
import { logger } from '../../lib/logger.js';

/** Directory under the dork home that holds one subdirectory per community. */
const COMMUNITIES_DIR = 'communities';

/** File name of a community's persisted credential, inside its own directory. */
const CREDENTIAL_FILE_NAME = 'credential';

/** Owner-only directory mode (`rwx------`). */
const DIR_MODE = 0o700;

/** Owner-only file mode (`rw-------`). */
const FILE_MODE = 0o600;

/** Number of random bytes a generated credential carries (256 bits). */
const CREDENTIAL_BYTES = 32;

/**
 * The environment variable that overrides one community's credential.
 *
 * A {@link CommunityRef} is path-safe by construction, so uppercasing it and
 * turning `-` into `_` yields a legal variable name for every legal ref.
 *
 * @param community - The community whose override to name.
 */
export function communityCredentialEnvVar(community: CommunityRef): string {
  return `DORKOS_COMMUNITY_SECRET_${String(community).toUpperCase().replace(/-/g, '_')}`;
}

/**
 * The directory that holds one community's machine-managed state.
 *
 * `dorkHome` is the single source of the data directory — `os.homedir()` is
 * banned here — and the ref's path-safety regex is what makes this join safe.
 *
 * @param dorkHome - The resolved DorkOS data directory.
 * @param community - The community whose directory to name.
 */
export function communityDir(dorkHome: string, community: CommunityRef): string {
  return path.join(dorkHome, COMMUNITIES_DIR, String(community));
}

/**
 * Resolve one community's credential, generating and persisting it on first
 * use.
 *
 * Never throws for the missing-credential case: a `credential:
 * 'machine-managed'` adapter must reach a terminal connection status with
 * nothing for a person to write down, which means there is no configuration
 * step that can be skipped.
 *
 * @param dorkHome - The resolved DorkOS data directory (from `resolveDorkHome`).
 * @param community - The community whose credential to resolve.
 * @returns The credential (hex string, or the operator's env value).
 * @throws If the credential file exists but is blank or unreadable. It is never
 *   overwritten: the remote side may already know whatever it holds.
 */
export function resolveCommunityCredential(dorkHome: string, community: CommunityRef): string {
  // eslint-disable-next-line no-restricted-syntax -- reading an env override, not a homedir path
  const fromEnv = process.env[communityCredentialEnvVar(community)]?.trim();
  if (fromEnv) return fromEnv;

  const dir = communityDir(dorkHome, community);
  const credentialPath = path.join(dir, CREDENTIAL_FILE_NAME);

  try {
    const persisted = fs.readFileSync(credentialPath, 'utf8').trim();
    if (persisted) {
      repairCommunityCredentialPermissions(credentialPath);
      return persisted;
    }
  } catch (err) {
    // ENOENT is the expected first-use case; anything else (e.g. EACCES) is
    // worth surfacing before we overwrite, but is still recoverable below.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('[Communities] Could not read a persisted credential; generating a new one', {
        path: credentialPath,
        error: (err as Error).message,
      });
    }
  }

  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  fs.chmodSync(dir, DIR_MODE);
  // Claimed, not just written: two processes reaching a fresh data directory
  // together can both read nothing here and both generate, and the loser would
  // keep authenticating with a credential that is no longer on disk (DOR-712).
  const claimed = claimSecretText(
    credentialPath,
    randomBytes(CREDENTIAL_BYTES).toString('hex'),
    FILE_MODE
  );
  if (claimed.minted) {
    // The path, never the value.
    logger.info('[Communities] Generated a machine-managed community credential', {
      path: credentialPath,
    });
  }
  return claimed.value;
}

/**
 * Ensure a persisted credential is owner-only on read.
 *
 * A file restored from a lax-permission backup, synced from a dotfiles repo, or
 * left by an older build under a loose umask can end up group- or
 * world-readable. Repair and warn rather than reject. On Windows, where POSIX
 * mode bits do not apply, this is a no-op.
 *
 * @param credentialPath - Absolute path to the persisted credential file.
 */
export function repairCommunityCredentialPermissions(credentialPath: string): void {
  if (process.platform === 'win32') return;
  try {
    const mode = fs.statSync(credentialPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      fs.chmodSync(credentialPath, FILE_MODE);
      logger.warn(
        '[Communities] A community credential was readable by other users; tightened it to owner-only (0600)',
        { path: credentialPath, previousMode: mode.toString(8) }
      );
    }
  } catch (err) {
    // A stat/chmod failure must never block a connection; the value already read.
    logger.warn('[Communities] Could not verify permissions on a community credential', {
      path: credentialPath,
      error: (err as Error).message,
    });
  }
}
