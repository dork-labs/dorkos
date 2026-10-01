import type { Hono } from 'hono';
import type { Pool } from 'pg';
import { ZodError } from 'zod';
import {
  CommunityAdminAccountClosureCancelRequestSchema,
  CommunityAdminAccountClosureCreateResponseSchema,
  CommunityAdminAccountClosureRequestSchema,
  CommunityAdminAccountClosureSchema,
  CommunityAdminAccountIdSchema,
  CommunityAdminAccountLookupRequestSchema,
  CommunityAdminAccountLookupResponseSchema,
} from '@dorkos/shared/community-admin-wire';
import type { CommunityConfig } from '../../config.js';
import { transaction } from '../../data.js';
import {
  accountClosureLogLine,
  cancelAccountClosure,
  closeAccount,
  findAccountBySignOn,
  readAccountClosure,
} from '../../host/account-closures.js';
import type { HostAuthority } from '../../host/authority.js';
import { ApiError, json, readJson } from '../../http.js';
import { OIDC_PROVIDER_ID } from '../../oidc.js';
import type { ConfirmPassword } from '../../password-confirmation.js';

/** Parse a route's account id; a malformed one is the same 404 as an unknown one. */
function accountIdOf(value: string | undefined): string {
  const parsed = CommunityAdminAccountIdSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(404, 'NOT_FOUND', 'Account not found.');
  return parsed.data;
}

/**
 * Register the host's account closure routes (DOR-2557). Every one needs `accounts:close`, which
 * no other scope implies. A person closing an account proves it with their password; a key never
 * sends one. Nothing here returns a name, an email, or anything the person wrote: a closure is
 * ids, states, dates, the reason, and the host's own reference. Each actor may close at most
 * `COMMUNITY_ACCOUNT_CLOSURES_PER_DAY` accounts in any 24 hours, and every closure and every
 * refused closure logs one warning line with ids only, for the host's alerting.
 */
export function registerHostAccountClosureRoutes(
  app: Hono,
  deps: {
    pool: Pool;
    config: Pick<CommunityConfig, 'oidc' | 'limits'>;
    authority: HostAuthority;
    now: () => Date;
    confirmPassword: ConfirmPassword;
    /** Whether an account has a password; one that signs in only through single sign-on does not. */
    hasPassword: (userId: string) => Promise<boolean>;
  }
): void {
  const { pool, config, authority, now, confirmPassword, hasPassword } = deps;
  const warn = (line: string) => console.warn(line);

  // A POST, so the person's sign-in identity never lands in a URL or an access log.
  app.post('/host/accounts/lookup', async (c) => {
    await authority.require(c, 'accounts:close');
    const body = await readJson(c, CommunityAdminAccountLookupRequestSchema);
    if (!config.oidc)
      throw new ApiError(409, 'STATE_CONFLICT', 'This host has no single sign-on to look up.');
    if (body.issuer.replace(/\/+$/, '') !== config.oidc.issuer)
      throw new ApiError(409, 'STATE_CONFLICT', 'That is not this host’s sign-in service.');
    const accountId = await findAccountBySignOn(pool, OIDC_PROVIDER_ID, body.subject);
    if (!accountId)
      throw new ApiError(404, 'NOT_FOUND', 'No account here signs in with that identity.');
    return json(c, CommunityAdminAccountLookupResponseSchema, { accountId });
  });

  app.get('/host/accounts/:accountId/closure', async (c) => {
    await authority.require(c, 'accounts:close');
    const closure = await readAccountClosure(pool, accountIdOf(c.req.param('accountId')));
    if (!closure) throw new ApiError(404, 'NOT_FOUND', 'This account has not been closed.');
    return json(c, CommunityAdminAccountClosureSchema, closure);
  });

  app.post('/host/accounts/:accountId/closure', async (c) => {
    const actor = await authority.require(c, 'accounts:close');
    // A malformed id is logged as null: the line carries ids only, never what a caller typed.
    const parsedId = CommunityAdminAccountIdSchema.safeParse(c.req.param('accountId'));
    const loggedId = parsedId.success ? parsedId.data : null;
    let result: Awaited<ReturnType<typeof closeAccount>>;
    try {
      const body = await readJson(c, CommunityAdminAccountClosureRequestSchema);
      const accountId = accountIdOf(c.req.param('accountId'));
      if (actor.kind === 'api_key' && body.password !== undefined)
        throw new ApiError(400, 'STATE_CONFLICT', 'A host API key does not send a password.');
      if (actor.kind === 'person') {
        // An operator who signs in only through single sign-on has no password to confirm. They
        // use a key with this scope instead.
        if (!(await hasPassword(actor.userId)))
          throw new ApiError(
            403,
            'PASSWORD_REQUIRED',
            'Set a password in your account to do this.'
          );
        if (!body.password)
          throw new ApiError(403, 'REAUTH_REQUIRED', 'Enter your password to take this action.');
        await confirmPassword(c, actor.userId, body.password);
      }
      result = await transaction(pool, (client) =>
        closeAccount(client, {
          accountId,
          actor,
          idempotencyKey: body.idempotencyKey,
          reason: body.reason,
          reference: body.reference,
          now: now(),
          closuresPerDay: config.limits.accountClosuresPerDay,
        })
      );
    } catch (error) {
      // Every refusal past authentication, a wrong password from a stolen session included. A
      // body the schema refuses answers `400 STATE_CONFLICT` (http.ts), so it is logged so.
      const code =
        error instanceof ApiError
          ? error.code
          : error instanceof ZodError
            ? 'STATE_CONFLICT'
            : null;
      if (code)
        warn(accountClosureLogLine({ outcome: 'refused', accountId: loggedId, actor, code }));
      throw error;
    }
    // Logged once it has committed, so a host's alerting never hears of one that rolled back.
    if (!result.replayed)
      warn(
        accountClosureLogLine({
          outcome: 'closed',
          accountId: result.closure.accountId,
          actor,
          closureId: result.closure.closureId,
        })
      );
    return json(
      c,
      CommunityAdminAccountClosureCreateResponseSchema,
      result,
      result.replayed ? 200 : 201
    );
  });

  app.post('/host/accounts/:accountId/closure/cancel', async (c) => {
    const actor = await authority.require(c, 'accounts:close');
    await readJson(c, CommunityAdminAccountClosureCancelRequestSchema);
    const accountId = accountIdOf(c.req.param('accountId'));
    const closure = await transaction(pool, (client) =>
      cancelAccountClosure(client, { accountId, actor, now: now() })
    );
    return json(c, CommunityAdminAccountClosureSchema, closure);
  });
}
