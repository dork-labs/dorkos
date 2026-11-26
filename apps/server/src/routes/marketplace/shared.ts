/**
 * Marketplace routes: The request schemas, error answers and refusals more than one marketplace route group uses.
 *
 * @module routes/marketplace/shared
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { DisclosedEffectsSchema } from '../../services/marketplace/preview/disclosed-effects.js';
import type { ApprovableUpdate } from '../../services/marketplace/flows/update-installed.js';
import { problem, problemBody, sendProblem, validationProblem } from '@dorkos/http-kit';
import type { Problem } from '@dorkos/shared/problem';
import { marketplaceProblemOf } from '../../services/marketplace/lib/error-problem.js';
import { AdapterError } from '../../services/relay/adapter-error.js';

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
 * An adapter package whose name an app the person already connected is using
 * (DOR-2607): what a forced install gets instead of a 500 naming an internal id.
 */
function adapterClash(err: unknown): Problem | null {
  if (!(err instanceof AdapterError) || err.code !== 'DUPLICATE_ID') return null;
  return problemBody('conflict', {
    detail: 'An app with that name is already connected. Remove or rename it, then install again.',
  });
}

/**
 * The problem document a marketplace route answers an error with: the
 * marketplace's own mapping (`services/marketplace/lib/error-problem.ts`),
 * plus a chat app connection's name clash, which an install can meet.
 *
 * @param err - What was thrown.
 * @returns The problem document; its `status` is the HTTP status.
 */
export function mapErrorToProblem(err: unknown): Problem {
  return marketplaceProblemOf(err, adapterClash);
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
