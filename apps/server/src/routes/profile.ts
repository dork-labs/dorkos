/**
 * The operator's own profile — today, their photo (spec `identity-consistency`
 * §W3.5, ADR 260806-222546).
 *
 * Thin by the route rule, and thin in a specific way: **it never touches a
 * path**. Bytes go to an {@link AvatarStore}, a URL comes back, and that URL is
 * written to both identity records verbatim. Swap the store for one backed by a
 * bucket and this file does not change — which is the point of the seam and the
 * thing `profile-avatar.test.ts` asserts rather than assumes.
 *
 * Two writes per upload, deliberately: `authors.image_url` is what the roster
 * and every room renderer read, and Better Auth's `user.image` is what the
 * account record holds. Writing one without the other is how an account and a
 * roster come to disagree about what somebody looks like.
 *
 * @module routes/profile
 */
import { Router, type Response } from 'express';
import multer from 'multer';
import type { ProfileAvatarResponse } from '@dorkos/shared/team-schemas';
import { logError, logger } from '../lib/logger.js';
import { sendError } from '../lib/route-utils.js';
import type { AuthorRecord, AuthorRegistry } from '../services/rooms/author-registry.js';
import {
  InvalidAvatarIdError,
  MAX_AVATAR_BYTES,
  sniffAvatarContentType,
  type AvatarStore,
} from '../services/identity/avatar-store.js';

/** What the profile router needs. Every seam is injected; none is reached for. */
export interface ProfileRouterDeps {
  /** Where photos live. The route knows nothing else about storage. */
  avatars: AvatarStore;
  /**
   * Who this request is — `resolveCaller`, the same answer the room routes get.
   * An agent resolves to itself here, which is exactly how it gets refused.
   */
  caller: (res: Pick<Response, 'locals'>) => AuthorRecord;
  /** The rooms domain's author registry: the render cache every surface reads. */
  authors: Pick<AuthorRegistry, 'setImageUrl'>;
  /** The account that owns this install, or `null` when nobody has registered. */
  ownerAccount: () => { id: string } | null;
  /** Write Better Auth's `user.image`, so the account record agrees with the roster. */
  setAccountImage: (userId: string, imageUrl: string | null) => void;
}

/**
 * The multipart parser for exactly one photo.
 *
 * **Dedicated rather than reused.** `routes/uploads.ts` builds its multer from
 * the user's upload config and writes into a session's working directory; both
 * are wrong for a photo, which is per-install, permanent, and capped by a rule
 * nobody may raise from `config.json`.
 *
 * Memory storage, because the bytes have to be sniffed before anything decides
 * where they go — and `limits.fileSize` refuses an oversized upload while it is
 * still being read, so nothing over the cap is ever held or written.
 */
const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
}).single('avatar');

/** The form field the photo arrives in. */
const AVATAR_FIELD = 'avatar';

/**
 * Create the profile router.
 *
 * @param deps - The store, the caller resolver and the two identity writers.
 * @returns Express Router serving `/api/profile/avatar`.
 */
