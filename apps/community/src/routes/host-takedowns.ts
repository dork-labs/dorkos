import type { Context, Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  CommunityAdminTakedownEvidenceRetryRequestSchema,
  CommunityAdminTakedownListSchema,
  CommunityAdminTakedownReleaseHeldRequestSchema,
  CommunityAdminTakedownRequestSchema,
  CommunityAdminTakedownResponseSchema,
  CommunityAdminTakedownReverseRequestSchema,
} from '@dorkos/shared/community-admin-wire';
import type { CommunityConfig } from '../config.js';
import { transaction } from '../data.js';
import { parseHostCommunityId } from '../host/communities.js';
import { assertHostActor, type HostActor, type HostAuthority } from '../host/authority.js';
import { ApiError, json, readJson } from '../http.js';
import type { ConfirmPassword } from '../password-confirmation.js';
import {
  createItemTakedown,
  listTakedowns,
  lockTakedown,
  projectTakedown,
  releaseHeldEvidence,
  resolveNotify,
  retryTakedownEvidence,
  TAKEDOWN_COLUMNS,
  type TakedownHooks,
  type TakedownRow,
} from '../takedown/takedowns.js';

const HOUR_MS = 60 * 60_000;
const TakedownIdSchema = z.uuid();
const ListQuerySchema = z.strictObject({
  communityId: z.uuid().optional(),
  after: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function takedownId(value: string | undefined): string {
  const parsed = TakedownIdSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, 'NOT_FOUND', 'Takedown not found.');
  return parsed.data;
}

/**
 * Register the host's takedown routes. Every one needs `communities:takedown`. A person proves
 * each takedown with their password; a key never sends one. No request or response here carries
 * content: a takedown names content by id, and its copy goes only to the evidence store.
 */
export function registerHostTakedownRoutes(
  app: Hono,
  deps: {
    pool: Pool;
    config: CommunityConfig;
    authority: HostAuthority;
    now: () => Date;
    confirmPassword: ConfirmPassword;
    hooks?: TakedownHooks;
  }
): void {
  const { pool, config, authority, now, confirmPassword, hooks } = deps;
  const project = (row: TakedownRow) =>
    projectTakedown(
      row,
      new Date(now().getTime() - config.limits.takedownEvidenceAlertHours * HOUR_MS)
    );

  /** A person confirms with their password; a key must not send one. */
  const confirm = async (c: Context, actor: HostActor, password: string | undefined) => {
    if (actor.kind === 'api_key') {
      if (password !== undefined)
        throw new ApiError(400, 'STATE_CONFLICT', 'A host API key does not send a password.');
      return;
    }
    if (!password)
      throw new ApiError(403, 'REAUTH_REQUIRED', 'Enter your password to take this action.');
    await confirmPassword(c, actor.userId, password);
  };

  app.post('/host/communities/:id/takedowns', async (c) => {
    const actor = await authority.require(c, 'communities:takedown');
    const body = await readJson(c, CommunityAdminTakedownRequestSchema);
    const communityId = parseHostCommunityId(c.req.param('id'));
    await confirm(c, actor, body.password);
    const target = body.target;
    if (target.kind === 'community')
      throw new ApiError(
        409,
        'STATE_CONFLICT',
        'Taking down a whole community is not available yet. Suspend it instead.'
      );
    const result = await transaction(pool, (client) =>
      createItemTakedown(
        client,
        {
          communityId,
          actor,
          target,
          idempotencyKey: body.idempotencyKey,
          category: body.category,
          reference: body.reference,
          notify: resolveNotify(body.category, body.notify),
          evidenceStore: config.evidence !== null,
          publicUrl: config.publicUrl,
          now: now(),
        },
        hooks
      )
    );
    return json(
      c,
      CommunityAdminTakedownResponseSchema,
      { takedown: project(result.row) },
      result.replayed ? 200 : 201
    );
  });

  app.get('/host/takedowns', async (c) => {
    await authority.require(c, 'communities:takedown');
    const query = ListQuerySchema.parse(c.req.query());
    const page = await listTakedowns(pool, {
      communityId: query.communityId ?? null,
      after: query.after ?? null,
      limit: query.limit,
    });
    return json(c, CommunityAdminTakedownListSchema, {
      takedowns: page.rows.map(project),
      nextAfter: page.nextAfter,
      evidenceStore: config.evidence !== null,
    });
  });

  app.get('/host/takedowns/:takedownId', async (c) => {
    await authority.require(c, 'communities:takedown');
    const id = takedownId(c.req.param('takedownId'));
    const row = await pool.query<TakedownRow>(
      `SELECT ${TAKEDOWN_COLUMNS} FROM community_takedowns WHERE id=$1`,
      [id]
    );
    if (!row.rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Takedown not found.');
    return json(c, CommunityAdminTakedownResponseSchema, { takedown: project(row.rows[0]) });
  });

  app.post('/host/takedowns/:takedownId/reverse', async (c) => {
    const actor = await authority.require(c, 'communities:takedown');
    const body = await readJson(c, CommunityAdminTakedownReverseRequestSchema);
    const id = takedownId(c.req.param('takedownId'));
    await confirm(c, actor, body.password);
    await transaction(pool, async (client) => {
      await lockTakedown(client, id);
      await assertHostActor(client, actor, now());
    });
    // Only a whole-community takedown waits out a window before anything is destroyed. An
    // item's content was removed at once and cannot be put back.
    throw new ApiError(
      409,
      'STATE_CONFLICT',
      'A removed message, file, or icon cannot be restored: it is gone.'
    );
  });

  app.post('/host/takedowns/:takedownId/evidence/retry', async (c) => {
    const actor = await authority.require(c, 'communities:takedown');
    await readJson(c, CommunityAdminTakedownEvidenceRetryRequestSchema);
    const id = takedownId(c.req.param('takedownId'));
    const row = await transaction(pool, (client) =>
      retryTakedownEvidence(client, {
        takedownId: id,
        actor,
        evidenceStore: config.evidence !== null,
        now: now(),
      })
    );
    return json(c, CommunityAdminTakedownResponseSchema, { takedown: project(row) });
  });

  app.post('/host/takedowns/:takedownId/release-held', async (c) => {
    const actor = await authority.require(c, 'communities:takedown');
    // Releasing preserved material destroys it, so only a person may, with their password.
    if (actor.kind !== 'person')
      throw new ApiError(403, 'FORBIDDEN', 'Only a host operator can release held content.');
    const body = await readJson(c, CommunityAdminTakedownReleaseHeldRequestSchema);
    const id = takedownId(c.req.param('takedownId'));
    await confirm(c, actor, body.password);
    const row = await transaction(pool, (client) =>
      releaseHeldEvidence(client, { takedownId: id, actor, now: now() })
    );
    return json(c, CommunityAdminTakedownResponseSchema, { takedown: project(row) });
  });
}
