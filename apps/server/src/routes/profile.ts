/**
 * The operator's own profile — their photo and what they want to be called
 * (spec `identity-consistency` §W3.3, §W3.5, ADR 260806-222546).
 *
 * Thin by the route rule, and thin in a specific way: **it never touches a
 * path**. Bytes go to an {@link AvatarStore}, a URL comes back, and that URL is
 * written to both identity records verbatim. Swap the store for one backed by a
 * bucket and this file does not change — which is the point of the seam and the
 * thing `profile-avatar.test.ts` asserts rather than assumes.
 *
 * **Every write here lands in two places at once**, because one identity split
 * across two records is how an account and a roster come to disagree about the
 * same person. A photo goes to `authors.image_url` (what the roster and every
 * room renderer read) and Better Auth's `user.image` (what the account record
 * holds). A name goes to `user.name` and `config.profile.displayName` — the
 * top two rungs of the ladder in `services/identity/operator-profile.ts`, and
 * NOT the author record; the PATCH handler says why at length.
 *
 * @module routes/profile
 */
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import {
  ProfileUpdateRequestSchema,
  type ProfileAvatarResponse,
  type ProfileUpdateResponse,
} from '@dorkos/shared/team-schemas';
import { logError, logger } from '../lib/logger.js';
import { parseBody, sendError } from '../lib/route-utils.js';
import type { AuthorRecord, AuthorRegistry } from '../services/rooms/author-registry.js';
import { sendRoomError } from './room-error-response.js';
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
   *
   * It THROWS a `RoomError` for a caller presenting an agent token the machine
   * could not verify (DOR-1361), which `operatorOrRefuse` answers through the
   * rooms domain's own status table so the 401 reads the same here as on a room
   * route. Still injected rather than imported, because what this router must
   * not reach for is the room SERVICE — resolving a caller mints author rows.
   */
  caller: (req: Pick<Request, 'headers'>, res: Pick<Response, 'locals'>) => AuthorRecord;
  /**
   * The rooms domain's author registry: the render cache every surface reads,
   * plus the one question that decides whether the account record is this
   * author's to write.
   */
  authors: Pick<AuthorRegistry, 'setImageUrl' | 'isOwner'>;
  /** The account that owns this install, or `null` when nobody has registered. */
  ownerAccount: () => { id: string } | null;
  /** Write Better Auth's `user.image`, so the account record agrees with the roster. */
  setAccountImage: (userId: string, imageUrl: string | null) => void;
  /**
   * Write Better Auth's `user.name` — the FIRST thing the roster's name
   * precedence reads (`operator-profile.ts`), so on an install with an account
   * this is the only write that can change what a person is called.
   */
  setAccountName: (userId: string, name: string) => void;
  /**
   * Write `config.profile.displayName` — the SECOND thing that precedence
   * reads, and the only durable one on an install with login off, which is the
   * default (ADR-0320).
   */
  setProfileDisplayName: (displayName: string) => void;
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
  // `+ 1` because busboy refuses a file that REACHES `fileSize`, not one that
  // exceeds it: measured, `fileSize: MAX_AVATAR_BYTES` turns away a file of
  // exactly 2 MB, which makes the cap `< 2 MB` while the spec and the error
  // message both say `≤ 2 MB`. One byte higher is the limit those words mean.
  limits: { fileSize: MAX_AVATAR_BYTES + 1, files: 1 },
}).single('avatar');

/** The form field the photo arrives in. */
const AVATAR_FIELD = 'avatar';

/**
 * Create the profile router.
 *
 * @param deps - The avatar store, the caller resolver, and the four identity
 *   writers: the two the photo lands in and the two the name does.
 * @returns Express Router serving `PATCH /api/profile` and
 *   `POST`/`DELETE`/`GET /api/profile/avatar`.
 */