export function createProfileRouter(deps: ProfileRouterDeps): Router {
  const router = Router();

  /** The operator, or `null` after answering the refusal an agent gets. */
  function operatorOrRefuse(res: Response): AuthorRecord | null {
    const caller = deps.caller(res);
    if (caller.kind !== 'human') {
      sendError(res, 403, 'Only a person can change a profile photo.', 'OPERATOR_ONLY');
      return null;
    }
    return caller;
  }

  /** Point both identity records at the same URL — or at nothing. */
  function writeImageUrl(authorId: string, imageUrl: string | null): void {
    deps.authors.setImageUrl(authorId, imageUrl);
    const owner = deps.ownerAccount();
    // No account means no `user` row to keep in step — an install with login off
    // has a roster and no account record, which is a supported state, not a gap.
    if (owner) deps.setAccountImage(owner.id, imageUrl);
  }

  // POST /avatar — replace the operator's photo.
  router.post('/avatar', (req, res) => {
    // Resolved BEFORE multer runs: an agent's upload is refused without its
    // bytes ever being read.
    const operator = operatorOrRefuse(res);
    if (!operator) return;

    uploadAvatar(req, res, async (err: unknown) => {
      if (err) return sendUploadError(res, err);

      const file = req.file;
      if (!file) {
        return sendError(
          res,
          400,
          `Attach the image as the '${AVATAR_FIELD}' field.`,
          'AVATAR_MISSING'
        );
      }

      // The bytes decide, never the filename or the Content-Type the client
      // claimed — both are written by whoever is uploading.
      const contentType = sniffAvatarContentType(file.buffer);
      if (!contentType) {
        return sendError(
          res,
          415,
          'That file is not a PNG, JPEG, or WebP image.',
          'AVATAR_TYPE_UNSUPPORTED'
        );
      }

      try {
        const { url } = await deps.avatars.put(operator.id, file.buffer, contentType);
        writeImageUrl(operator.id, url);
        return res.json({ imageUrl: url } satisfies ProfileAvatarResponse);
      } catch (storeErr) {
        return sendStoreError(res, storeErr, 'POST /avatar');
      }
    });
  });

  // DELETE /avatar — remove it from the store and from both records.
  router.delete('/avatar', async (req, res) => {
    const operator = operatorOrRefuse(res);
    if (!operator) return;
    try {
      await deps.avatars.delete(operator.id);
      writeImageUrl(operator.id, null);
      return res.status(204).end();
    } catch (err) {
      return sendStoreError(res, err, 'DELETE /avatar');
    }
  });

  // GET /avatar/:id — serve one. The `?v=<hash>` the stored URL carries is what
  // makes a replaced photo appear at once without turning caching off.
  router.get('/avatar/:id', async (req, res) => {
    let stored;
    try {
      stored = await deps.avatars.get(req.params.id);
    } catch (err) {
      return sendStoreError(res, err, 'GET /avatar/:id');
    }
    if (!stored) return sendError(res, 404, 'No photo for that identity.', 'AVATAR_NOT_FOUND');

    res.setHeader('Content-Type', stored.contentType);
    // An image served from a URL a person can influence is exactly where a
    // sniffing browser turns a photo into a document.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('ETag', stored.etag);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

    if (req.headers['if-none-match'] === stored.etag) {
      stored.stream.destroy();
      return res.status(304).end();
    }

    stored.stream.on('error', (streamErr) => {
      logger.error('[Profile] avatar stream failed', logError(streamErr));
      if (!res.headersSent) sendError(res, 500, 'Could not read that photo.', 'AVATAR_READ_FAILED');
      else res.destroy(streamErr);
    });
    stored.stream.pipe(res);
  });

  return router;
}

/** Turn a multer refusal into the answer the person who uploaded should see. */
function sendUploadError(res: Response, err: unknown): void {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const megabytes = MAX_AVATAR_BYTES / 1024 / 1024;
      return sendError(res, 413, `That image is larger than ${megabytes} MB.`, 'AVATAR_TOO_LARGE');
    }
    return sendError(res, 400, `Send one image as '${AVATAR_FIELD}'.`, 'AVATAR_UPLOAD_REJECTED');
  }
  logger.error('[Profile] avatar upload failed', logError(err));
  sendError(res, 400, 'That upload could not be read.', 'AVATAR_UPLOAD_REJECTED');
}

/** Turn a store failure into a status. An unusable id is the caller's fault. */
function sendStoreError(res: Response, err: unknown, where: string): void {
  if (err instanceof InvalidAvatarIdError) {
    return sendError(res, 400, 'That is not a usable identity id.', 'AVATAR_ID_INVALID');
  }
  logger.error(`[Profile] ${where} failed`, logError(err));
  sendError(res, 500, 'Could not store that photo.', 'AVATAR_STORE_FAILED');
}
