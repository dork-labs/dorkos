import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readJsonBody } from '../http/request-body.js';
import { clearsTheAgentBar, refuseFrontDoorChange } from '../lib/caller-authority.js';
import { classifyRequest } from '../lib/request-classifier.js';
import { currentServerRole } from '../lib/server-role.js';
import { isInstallOwner } from '../services/core/auth/install-owner.js';
import {
  checkOwnerPassword,
  ownerPasswordAvailable,
  type OwnerPasswordCheck,
} from '../services/core/auth/owner-password.js';
import {
  accountSigninPolicy,
  type AccountSigninPolicy,
} from '../services/health/account-signin-policy.js';
import { readAccountLoginMetadata } from '../services/runtimes/claude-code/accounts/account-login-metadata.js';
import { signinAccounts } from '../services/runtimes/connect/signin-accounts.js';
import { noteSigninRepaired } from '../services/observability/index.js';

const StepUpSchema = z.object({
  password: z.string().max(128).optional(),
  confirmOnThisComputer: z.literal(true).optional(),
});
const OrganizationSchema = StepUpSchema.extend({
  orgId: z.uuid(),
  label: z.string().trim().min(1).max(80),
}).strict();
const FolderSchema = StepUpSchema.extend({ accountId: z.string().min(1) }).strict();

/** The direct local browser only; no ownerless-container or forwarded-listener exception. */
function isLocalConfirmation(c: Context<ApiEnv>): boolean {
  return classifyRequest(honoRequestFacts(c), currentServerRole()).kind === 'this-computer';
}

/** Owner identity on any device, or the existing person bar at this computer with login off. */
export function refuseSigninPolicyChange(c: Context<ApiEnv>): Response | undefined {
  const facts = honoRequestFacts(c);
  if (clearsTheAgentBar(facts) && facts.user?.credential === 'cookie' && isInstallOwner(facts.user))
    return undefined;
  if (isLocalConfirmation(c) && !refuseFrontDoorChange(facts, 'these sign-ins')) return undefined;
  return c.json({ error: 'Only the signed-in owner can change these sign-ins.' }, 403);
}

interface SigninRouteDeps {
  policy?: () => AccountSigninPolicy | undefined;
  accounts?: typeof signinAccounts;
  metadata?: typeof readAccountLoginMetadata;
  passwordAvailable?: () => Promise<boolean>;
  checkPassword?: (password: string | undefined) => Promise<OwnerPasswordCheck>;
}

/** Owner-only reads and step-up mutations; no API receives a caller-supplied path or identity. */
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
  async function stepUp(
    c: Context<ApiEnv>,
    body: z.infer<typeof StepUpSchema>
  ): Promise<Response | undefined> {
    if (
      body.confirmOnThisComputer &&
      isLocalConfirmation(c) &&
      !(await (deps.passwordAvailable ?? ownerPasswordAvailable)())
    )
      return undefined;
    const result = await (deps.checkPassword ?? checkOwnerPassword)(body.password);
    if (result === 'ok') return undefined;
    const unavailable = result === 'no-owner' || result === 'no-password';
    return c.json(
      {
        error: unavailable
          ? 'Confirm this on the Mac running DorkOS.'
          : 'Confirm it’s you to change this sign-in.',
        code: 'SIGNIN_STEP_UP',
        reason: result,
      },
      result === 'too-many-attempts' ? 429 : unavailable ? 409 : 403
    );
  }
  router.get('/', async (c) => {
    const policy = readPolicy()!;
    return c.json({
      ...policy.snapshot(),
      stepUp: (await (deps.passwordAvailable ?? ownerPasswordAvailable)())
        ? 'password'
        : isLocalConfirmation(c)
          ? 'this-computer'
          : 'other-computer',
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
    const refusal = await stepUp(c, body.data);
    if (refusal) return refusal;
    readPolicy()!.addOrganization(body.data.orgId, body.data.label);
    return c.json({ ok: true });
  });
  router.delete('/organizations/:id', async (c) => {
    const body = StepUpSchema.strict().safeParse(readJsonBody(c));
    if (!body.success || !z.uuid().safeParse(c.req.param('id')).success)
      return c.json({ error: 'Choose a sign-in from this list.' }, 400);
    const refusal = await stepUp(c, body.data);
    if (refusal) return refusal;
    readPolicy()!.removeOrganization(c.req.param('id'));
    return c.json({ ok: true });
  });
  router.post('/folders', async (c) => {
    const body = FolderSchema.safeParse(readJsonBody(c));
    if (!body.success) return c.json({ error: 'Choose an account from this computer.' }, 400);
    const refusal = await stepUp(c, body.data);
    if (refusal) return refusal;
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
    const body = StepUpSchema.strict().safeParse(readJsonBody(c));
    if (!body.success) return c.json({ error: 'Choose a folder from this list.' }, 400);
    const refusal = await stepUp(c, body.data);
    if (refusal) return refusal;
    readPolicy()!.removeFolder(c.req.param('id'));
    return c.json({ ok: true });
  });
  router.post('/:id/accept', async (c) => {
    const body = StepUpSchema.strict().safeParse(readJsonBody(c));
    if (!body.success) return c.json({ error: 'Confirm it’s you to use this sign-in.' }, 400);
    const refusal = await stepUp(c, body.data);
    if (refusal) return refusal;
    const account = accounts().find((row) => row.accountId === c.req.param('id'));
    if (!account) return c.json({ error: 'That account is not registered.' }, 404);
    const policy = readPolicy()!;
    const identity = policy.neverUses(account.path) ? null : metadata(account.path);
    if (!policy.accept(account.path, identity))
      return c.json({ error: 'This sign-in cannot be used. Sign in again.' }, 409);
    noteSigninRepaired('claude-code', account.path);
    return c.json({ ok: true, identity: policy.assess(account.path, identity) });
  });
  return router;
}
