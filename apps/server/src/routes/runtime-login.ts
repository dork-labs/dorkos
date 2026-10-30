import type { Context } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import {
  delegateRuntimeLogin,
  LOGIN_RUNTIME_TYPES,
} from '../services/runtimes/connect/delegated-login.js';
import { resolveAccountRootForSession } from '../services/runtimes/connect/resolve-session-account.js';
import { signinAccounts } from '../services/runtimes/connect/signin-accounts.js';
import { isNeverUseClaudeFolder } from '../services/health/account-signin-policy.js';
import { refuseCredentialChange } from './runtimes-http.js';

const LoginSchema = z
  .object({ accountId: z.string().min(1).optional(), sessionId: z.string().min(1).optional() })
  .strict();

/**
 * `POST /api/runtimes/:type/login`: run the vendor's own sign-in, which opens a
 * browser on this computer, so only the owner at this computer may start it.
 * Every Claude target is resolved from server records; no request supplies a
 * path. A Claude sign-in finished here is confirmed in the same step.
 *
 * @param c - The request's context.
 */
export async function runtimeLogin(c: Context<ApiEnv>): Promise<Response> {
  const type = c.req.param('type') ?? '';
  const refusal = refuseCredentialChange(c);
  if (refusal) return refusal;
  if (!(LOGIN_RUNTIME_TYPES as readonly string[]).includes(type))
    return c.json({ ok: false, error: 'This app does not support sign-in.' }, 400);
  const body = LoginSchema.safeParse(readJsonBody(c, { emptyAs: {} }));
  if (!body.success) return c.json({ ok: false, error: 'Choose an account from Runtimes.' }, 400);
  let accountRoot: string | undefined;
  if (type === 'claude-code') {
    const rows = signinAccounts();
    if (body.data.sessionId) {
      const root = await resolveAccountRootForSession(body.data.sessionId);
      accountRoot = root && rows.find((row) => row.path === root)?.path;
    } else {
      accountRoot = rows.find((row) => row.accountId === body.data.accountId)?.path;
    }
    if (!accountRoot || isNeverUseClaudeFolder(accountRoot))
      return c.json(
        { ok: false, error: 'This account cannot be used. Choose another in Runtimes.' },
        400
      );
  } else if (body.data.accountId)
    return c.json({ ok: false, error: 'This app does not use account folders.' }, 400);
  return c.json(await delegateRuntimeLogin(type, { accountRoot }));
}
