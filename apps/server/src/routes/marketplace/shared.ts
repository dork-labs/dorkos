/**
 * Marketplace routes: The request schemas, error mapping and refusals more than one marketplace route group uses.
 *
 * @module routes/marketplace/shared
 */
import type { Request, Response } from 'express';
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

/** Machine-readable code on the 403 for a batch that would need approval per install. */
export const BATCH_UPDATE_NEEDS_APPROVAL_CODE = 'batch_update_needs_approval';

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
 * Machine-readable code on the 409 when what a package runs is not what the
 * caller was shown: an update whose new version moved since the check, or an
 * install whose package changed since the preview (DOR-2306).
 */
const DISCLOSURE_CHANGED_CODE = 'disclosure_changed';

/**
 * Whether a list request asked for each install's integrity (`?verify=true`,
 * DOR-2197). Opt-in, because verifying hashes every shipped file.
 *
 * @param req - The request.
 */
export function wantsVerify(req: Request): boolean {
  return req.query.verify === 'true';
}

/**
 * Centralized error → HTTP status mapping. Shared by every install-related
 * handler so the translation rules stay in one place and the telemetry
 * remains consistent across endpoints.
 *
 * @param err - The error thrown by the installer, uninstall flow, update
 *   flow, resolver, or fetcher.
 * @returns The HTTP status and response body to send.
 */
export function mapErrorToStatus(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof InvalidPackageError) {
    return { status: 400, body: { error: err.message, errors: err.errors } };
  }
  // A containment assertion fired somewhere below. Its message names the root
  // the path escaped — a cache directory under dorkHome, which spells the
  // operator's home directory and therefore their username — so the body says
  // the path was refused and nothing about where anything lives. The full
  // message still reaches the server log through the handler's `logger.error`.
  if (err instanceof PathEscapeError) {
    return { status: 400, body: { error: 'Refused: that path resolves outside its own folder' } };
  }
  // A name the caller may not use. Echoed back on purpose, unlike the above:
  // the only thing this message contains is the name the caller just sent, and
  // saying which one was rejected is what makes the 400 actionable.
  if (err instanceof MarketplacePathError) {
    return { status: 400, body: { error: err.message } };
  }
  // Reached when the boundary refusal comes from INSIDE the install pipeline —
  // a `./local/path` install identifier pointing outside the boundary — rather
  // than from the body's `projectPath`, which each handler checks up front with
  // its own message.
  if (err instanceof BoundaryError) {
    return { status: 403, body: { error: 'Access denied: path outside directory boundary' } };
  }
  if (err instanceof ConflictError) {
    return { status: 409, body: { error: err.message, conflicts: err.conflicts } };
  }
  // A package that ships DorkOS's own settings, secrets or records path, or a file
  // whose bytes cannot be pinned: refused before anything is written, and the
  // message says which path (DOR-2306). Package-relative, so nothing about
  // where it was staged leaks.
  if (err instanceof ShipsRuntimeStateError || err instanceof TreeUnhashableError) {
    return { status: 400, body: { error: err.message } };
  }
  // The package that resolved for the install is not the one the person was
  // shown. Nothing was written; the next move is to look again.
  if (err instanceof DisclosureChangedError) {
    return { status: 409, body: { error: err.message, code: DISCLOSURE_CHANGED_CODE } };
  }
  if (err instanceof PackageNotInstalledError) {
    return { status: 404, body: { error: err.message } };
  }
  if (err instanceof PackageNotInstalledForUpdateError) {
    return {
      status: 404,
      body: { error: err.message, packageNames: err.packageNames, installPaths: err.installPaths },
    };
  }
  if (err instanceof PackageNotFoundError) {
    return { status: 404, body: { error: err.message } };
  }
  if (err instanceof MarketplaceNotFoundError) {
    return { status: 404, body: { error: err.message } };
  }
  // A configured marketplace whose address is not one we will hand to `git`
  // (DOR-1710). Its message is written for the person reading it and says which
  // forms do work, so it goes back verbatim.
  if (err instanceof UnsupportedSourceUrlError) {
    return { status: 400, body: { error: err.message } };
  }
  // Git's own failures (DOR-2248). A branch, tag or commit the repository does
  // not have is a not-found; a remote that could not be reached, or a fetch that
  // failed or could not be verified, is the upstream's fault — a bad gateway.
  // Each message already says what went wrong in words, and names the remote
  // without credentials, so it goes back verbatim.
  if (err instanceof GitRefNotFoundError || err instanceof GitCommitNotFoundError) {
    return { status: 404, body: { error: err.message } };
  }
  if (err instanceof GitRemoteUnreachableError || err instanceof GitFetchError) {
    return { status: 502, body: { error: err.message } };
  }
  return {
    status: 500,
    body: { error: err instanceof Error ? err.message : String(err) },
  };
}

/** Machine-readable code for a request only an older dorkos CLI sends. */
const OUTDATED_CLIENT_CODE = 'client_outdated';

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
export function outdatedClientResponse(res: Response): Response {
  return res.status(400).json({
    error:
      'This dorkos CLI is older than the DorkOS it is talking to, so nothing was updated. ' +
      'Update the CLI (npm install -g dorkos), then run the update again: it now shows what ' +
      'each new version runs before it installs anything.',
    code: OUTDATED_CLIENT_CODE,
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
 * @param res - The response to answer on.
 * @param refusal - Why the apply ran nothing.
 * @returns The sent response.
 */
export function updateRefusalResponse(res: Response, refusal: UpdateRefusal): Response {
  switch (refusal.kind) {
    case 'changed':
      return res.status(409).json({
        error:
          'What an update would install is not what was shown: a newer version arrived, or the ' +
          'new version now runs something else. Nothing was changed. Check again and review it.',
        code: DISCLOSURE_CHANGED_CODE,
        changed: refusal.changed,
      });
    case 'pending':
      return res.status(202).json({
        status: 'requires_confirmation',
        confirmationToken: refusal.token,
        updates: refusal.updates,
        message:
          `${refusal.reason ? `${refusal.reason} ` : ''}A person must approve these updates in ` +
          'DorkOS before anything is reinstalled. Send the same request again with this ' +
          'confirmationToken once they have.',
      });
    case 'declined':
      return res.status(403).json({ status: 'declined', reason: refusal.reason });
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
