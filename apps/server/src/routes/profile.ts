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
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { DisplayNameSource } from '@dorkos/shared/config-schema';
import {
  ProfileUpdateRequestSchema,
  type ProfileAvatarResponse,
  type ProfileUpdateResponse,
} from '@dorkos/shared/team-schemas';
import { logError, logger } from '../lib/logger.js';
import { discardStream, errorBody, validationFailureBody } from '../lib/route-utils.js';
import type { AuthorRecord, AuthorRegistry } from '../services/rooms/author-registry.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
import { parseUploads, UploadLimitError, type UploadedFile } from '../http/uploads.js';
import { isOwnerCaller, roomErrorReply } from './room-error-response.js';
import { OPERATOR_SAVE_SOURCE } from '../services/identity/display-name-provenance.js';
import {
  InvalidAvatarIdError,
  MAX_AVATAR_BYTES,
  isAvatarContentType,
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
  caller: (request: Pick<RequestFacts, 'headers' | 'agentIdentity' | 'user'>) => AuthorRecord;
  /**
   * The rooms domain's author registry: the render cache every surface reads,
   * plus the one question that decides whether the account record is this
   * author's to write.
   */
  authors: Pick<AuthorRegistry, 'setImageUrl' | 'isOwner' | 'linkToOwner' | 'unlinkFromOwner'>;
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
   * default (ADR-0320) — together with the record of who wrote it.
   *
   * **One call, both leaves, and that is a requirement rather than a
   * convenience** (DOR-1022). A name and a stale stamp of its previous author
   * are a contradiction, so an implementation that wrote them separately would
   * leave a window in which the roster draws "Suggested by DorkBot" under a name
   * the person had just saved.
   *
   * @param displayName - What the person wants to be called.
   * @param source - Who wrote it. Always `{ kind: 'operator' }` from this route;
   *   the parameter exists so the rule is the ROUTE's and stays testable, rather
   *   than living in whatever wired the writer.
   */
  setProfileDisplayName: (displayName: string, source: DisplayNameSource) => void;
}

/**
 * The multipart parser's options for exactly one photo.
 *
 * **Dedicated rather than reused.** `routes/uploads.ts` builds its options from
 * the user's upload config and writes into a session's working directory; both
 * are wrong for a photo, which is per-install, permanent, and capped by a rule
 * nobody may raise from `config.json`.
 *
 * Memory storage, because the bytes have to be sniffed before anything decides
 * where they go — and `limits.fileSize` refuses an oversized upload while it is
 * still being read, so nothing over the cap is ever held or written. A file of
 * exactly `MAX_AVATAR_BYTES` fits: `parseUploads` corrects for busboy's own
 * off-by-one, as multer did, so the cap is exactly the `≤ 2 MB` the spec and
 * error message both promise.
 */
const AVATAR_UPLOAD = {
  field: 'avatar',
  maxCount: 1,
  limits: { fileSize: MAX_AVATAR_BYTES, files: 1 },
} as const;

/** The form field the photo arrives in. */
const AVATAR_FIELD = AVATAR_UPLOAD.field;

/** Who is asking, or the answer they get instead. */
type CallerOrRefusal = { caller: AuthorRecord } | { refusal: Response };

/**
 * Create the profile router.
 *
 * @param deps - The avatar store, the caller resolver, and the four identity
 *   writers: the two the photo lands in and the two the name does.
 * @returns The Hono routes serving `PATCH /api/profile`,
 *   `POST`/`DELETE`/`GET /api/profile/avatar` and `/api/profile/identities`.
 */
