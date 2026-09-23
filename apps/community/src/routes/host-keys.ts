import type { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  CommunityAdminHostApiKeyIssueRequestSchema,
  CommunityAdminHostApiKeyListSchema,
  CommunityAdminHostApiKeyRevokeRequestSchema,
  CommunityAdminHostApiKeyRotateRequestSchema,
  CommunityAdminHostApiKeySchema,
  CommunityAdminHostApiKeySecretResponseSchema,
} from '@dorkos/shared/community-admin-wire';
import type { CommunityAuth } from '../auth.js';
import { transaction } from '../data.js';
import { assertHostActor, type HostAuthority } from '../host/authority.js';
import type { ConfirmPassword } from '../password-confirmation.js';
import {
  issueHostApiKey,
  listHostApiKeys,
  revokeHostApiKey,
  rotateHostApiKey,
} from '../host/key-store.js';
import { ApiError, json, readJson } from '../http.js';

/**
 * Register host API key management. Every route needs a host operator's session: a key can
 * never list, issue, rotate, or revoke keys, so a leaked key cannot outlive its revocation.
 */
export function registerHostKeyRoutes(
  app: Hono,
  deps: {
    pool: Pool;
    auth: CommunityAuth;
    authority: HostAuthority;
    now: () => Date;
    confirmPassword: ConfirmPassword;
  }
): void {
  const { pool, authority, now, confirmPassword } = deps;
  const keyId = (value: string | undefined) => {
    const parsed = z.uuid().safeParse(value);
    if (!parsed.success) throw new ApiError(404, 'NOT_FOUND', 'Host API key not found.');
    return parsed.data;
  };

  app.get('/host/api-keys', async (c) => {
    await authority.requireSession(c);
    return json(c, CommunityAdminHostApiKeyListSchema, { keys: await listHostApiKeys(pool) });
  });

  app.post('/host/api-keys', async (c) => {
    const operator = await authority.requireSession(c);
    const body = await readJson(c, CommunityAdminHostApiKeyIssueRequestSchema);
    await confirmPassword(c, operator.userId, body.password);
    const at = now();
    const issued = await transaction(pool, async (client) => {
      await assertHostActor(client, operator, at);
      return issueHostApiKey(client, {
        label: body.label,
        scopes: body.scopes,
        expiresAt:
          body.expiresInDays === null
            ? null
            : new Date(at.getTime() + body.expiresInDays * 24 * 60 * 60_000),
        issuer: operator,
        now: at,
      });
    });
    c.header('Cache-Control', 'no-store');
    return json(
      c,
      CommunityAdminHostApiKeySecretResponseSchema,
      { key: issued.key, secret: issued.secret, previousKeyExpiresAt: null },
      201
    );
  });

  app.post('/host/api-keys/:id/rotate', async (c) => {
    const operator = await authority.requireSession(c);
    const id = keyId(c.req.param('id'));
    const body = await readJson(c, CommunityAdminHostApiKeyRotateRequestSchema);
    await confirmPassword(c, operator.userId, body.password);
    const at = now();
    const rotated = await transaction(pool, async (client) => {
      await assertHostActor(client, operator, at);
      return rotateHostApiKey(client, {
        keyId: id,
        overlapMinutes: body.overlapMinutes,
        issuer: operator,
        now: at,
      });
    });
    c.header('Cache-Control', 'no-store');
    return json(
      c,
      CommunityAdminHostApiKeySecretResponseSchema,
      {
        key: rotated.key,
        secret: rotated.secret,
        previousKeyExpiresAt: rotated.previousKeyExpiresAt.toISOString(),
      },
      201
    );
  });

  app.post('/host/api-keys/:id/revoke', async (c) => {
    const operator = await authority.requireSession(c);
    const id = keyId(c.req.param('id'));
    await readJson(c, CommunityAdminHostApiKeyRevokeRequestSchema);
    const at = now();
    const key = await transaction(pool, async (client) => {
      await assertHostActor(client, operator, at);
      return revokeHostApiKey(client, { keyId: id, revoker: operator, now: at });
    });
    return json(c, CommunityAdminHostApiKeySchema, key);
  });
}
