/**
 * What a marketplace error answers over HTTP: a problem document with a fixed
 * sentence, shared by the hand routes (`routes/marketplace/*`) and the reads
 * the capability mount serves (`../doors/`).
 *
 * @module services/marketplace/lib/error-problem
 */
import { problemBody } from '@dorkos/http-kit';
import type { Problem } from '@dorkos/shared/problem';
import { ConflictError, DisclosureChangedError, InvalidPackageError } from '../installer/errors.js';
import { ShipsRuntimeStateError, TreeUnhashableError } from './content-hash.js';
import { PackageNotFoundError, MarketplaceNotFoundError } from '../package-resolver.js';
import { PackageNotInstalledError } from '../flows/uninstall/support.js';
import { UnsupportedSourceUrlError } from '../sources/source-url-policy.js';
import {
  GitCommitNotFoundError,
  GitFetchError,
  GitRefNotFoundError,
  GitRemoteUnreachableError,
} from './git/git-tree.js';
import { PackageNotInstalledForUpdateError } from '../flows/update-selection.js';
import { MarketplacePathError, PathEscapeError } from './package-paths.js';
import { BoundaryError } from '../../../lib/boundary.js';
import { DevLinkError } from '../dev-links/errors.js';
import { logger } from '../../../lib/logger.js';

/**
 * Centralized error → problem document mapping. Shared by every
 * install-related handler so the translation rules stay in one place and the
 * telemetry remains consistent across endpoints.
 *
 * Every `detail` is a fixed sentence: an error's own message can name a cache
 * folder under the operator's home, a remote, or a staged path, so it goes to
 * the server log and never to the caller (DOR-4979). Structured facts the
 * caller acts on (`errors`, `codes`, `conflicts`, `packageNames`) ride as
 * extension members.
 *
 * An error another domain throws through an install (a chat app connection's
 * clash, say) is mapped by the caller's own `known`, so this module imports
 * no other domain (`routes/marketplace/shared.ts` passes it).
 *
 * @param err - The error thrown by the installer, uninstall flow, update
 *   flow, resolver, or fetcher.
 * @param known - The caller's own mapping, tried first; `null` for an error it does not know.
 * @returns The problem document to send; its `status` is the HTTP status.
 */
export function marketplaceProblemOf(
  err: unknown,
  known: (err: unknown) => Problem | null = () => null
): Problem {
  const mapped = known(err) ?? knownProblem(err);
  if (mapped) {
    logger.info('[Marketplace] request refused', {
      code: mapped.code,
      error: err instanceof Error ? err.message : String(err),
    });
    return mapped;
  }
  logger.error('[Marketplace] request failed', err);
  return problemBody('internal_error', {
    detail: 'Something went wrong on the DorkOS side. Try again.',
  });
}

/** The problem for an error the marketplace knows, or `null` for a fault of its own. */
function knownProblem(err: unknown): Problem | null {
  if (err instanceof InvalidPackageError) {
    return problemBody('invalid_request', {
      detail: "That package isn't valid. `errors` lists what failed.",
      extensions: { errors: err.errors, ...(err.codes.length > 0 ? { codes: err.codes } : {}) },
    });
  }
  // A containment assertion fired somewhere below: its message names the root
  // the path escaped, which spells the operator's home directory.
  if (err instanceof PathEscapeError) {
    return problemBody('invalid_request', {
      detail: 'That path resolves outside its own folder. Nothing was changed.',
    });
  }
  if (err instanceof MarketplacePathError) {
    return problemBody('invalid_request', {
      detail: "That package or marketplace name can't be used. Pick another.",
    });
  }
  // Reached when the boundary refusal comes from INSIDE the install pipeline —
  // a `./local/path` install identifier pointing outside the boundary — rather
  // than from the body's `projectPath`, which each handler checks up front.
  if (err instanceof BoundaryError) {
    return problemBody('outside_boundary', { detail: 'Pick a folder DorkOS may use.' });
  }
  if (err instanceof ConflictError) {
    return problemBody('conflict', {
      detail: 'Installing would clash with what is already here. See `conflicts`.',
      extensions: { conflicts: err.conflicts },
    });
  }
  // A dev link refused, or an install, update or uninstall that would have
  // replaced one (DOR-2696).
  if (err instanceof DevLinkError) return err.toProblem();
  // A package that ships DorkOS's own settings, secrets or records path, or a
  // file whose bytes cannot be pinned (DOR-2306).
  if (err instanceof ShipsRuntimeStateError || err instanceof TreeUnhashableError) {
    return problemBody('invalid_request', {
      detail: "This package ships files DorkOS can't install. Nothing was written.",
    });
  }
  // The package that resolved for the install is not the one the person was shown.
  if (err instanceof DisclosureChangedError) {
    return problemBody('precondition_failed', {
      detail: 'This package changed what it runs since you looked. Review it again.',
    });
  }
  if (err instanceof PackageNotInstalledForUpdateError) {
    return problemBody('not_found', {
      detail: "Some of those packages aren't installed here.",
      extensions: { packageNames: err.packageNames, installPaths: err.installPaths },
    });
  }
  if (err instanceof PackageNotInstalledError) {
    return problemBody('not_found', { detail: "That package isn't installed here." });
  }
  if (err instanceof PackageNotFoundError) {
    return problemBody('not_found', { detail: 'No configured marketplace lists that package.' });
  }
  if (err instanceof MarketplaceNotFoundError) {
    return problemBody('not_found', { detail: "That marketplace isn't configured. Add it first." });
  }
  // A configured marketplace whose address is not one DorkOS hands to `git` (DOR-1710).
  if (err instanceof UnsupportedSourceUrlError) return unsupportedSourceProblem();
  // Git's own failures (DOR-2248): a missing branch, tag or commit is a
  // not-found; a remote that could not be reached or verified is a bad gateway.
  if (err instanceof GitRefNotFoundError || err instanceof GitCommitNotFoundError) {
    return problemBody('not_found', { detail: "That version isn't in the package's repository." });
  }
  if (err instanceof GitRemoteUnreachableError || err instanceof GitFetchError) {
    return problemBody('upstream_unavailable', {
      detail: "Couldn't reach the package's repository. Try again.",
    });
  }
  return null;
}

/**
 * The refusal for a marketplace address DorkOS will not fetch from: the forms
 * that do work, never the address itself.
 *
 * @returns The problem document.
 */
export function unsupportedSourceProblem(): Problem {
  return problemBody('invalid_request', {
    detail: "DorkOS can't fetch from that address. Use an https:// or file:// address.",
  });
}