export function createProfileRouter(deps: ProfileRouterDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  /**
   * The operator, or the refusal an agent gets.
   *
   * Two refusals for two different facts: 401 for a caller whose agent token
   * this machine could not verify — a credential problem, and a working token is
   * what would change the answer — and 403 for an agent that IS named, which no
   * credential fixes because a profile is a person's.
   *
   * @param c - The request, for the raw agent header and whatever the caller
   *   presented.
   * @param subject - What the agent was trying to change, so the refusal names
   *   the thing it refused rather than the route it arrived at.
   */
  function operatorOrRefuse(c: Context<ApiEnv>, subject: string): CallerOrRefusal {
    let caller: AuthorRecord;
    try {
      caller = deps.caller(honoRequestFacts(c));
    } catch (err) {
      // The rooms domain's own mapping, shared rather than mirrored, exactly as
      // `read-cursors.ts` shares it: a refusal that reads one way on a room
      // route and another here would be two answers to one question. No
      // caller was resolved, so nobody is the owner asking.
      const reply = roomErrorReply(err, 'profile caller', () => false);
      return { refusal: c.json(reply.body, reply.status as ContentfulStatusCode) };
    }
    if (caller.kind !== 'human') {
      const body = errorBody(`Only a person can change a profile ${subject}.`, 'OPERATOR_ONLY');
      return { refusal: c.json(body, 403) };
    }
    return { caller };
  }

  /**
   * The person who OWNS this install, or the refusal anybody else gets.
   *
   * {@link operatorOrRefuse} narrowed by one more question, and the two are not
   * the same one: that one refuses a machine, this one also refuses a second
   * person. ADR 260727-184933 D6 says no second local account can exist;
   * `room-caller.ts` checks that invariant rather than assuming it, the PATCH
   * handler below checks it, and so does this — an invited person claiming an
   * identity "is me" would be silencing the OWNER'S notifications.
   *
   * @param c - The request.
   * @param subject - What they were trying to change, for the refusal.
   */
  function ownerOrRefuse(c: Context<ApiEnv>, subject: string): CallerOrRefusal {
    const operator = operatorOrRefuse(c, subject);
    if ('refusal' in operator) return operator;
    // `null` is a real answer, not a missing one: with no account the `'local'`
    // sentinel IS the owner, which is what keeps the default install working.
    if (!deps.authors.isOwner(operator.caller.id, deps.ownerAccount()?.id ?? null)) {
      const body = errorBody(
        `Only the person who owns this install can change this ${subject}.`,
        'OPERATOR_ONLY'
      );
      return { refusal: c.json(body, 403) };
    }
    return operator;
  }

  /**
   * POST /identities/:authorId — "this Telegram account is me" (DOR-1778).
   *
   * **The declaration is the operator's and nobody else's, which is why it is a
   * route here rather than a field on the adapter or a verb an agent can
   * reach.** A link makes DorkOS treat an external identity's messages as the
   * operator's own words, so whoever can write one can silence the
   * notifications somebody ELSE'S messages would raise. Three things keep that
   * shut, and each is checked rather than assumed:
   *
   * - An agent is refused before anything is read (`operatorOrRefuse`, 403).
   * - A second person is refused too (`ownerOrRefuse`, 403).
   * - The registry refuses any author that is not a `platform:` row
   *   (`IDENTITY_NOT_EXTERNAL`, 400), so an agent's row cannot be claimed even
   *   by the owner. That is the one refusal that is structural: the only path
   *   that writes such a key is `resolveExternal`.
   *
   * It is deliberately NOT on the adapter's config (`PATCH
   * /api/relay/adapters/:id/config`), which looks like the natural home and is
   * not: that route is ungated on purpose — its verbs are `act`-tier MCP tools
   * an agent is already permitted to call (`routes/relay-adapters.ts`) — so a
   * link stored there would be a link an agent could write.
   *
   * Idempotent, and no more informative than it has to be: an id that names
   * nothing answers 404 through the rooms domain's own status table.
   */
  router.post('/identities/:authorId', (c) => {
    const owner = ownerOrRefuse(c, 'identity');
    if ('refusal' in owner) return owner.refusal;
    try {
      deps.authors.linkToOwner(c.req.param('authorId'), deps.ownerAccount()?.id ?? null);
      return c.body(null, 204);
    } catch (err) {
      const reply = roomErrorReply(err, 'POST /identities/:authorId', () =>
        isOwnerCaller(owner.caller)
      );
      return c.json(reply.body, reply.status as ContentfulStatusCode);
    }
  });

  /**
   * DELETE /identities/:authorId — take that claim back.
   *
   * The revocation half, gated identically. Idempotent: an identity that was
   * never claimed answers 204 too, because "it is not mine" is the state the
   * caller asked for either way.
   */
  router.delete('/identities/:authorId', (c) => {
    const owner = ownerOrRefuse(c, 'identity');
    if ('refusal' in owner) return owner.refusal;
    try {
      deps.authors.unlinkFromOwner(c.req.param('authorId'));
      return c.body(null, 204);
    } catch (err) {
      const reply = roomErrorReply(err, 'DELETE /identities/:authorId', () =>
        isOwnerCaller(owner.caller)
      );
      return c.json(reply.body, reply.status as ContentfulStatusCode);
    }
  });

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
   * **Both writes are behind one ownership check** — {@link ownerOrRefuse},
   * which is `writeImageUrl`'s argument applied to a value that needs it more.
   * `config.profile.displayName` is install-global rather than per-author, so a
   * second human author saving their own name would rewrite the OWNER's roster
   * row. ADR 260727-184933 D6 says no such person can exist locally;
   * `room-caller.ts` checks that invariant anyway rather than assuming it, and
   * so does this.
   */
  router.patch('/', (c) => {
    const operator = ownerOrRefuse(c, 'name');
    if ('refusal' in operator) return operator.refusal;
    const parsed = ProfileUpdateRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) return c.json(validationFailureBody(parsed.error), 400);
    const body = parsed.data;

    const owner = deps.ownerAccount();
    if (owner) deps.setAccountName(owner.id, body.displayName);
    // The one door that can name a person, so the one door that records one
    // (DOR-1022). Unconditional — including when the string does not change,
    // because re-saving the name already in the field is exactly how somebody
    // dismisses a "Suggested by DorkBot" note on a name they are happy with.
    // The constant is imported rather than written inline so all three doors'
    // rules live in one module; `display-name-provenance.ts` states why this is
    // the only one entitled to `operator`.
    deps.setProfileDisplayName(body.displayName, OPERATOR_SAVE_SOURCE);

    // Echoed rather than re-resolved: both sources above the author record now
    // hold this string, so the precedence cannot answer with anything else.
    return c.json({ displayName: body.displayName } satisfies ProfileUpdateResponse);
  });

  // POST /avatar — replace the operator's photo.
  router.post('/avatar', async (c) => {
    // Resolved BEFORE the body is parsed: an agent's upload is refused without
    // its bytes ever being read.
    const operator = operatorOrRefuse(c, 'photo');
    if ('refusal' in operator) return operator.refusal;

    let file: UploadedFile | undefined;
    try {
      [file] = await parseUploads(c, AVATAR_UPLOAD);
    } catch (err) {
      return uploadRefusal(c, err);
    }
    if (!file?.buffer) {
      const body = errorBody(`Attach the image as the '${AVATAR_FIELD}' field.`, 'AVATAR_MISSING');
      return c.json(body, 400);
    }

    // The bytes decide, never the filename or the Content-Type the client
    // claimed — both are written by whoever is uploading. And a photo's
    // accepted set is narrower than everything the sniffer can name: a GIF is
    // a room attachment, not an avatar (see `AVATAR_CONTENT_TYPES`).
    const sniffed = sniffAvatarContentType(file.buffer);
    const contentType = isAvatarContentType(sniffed) ? sniffed : null;
    if (!contentType) {
      const body = errorBody(
        'That file is not a PNG, JPEG, or WebP image.',
        'AVATAR_TYPE_UNSUPPORTED'
      );
      return c.json(body, 415);
    }

    try {
      const { url } = await deps.avatars.put(operator.caller.id, file.buffer, contentType);
      writeImageUrl(operator.caller.id, url);
      return c.json({ imageUrl: url } satisfies ProfileAvatarResponse);
    } catch (storeErr) {
      return storeRefusal(c, storeErr, 'POST /avatar');
    }
  });

  // DELETE /avatar — remove it from the store and from both records.
  router.delete('/avatar', async (c) => {
    const operator = operatorOrRefuse(c, 'photo');
    if ('refusal' in operator) return operator.refusal;
    try {
      await deps.avatars.delete(operator.caller.id);
      writeImageUrl(operator.caller.id, null);
      return c.body(null, 204);
    } catch (err) {
      return storeRefusal(c, err, 'DELETE /avatar');
    }
  });

  // GET /avatar/:id — serve one. `put()` always writes the SAME path
  // (`<id>.<ext>`), so the path alone proves nothing about which bytes are
  // behind it today — a stale `?v=` sitting in a browser cache would otherwise
  // be handed `immutable` for content it no longer names. The route reads the
  // query itself and answers the one question that makes `immutable` true:
  // does `?v=` name the id's CURRENT etag? On a match the requester already
  // named these exact bytes, so nothing about a future replacement can make
  // this response wrong — that request will carry a new `?v=`, a different
  // URL, cached separately. On a mismatch or an absent `?v=` (a raw
  // `/avatar/:id` fetch, or one that outlived a replacement), caching still
  // has to `must-revalidate`, because the path can legitimately start serving
  // different bytes tomorrow.
  router.get('/avatar/:id', async (c) => {
    let stored;
    try {
      stored = await deps.avatars.get(c.req.param('id'));
    } catch (err) {
      return storeRefusal(c, err, 'GET /avatar/:id');
    }
    if (!stored) {
      return c.json(errorBody('No photo for that identity.', 'AVATAR_NOT_FOUND'), 404);
    }

    c.header('Content-Type', stored.contentType);
    // An image served from a URL a person can influence is exactly where a
    // sniffing browser turns a photo into a document.
    c.header('X-Content-Type-Options', 'nosniff');
    // Defense-in-depth alongside `private` above: no origin other than this
    // install's own should be able to embed somebody's photo even if it
    // guessed the id.
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Content-Disposition', 'inline');
    c.header('ETag', stored.etag);
    const requestedVersion = readQuery(c).v;
    const namesCurrentBytes =
      typeof requestedVersion === 'string' && `"${requestedVersion}"` === stored.etag;
    c.header(
      'Cache-Control',
      namesCurrentBytes
        ? 'private, max-age=31536000, immutable'
        : 'private, max-age=0, must-revalidate'
    );

    if (c.req.header('if-none-match') === stored.etag) {
      // Programmed against the PORT, not against today's one implementation of
      // it: `StoredAvatar.stream` is documented as "a local store opens a file;
      // a remote one opens a response", and a lazily-opened stream abandoned
      // with no `error` listener faults at the process rather than at the
      // request (see `discardStream`). `LocalAvatarStore` happens to hand back
      // bytes already in memory today (DOR-1830), which makes this free.
      discardStream(stored.stream);
      return c.body(null, 304);
    }
    // A HEAD sends no body, so its stream is let go the same way.
    if (c.req.method === 'HEAD') {
      discardStream(stored.stream);
      return c.body(null);
    }

    return c.body(webStreamOf(stored.stream));
  });

  return router;
}

