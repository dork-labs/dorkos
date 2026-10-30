/**
 * The person's Claude sign-in list (DOR-3245), mounted at
 * `/api/runtimes/claude-code/signins`: which sign-in each folder holds,
 * confirming a new or changed one, and the two lists only a person fills
 * (organizations and folders DorkOS must never use).
 *
 * Every route takes the person bar ({@link refuseUnlessAccountOwner}): no
 * agent, no API key, and with login on the install owner's own browser
 * session. Agents get 403 at every level; that is a refusal to change a
 * person's setting, never a limit on an agent's own work. No route takes a
 * path or an identity from the caller: both are read on the server.
 *
 * @module routes/account-signin
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readJsonBody } from '../http/request-body.js';
import { refuseUnlessAccountOwner } from '../lib/caller-authority.js';
import {
  accountSigninPolicy,
  type AccountSigninPolicy,
} from '../services/health/account-signin-policy.js';
import { readAccountLoginMetadata } from '../services/runtimes/claude-code/accounts/account-login-metadata.js';
import { signinAccounts } from '../services/runtimes/connect/signin-accounts.js';
import { noteSigninRepaired } from '../services/observability/index.js';

const EmptySchema = z.object({}).strict();
const OrganizationSchema = z
  .object({ orgId: z.uuid(), label: z.string().trim().min(1).max(80) })
  .strict();
const FolderSchema = z.object({ accountId: z.string().min(1) }).strict();

/** Refusal code when only the person, in the app, may change a sign-in. */
export const SIGNIN_NEEDS_PERSON = 'SIGNIN_NEEDS_PERSON';

/**
 * The person bar for Claude sign-ins: the refusal to answer with, or
 * `undefined` for the person in the app.
 *
 * @param c - The request's context.
 */
export function refuseSigninPolicyChange(c: Context<ApiEnv>): Response | undefined {
  if (!refuseUnlessAccountOwner(honoRequestFacts(c))) return undefined;
  return c.json(
    { error: 'Only you can change Claude sign-ins, in the app.', code: SIGNIN_NEEDS_PERSON },
    403
  );
}

interface SigninRouteDeps {
  policy?: () => AccountSigninPolicy | undefined;
  accounts?: typeof signinAccounts;
  metadata?: typeof readAccountLoginMetadata;
}

/** Person-only reads and changes; no route receives a caller-supplied path or identity. */
export function createAccountSigninRoutes(deps: SigninRouteDeps = {}): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  const readPolicy = deps.policy ?? accountSigninPolicy;
  const accounts = deps.accounts ?? signinAccounts;
  const metadata = deps.metadata ?? readAccountLoginMetadata;
  router.use('*', async (c, next) => {
    const refusal = refuseSigninPolicyChange(c);
    if (refusal) return refusal;
    c.header('Cache-Control', 'no-store');
    if (!readPolicy()) return c.json({ error: 'Sign-in checks are not ready. Try again.' }, 503);
    await next();
  });
  router.get('/', (c) => {
    const policy = readPolicy()!;
    return c.json({
      ...policy.snapshot(),
      accounts: accounts().map((account) => ({
        ...account,
        identity: policy.neverUses(account.path)
          ? policy.assess(account.path, null)
          : policy.assess(account.path, metadata(account.path)),
      })),
    });
  });
  router.post('/organizations', async (c) => {
    const body = OrganizationSchema.safeParse(readJsonBody(c));
    if (!body.success) return c.json({ error: 'Enter an organization ID and a label.' }, 400);
    readPolicy()!.addOrganization(body.data.orgId, body.data.label);
    return c.json({ ok: true });
  });
  router.delete('/organizations/:id', async (c) => {
    const body = EmptySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success || !z.uuid().safeParse(c.req.param('id')).success)
      return c.json({ error: 'Choose an organization from this list.' }, 400);
    readPolicy()!.removeOrganization(c.req.param('id'));
    return c.json({ ok: true });
  });
  router.post('/folders', async (c) => {
    const body = FolderSchema.safeParse(readJsonBody(c));
    if (!body.success) return c.json({ error: 'Choose an account from this computer.' }, 400);
    const account = accounts().find((row) => row.accountId === body.data.accountId);
    if (!account) return c.json({ error: 'That account is not registered.' }, 404);
    readPolicy()!.addFolder({
      accountId: account.accountId,
      path: account.path,
      label: account.name,
    });
    return c.json({ ok: true });
  });
  router.delete('/folders/:id', async (c) => {
    const body = EmptySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json({ error: 'Choose a folder from this list.' }, 400);
    readPolicy()!.removeFolder(c.req.param('id'));
    return c.json({ ok: true });
  });
  // Confirm a new sign-in, or keep a changed one: both bind what the server reads now.
  router.post('/:id/accept', async (c) => {
    const body = EmptySchema.safeParse(readJsonBody(c, { emptyAs: {} }));
    if (!body.success) return c.json({ error: 'Choose a sign-in from this list.' }, 400);
    const account = accounts().find((row) => row.accountId === c.req.param('id'));
    if (!account) return c.json({ error: 'That account is not registered.' }, 404);
    const policy = readPolicy()!;
    const identity = policy.neverUses(account.path) ? null : metadata(account.path);
    if (!policy.accept(account.path, identity))
      return c.json({ error: 'This sign-in can’t be used. Sign in again.' }, 409);
    noteSigninRepaired('claude-code', account.path);
    return c.json({ ok: true, identity: policy.assess(account.path, identity) });
  });
  return router;
}
