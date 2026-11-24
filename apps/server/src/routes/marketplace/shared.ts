/**
 * Marketplace routes: The request schemas, error mapping and refusals more than one marketplace route group uses.
 *
 * @module routes/marketplace/shared
 */
import type { Context } from 'hono';
import { readdir } from 'node:fs/promises';
import { z } from 'zod';
import {
  ConflictError,
  DisclosureChangedError,
  InvalidPackageError,
} from '../../services/marketplace/installer/errors.js';
import { DisclosedEffectsSchema } from '../../services/marketplace/preview/disclosed-effects.js';
import {
  ShipsRuntimeStateError,
  TreeUnhashableError,
} from '../../services/marketplace/lib/content-hash.js';
import {
  PackageNotFoundError,
  MarketplaceNotFoundError,
} from '../../services/marketplace/package-resolver.js';
import { PackageNotInstalledError } from '../../services/marketplace/flows/uninstall/support.js';
import { UnsupportedSourceUrlError } from '../../services/marketplace/sources/source-url-policy.js';
import {
  GitCommitNotFoundError,
  GitFetchError,
  GitRefNotFoundError,
  GitRemoteUnreachableError,
} from '../../services/marketplace/lib/git/git-tree.js';
import { PackageNotInstalledForUpdateError } from '../../services/marketplace/flows/update-selection.js';
import type { ApprovableUpdate } from '../../services/marketplace/flows/update-installed.js';
import {
  MarketplacePathError,
  PathEscapeError,
} from '../../services/marketplace/lib/package-paths.js';
import { BoundaryError } from '../../lib/boundary.js';
import { DevLinkError } from '../../services/marketplace/dev-links/errors.js';
import { AdapterError } from '../../services/relay/adapter-error.js';
import { readQuery } from '../../http/request-query.js';
import { logger } from '../../lib/logger.js';
import { problem, problemBody, sendProblem, validationProblem } from '@dorkos/http-kit';
import type { Problem } from '@dorkos/shared/problem';

/**
 * Body schema for `POST /api/marketplace/packages/:name/preview` and
 * `POST /api/marketplace/packages/:name/install` — everything on
 * {@link InstallRequest} except `name`, which is taken from the URL
 * param.
 */
export const InstallRequestBodySchema = z.object({
  marketplace: z.string().optional(),
  source: z.string().optional(),
  force: z.boolean().optional(),
  yes: z.boolean().optional(),
  projectPath: z.string().optional(),
  // What the person was shown the package runs (the preview's `disclosed`),
  // sent back untouched. The install refuses a package that now runs anything
  // else (DOR-2306); preview ignores it.
  approvedDisclosure: DisclosedEffectsSchema.optional(),
  // The preview's `contentHash`, sent back with the disclosure: a global
  // package loads into sessions only when its installed copy hashes the same.
  approvedContentHash: z.string().min(1).optional(),
  // An agent's install of a global package that runs anything waits on an
  // approval card; the retry carries its token (DOR-2306).
  confirmationToken: z.string().min(1).optional(),
});

/**
 * Whether a list request asked for each install's integrity (`?verify=true`,
 * DOR-2197). Opt-in, because verifying hashes every shipped file. A repeated
 * `verify` reads as an array, which is not a yes.
 *
 * @param c - The request.
 */
export function wantsVerify(c: Context): boolean {
  return readQuery(c).verify === 'true';
}

/**
 * Answer with the problem document {@link mapErrorToProblem} chose.
 *
 * @param c - The request to answer.
 * @param err - What was thrown.
 * @returns The sent response.
 */
export function errorResponse(c: Context, err: unknown): Response {
  return sendProblem(c, mapErrorToProblem(err));
}

/**
 * The `400` a body that does not fit its schema gets.
 *
 * @param c - The request to answer.
 * @param error - The schema's error.
 * @returns The sent response.
 */
export function validationFailed(c: Context, error: z.ZodError): Response {
  return validationProblem(c, error);
}

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
 * @param err - The error thrown by the installer, uninstall flow, update
 *   flow, resolver, or fetcher.
 * @returns The problem document to send; its `status` is the HTTP status.
 */
export function mapErrorToProblem(err: unknown): Problem {
  const mapped = knownProblem(err);
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
  // An adapter package whose name an app the person already connected is using
  // (DOR-2607): what a forced install gets instead of a 500 naming an internal id.
  if (err instanceof AdapterError && err.code === 'DUPLICATE_ID') {
    return problemBody('conflict', {
      detail:
        'An app with that name is already connected. Remove or rename it, then install again.',
    });
  }
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

/**
 * Whether a `POST /updates` body is one only an older client sends: an apply
 * with no `targets`, or with the retired `names` / `installPaths` selectors.
 */
export function fromOutdatedClient(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  return b.apply === true && (!('targets' in b) || 'names' in b || 'installPaths' in b);
}

/**
 * Answer a request from a client older than this server with a sentence that
 * says what to do, instead of a schema error (DOR-2306): updates now show what
 * each new version runs before anything is applied, which an old client cannot.
 */
export function outdatedClientResponse(c: Context): Response {
  return problem(c, 'invalid_request', {
    detail: 'Nothing was updated. Run npm install -g dorkos, then run the update again.',
  });
}

/** Why `POST /updates` ran nothing, as its gate decided. */
export type UpdateRefusal =
  /** What a reinstall would run now is not what the caller was shown. */
  | { kind: 'changed'; changed: ApprovableUpdate[] }
  /** A person has been asked; the caller retries with the token once they approve. */
  | { kind: 'pending'; token: string; updates: ApprovableUpdate[]; reason?: string }
  /** A person said no, or the card could not be raised honestly. */
  | { kind: 'declined'; reason: string };

/**
 * Answer a refused `POST /updates`: 409 when what would run moved since it was
 * shown, 202 while a person decides, 403 when they said no. Nothing was
 * reinstalled in any of them.
 *
 * @param c - The request to answer.
 * @param refusal - Why the apply ran nothing.
 * @returns The sent response.
 */
export function updateRefusalResponse(c: Context, refusal: UpdateRefusal): Response {
  switch (refusal.kind) {
    case 'changed':
      return problem(c, 'precondition_failed', {
        detail: 'Nothing was changed. A newer version arrived. Check again and review it.',
        extensions: { changed: refusal.changed },
      });
    case 'pending':
      return c.json(
        {
          status: 'requires_confirmation',
          confirmationToken: refusal.token,
          updates: refusal.updates,
          message:
            `${refusal.reason ? `${refusal.reason} ` : ''}A person must approve these updates in ` +
            'DorkOS before anything is reinstalled. Send the same request again with this ' +
            'confirmationToken once they have.',
        },
        202
      );
    case 'declined':
      return problem(c, 'declined', {
        detail: 'A person said no, or the approval ended. Nothing was updated.',
      });
  }
}

/** `fs.readdir` that swallows ENOENT so callers can walk optional trees. */
export async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