/** Turn a parser refusal into the answer the person who uploaded should see. */
function uploadRefusal(c: Context<ApiEnv>, err: unknown): Response {
  if (err instanceof UploadLimitError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const megabytes = MAX_AVATAR_BYTES / 1024 / 1024;
      const body = errorBody(`That image is larger than ${megabytes} MB.`, 'AVATAR_TOO_LARGE');
      return c.json(body, 413);
    }
    const body = errorBody(`Send one image as '${AVATAR_FIELD}'.`, 'AVATAR_UPLOAD_REJECTED');
    return c.json(body, 400);
  }
  logger.error('[Profile] avatar upload failed', logError(err));
  return c.json(errorBody('That upload could not be read.', 'AVATAR_UPLOAD_REJECTED'), 400);
}

/** Turn a store failure into a status. An unusable id is the caller's fault. */
function storeRefusal(c: Context<ApiEnv>, err: unknown, where: string): Response {
  if (err instanceof InvalidAvatarIdError) {
    return c.json(errorBody('That is not a usable identity id.', 'AVATAR_ID_INVALID'), 400);
  }
  logger.error(`[Profile] ${where} failed`, logError(err));
  return c.json(errorBody('Could not store that photo.', 'AVATAR_STORE_FAILED'), 500);
}

/**
 * A stored photo's bytes as the response body. A read that fails is logged and
 * ends the response; its headers have gone out by then.
 */
function webStreamOf(stream: Readable): ReadableStream<Uint8Array> {
  stream.on('error', (streamErr) => {
    logger.error('[Profile] avatar stream failed', logError(streamErr));
  });
  return Readable.toWeb(stream) as ReadableStream<Uint8Array>;
}