export function createProfileRouter(deps: ProfileRouterDeps): Router {
  const router = Router();

  /**
   * The operator, or `null` after answering the refusal an agent gets.
   *
   * Two refusals for two different facts: 401 for a caller whose agent token
   * this machine could not verify — a credential problem, and a working token is
   * what would change the answer — and 403 for an agent that IS named, which no
   * credential fixes because a profile is a person's.
   *
   * @param req - The incoming request, for the raw agent header.
   * @param res - The response, carrying whatever the caller presented.
   * @param subject - What the agent was trying to change, so the refusal names
   *   the thing it refused rather than the route it arrived at.
   */
  function operatorOrRefuse(req: Request, res: Response, subject: string): AuthorRecord | null {
    let caller: AuthorRecord;
    try {
      caller = deps.caller(req, res);
    } catch (err) {
      // The rooms domain's own mapping, shared rather than mirrored, exactly as
      // `read-cursors.ts` shares it: a refusal that reads one way on a room
      // route and another here would be two answers to one question.
      sendRoomError(res, err, 'profile caller');
      return null;
    }
    if (caller.kind !== 'human') {
      sendError(res, 403, `Only a person can change a profile ${subject}.`, 'OPERATOR_ONLY');
      return null;
    }
    return caller;
  }

  /**
   * Point both identity records at the same URL — or at nothing.
   *
   * **The account record is written FIRST**, and the order is deliberate. The
   * two writes are not in one transaction, so a failure between them orphans one
   * of them; putting the account first means the survivor is the roster row,
   * which is the surface a person actually looks at. Failing the other way round
   * would leave a photo on the account nothing displays.
   *
   * **`user.image` is only touched when this author IS the owner.** Under ADR
   * 260727-184933 D6 nobody else can exist locally, but `room-caller.ts`
   * deliberately checks that invariant instead of assuming it, and the cost of
   * assuming is higher here: a second human author would otherwise overwrite —
   * or clear — the OWNER's account photo with their own.
   */
  function writeImageUrl(authorId: string, imageUrl: string | null): void {
    const owner = deps.ownerAccount();
    // No account means no `user` row to keep in step — an install with login off
    // has a roster and no account record, which is a supported state, not a gap.
    if (owner && deps.authors.isOwner(authorId, owner.id)) {
      deps.setAccountImage(owner.id, imageUrl);
    }
    deps.authors.setImageUrl(authorId, imageUrl);
  }

  /**
   * PATCH / — what the operator wants to be called.
   *
   * **Two writes, and deliberately NOT the two the spec's one-line table named.**
   * §W3.3 says "the operator's author record + Better Auth `user.name`". Writing
   * `authors.display_name` was tried against the merged code and does not hold:
   *
   * 1. On an install with login off — the default — `resolveCaller` answers with
   *    `AuthorRegistry.localHuman()`, which resolves the row with the literal
   *    `'You'` and refreshes the cached `displayName` on every single request.
   *    A name written there survives until the next API call, which is to say
   *    it does not survive.
   * 2. On an install with an account, `bindOwner` documents at length why it
   *    never touches `displayName`: the column is one render cache per author,
   *    so writing a name into it does not label the person going forward, it
   *    relabels every message they have ever posted, retroactively.
   *
   * So this writes the two sources `services/identity/operator-profile.ts`
   * actually reads *above* the author record — the account name and the stored
   * profile — which is the same "both records or neither" rule the avatar
   * writes follow, applied to the precedence that exists rather than the one
   * the table assumed. The author record keeps saying `'You'`, which is still
   * the right word from the operator's own seat in a room.
   *
   * **Both writes are behind one ownership check**, which is `writeImageUrl`'s
   * argument applied to a value that needs it more. `config.profile.displayName`
   * is install-global rather than per-author, so a second human author saving
   * their own name would rewrite the OWNER's roster row. ADR 260727-184933 D6
   * says no such person can exist locally; `room-caller.ts` checks that
   * invariant anyway rather than assuming it, and so does this.
   */
  router.patch('/', (req, res) => {
    const operator = operatorOrRefuse(req, res, 'name');
    if (!operator) return;
    const body = parseBody(ProfileUpdateRequestSchema, req.body, res);
    if (!body) return;

    const owner = deps.ownerAccount();
    // `null` is a real answer, not a missing one: with no account the `'local'`
    // sentinel IS the owner, which is what keeps the default install working.
    if (!deps.authors.isOwner(operator.id, owner?.id ?? null)) {
      return sendError(
        res,
        403,
        'Only the person who owns this install can change this name.',
        'OPERATOR_ONLY'
      );
    }

    if (owner) deps.setAccountName(owner.id, body.displayName);
    deps.setProfileDisplayName(body.displayName);

    // Echoed rather than re-resolved: both sources above the author record now
    // hold this string, so the precedence cannot answer with anything else.
    return res.json({ displayName: body.displayName } satisfies ProfileUpdateResponse);
  });

  // POST /avatar — replace the operator's photo.
  router.post('/avatar', (req, res) => {
    // Resolved BEFORE multer runs: an agent's upload is refused without its
    // bytes ever being read.
    const operator = operatorOrRefuse(req, res, 'photo');
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
    const operator = operatorOrRefuse(req, res, 'photo');
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
