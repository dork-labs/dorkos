/**
 * `/api/documents/versions`: a doc's saved versions, and putting one back
 * (DOR-2984; "Restore previous version", the DOR-2983 decision).
 *
 * - `GET /?cwd=…&path=…` lists the versions, newest first.
 * - `POST /` keeps text an editor could not save (its live copy was replaced
 *   while it was offline, say) as a version, so it can be put back.
 * - `POST /restore` puts one back: the doc becomes that version, and what it
 *   said before is kept as a version first. While the doc is open the restore
 *   reaches its editors live.
 *
 * The same boundary checks as the files routes. Keeping a draft and restoring
 * change what a person sees in their doc, so both are a person's alone
 * ({@link clearsTheAgentBar}): an agent changes a doc through `doc_write`,
 * which merges. The whole group answers the `/api` 404 while the
 * `docs.enabled` experiment is off.
 *
 * @module routes/documents-versions
 */
import { Hono, type Context } from 'hono';
import bodyParser from 'body-parser';
import { z } from 'zod';
import {
  DocRefSchema,
  KeepDocDraftRequestSchema,
  RestoreDocVersionRequestSchema,
} from '@dorkos/shared/doc-collab';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody, type BodyRule } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { clearsTheAgentBar } from '../lib/caller-authority.js';
import { readQuery } from '../http/request-query.js';
import { errorBody } from '../lib/route-utils.js';
import { logger } from '../lib/logger.js';
import {
  DocChangedError,
  DocRefusal,
  docsEnabled,
  getDocCollab,
  type DocCollabService,
} from '../services/docs/collab/index.js';

/** What the routes read, injectable for tests. */
export interface DocumentVersionRouteDeps {
  /** Whether the Docs experiment is on. */
  enabled: () => boolean;
  /** The live-doc service, or `null` before startup made it. */
  service: () => DocCollabService | null;
}

const liveDeps: DocumentVersionRouteDeps = { enabled: docsEnabled, service: getDocCollab };

/**
 * A draft is a whole doc, up to the 5 MB doc cap, which the app-wide 1 MB JSON
 * limit would refuse first. Only this one path gets the larger limit, and the
 * request schema still holds the text itself to the doc cap.
 */
export const documentVersionsBodyRule: BodyRule = {
  matches: (method, path) =>
    method.toUpperCase() === 'POST' && path.replace(/\/$/, '') === '/api/documents/versions',
  parse: bodyParser.json({ limit: '12mb' }),
};

/** The refusal for anything but a person, or `null` for a person. */
function refuseUnlessPerson(c: Context<ApiEnv>): Response | null {
  if (clearsTheAgentBar(honoRequestFacts(c))) return null;
  return c.json(
    errorBody('Only a person can change a doc’s versions. Agents use doc_write.', 'PERSON_ONLY'),
    403
  );
}

/** The answer for an error the doc service raised, or `null` for a bug. */
function refusalOf(
  err: unknown
): { status: 400 | 403 | 404 | 409 | 413 | 415 | 429 | 503; body: object } | null {
  if (err instanceof DocRefusal)
    return { status: err.status, body: errorBody(err.message, err.code) };
  if (err instanceof DocChangedError) {
    return {
      status: 409,
      body: errorBody('This doc changed while restoring. Try again.', 'CONFLICT'),
    };
  }
  return null;
}

/**
 * Build the routes mounted at `/api/documents/versions`.
 *
 * @param deps - Seams for tests; the live service by default.
 */
export function createDocumentVersionRoutes(
  deps: DocumentVersionRouteDeps = liveDeps
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  router.use('*', async (c, next) => {
    if (!deps.enabled()) return c.json(errorBody('Not found', 'API_NOT_FOUND'), 404);
    if (!deps.service())
      return c.json(errorBody('Docs are starting. Try again.', 'UNAVAILABLE'), 503);
    await next();
  });

  router.get('/', async (c) => {
    const parsed = DocRefSchema.safeParse(readQuery(c));
    if (!parsed.success) {
      return c.json({ error: 'Invalid query', details: z.treeifyError(parsed.error) }, 400);
    }
    try {
      return c.json({ versions: await deps.service()!.listVersions(parsed.data) });
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal) return c.json(refusal.body, refusal.status);
      logger.error('[docs] listing versions failed', { err });
      return c.json(errorBody('Internal server error', 'INTERNAL'), 500);
    }
  });

  router.post('/', async (c) => {
    const refused = refuseUnlessPerson(c);
    if (refused) return refused;
    const parsed = KeepDocDraftRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: 'Invalid body', details: z.flattenError(parsed.error) }, 400);
    }
    const { markdown, ...doc } = parsed.data;
    try {
      const version = await deps.service()!.keepDraft(doc, markdown, { kind: 'person' });
      return c.json({ ok: true as const, version });
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal) return c.json(refusal.body, refusal.status);
      logger.error('[docs] keeping unsaved edits failed', { err });
      return c.json(errorBody('Internal server error', 'INTERNAL'), 500);
    }
  });

  router.post('/restore', async (c) => {
    const refused = refuseUnlessPerson(c);
    if (refused) return refused;
    const parsed = RestoreDocVersionRequestSchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json({ error: 'Invalid body', details: z.flattenError(parsed.error) }, 400);
    }
    const { versionId, ...doc } = parsed.data;
    try {
      const { live } = await deps.service()!.restore(doc, versionId, { kind: 'person' });
      return c.json({ ok: true as const, live });
    } catch (err) {
      const refusal = refusalOf(err);
      if (refusal) return c.json(refusal.body, refusal.status);
      logger.error('[docs] restoring a version failed', { err });
      return c.json(errorBody('Internal server error', 'INTERNAL'), 500);
    }
  });

  return router;
}
