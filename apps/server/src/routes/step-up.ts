/**
 * `/api/step-up/:heldActionId`: read, confirm or cancel an action a guarded
 * route held for a "Confirm it's you" step-up (DOR-3234,
 * `routes/step-up-guard.ts`).
 *
 * - `GET` reads the held action as the sheet shows it: the server's own
 *   sentence about what will run, and how it may be confirmed from here.
 * - `POST /password` confirms it with the owner's password, and only then
 *   runs it, answering with the action's own status and body.
 * - `POST /change-password` is for an owner whose password is shorter than
 *   the minimum: the current one is checked first, replaced, and then the
 *   action runs.
 * - `DELETE` cancels it. Nothing ran, so nothing changes.
 *
 * The caller names a held action and nothing else: what runs, and its hash,
 * were fixed when the route held it. Every write needs:
 *
 * - **The app's own page:** an `Origin` header that is exactly one of this
 *   server's own origins, port included, and no `Sec-Fetch-Site` but
 *   `same-origin`.
 * - **A person, not a program:** no agent identity, no approval token, no
 *   `Authorization` header.
 * - **The browser that asked:** the session that held the action.
 * - **A connection the password may cross:** this computer, or an encrypted
 *   connection from another device. Never plain `http` from another device.
 *
 * Wrong passwords count against the held action (it is dropped after
 * `STEP_UP_MAX_PASSWORD_TRIES`, five) and against the owner's one global
 * throttle (`owner-password.ts`). Every confirm is written to Activity; the
 * password never is.
 *
 * @module routes/step-up
 */
import { Hono, type Context } from 'hono';

import {
  StepUpChangePasswordBodySchema,
  StepUpPasswordBodySchema,
  type HeldStepUpView,
  type StepUpConfirmedBody,
  type StepUpPasswordUnavailable,
  type StepUpRefusalCode,
} from '@dorkos/shared/step-up';

import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { logger } from '../lib/logger.js';
import { errorBody } from '../lib/route-utils.js';
import { resolveTrustedOrigins } from '../lib/trusted-origins.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import { APPROVAL_TOKEN_HEADER } from '../services/core/capabilities/index.js';
import { getAuth, readOwnerAccount } from '../services/core/auth/index.js';
import { isAtThisComputer, isOnEncryptedConnection } from '../services/core/auth/gate-policy.js';
import {
  checkOwnerPassword,
  ownerPasswordMinLength,
  ownerPasswordRetryAfterMs,
  type OwnerPasswordCheck,
} from '../services/core/auth/owner-password.js';
import {
  cancelHeldStepUp,
  peekHeldStepUp,
  spendStepUpTry,
  takeHeldStepUp,
  type HeldStepUp,
} from '../services/core/auth/step-up/step-up-holds.js';

/** The longest password Better Auth stores. */
const MAX_PASSWORD_LENGTH = 128;

/** What the routes read, injectable for tests. */
export interface StepUpRouteDeps {
  /** The install owner's id, or `null`. */
  ownerId: () => string | null;
  /** The owner's password check, with its global throttle. */
  checkPassword: (password: string | undefined) => Promise<OwnerPasswordCheck>;
  /** The shortest password a step-up accepts. */
  minPasswordLength: () => Promise<number>;
  /** Replace the owner's password. */
  setOwnerPassword: (ownerId: string, password: string) => Promise<void>;
  /** This server's own browser origins. */
  trustedOrigins: () => readonly string[];
}

/** The live owner's password, replaced through Better Auth's own hasher. */
async function setLiveOwnerPassword(ownerId: string, password: string): Promise<void> {
  const auth = getAuth();
  if (!auth) throw new Error('Auth is not initialized');
  const context = await auth.$context;
  await context.internalAdapter.updatePassword(ownerId, await context.password.hash(password));
}

const liveDeps: StepUpRouteDeps = {
  ownerId: () => readOwnerAccount()?.id ?? null,
  checkPassword: (password) => checkOwnerPassword(password),
  minPasswordLength: ownerPasswordMinLength,
  setOwnerPassword: setLiveOwnerPassword,
  trustedOrigins: () => resolveTrustedOrigins(),
};

/**
 * Whether a password may cross this request's connection: at this computer,
 * or encrypted from another device. Never plain `http` from another device.
 */
function passwordMayCross(facts: RequestFacts): boolean {
  return isAtThisComputer(facts) || isOnEncryptedConnection(facts);
}

/** The sentence and status for each refusal. */
const REFUSALS: Record<StepUpRefusalCode, { status: 400 | 403 | 404 | 409 | 429; error: string }> =
  {
    expired: { status: 404, error: 'That took too long. Nothing changed.' },
    'wrong-password': { status: 403, error: 'That’s not your DorkOS password. Try again.' },
    'too-many-tries': { status: 403, error: 'Too many wrong passwords. Nothing changed.' },
    'too-many-attempts': {
      status: 429,
      error: 'Too many wrong passwords. Try again in a few minutes.',
    },
    'password-too-short': {
      status: 409,
      error: 'Your password is too short. Choose a longer one to go on.',
    },
    'new-password-invalid': { status: 400, error: 'Choose a longer password.' },
    'no-password': { status: 409, error: 'Set a password for this computer’s owner first.' },
    'insecure-connection': { status: 403, error: 'Confirm this on the computer running DorkOS.' },
    'not-a-person': { status: 403, error: 'Only you can confirm this, in the DorkOS app.' },
    'not-your-action': { status: 403, error: 'Confirm this in the window that asked.' },
  };

/**
 * Build the routes mounted at `/api/step-up`.
 *
 * @param deps - Seams for tests; the live owner and password check by default.
 */
export function createStepUpRoutes(deps: StepUpRouteDeps = liveDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  function refuse(
    c: Context<ApiEnv>,
    code: StepUpRefusalCode,
    extra: Record<string, unknown> = {}
  ): Response {
    const { status, error } = REFUSALS[code];
    return c.json({ ...errorBody(error, code), ...extra }, status);
  }

  /** Record one confirm, never with the password. */
  function audit(entry: HeldStepUp, outcome: 'ok' | 'refused' | 'failed', reason: string): void {
    recordAudit({
      action: 'step-up.confirm',
      operation: 'modify',
      outcome,
      ...(outcome === 'ok' ? {} : { error: reason }),
      target: { type: 'step-up', id: entry.statement.kind },
      summary:
        outcome === 'ok'
          ? `Confirmed it was them: ${entry.reason}`
          : `A step-up was refused (${reason}): ${entry.reason}`,
      source: { surface: 'app' },
    });
  }

  /**
   * The caller's refusal, when it is not a person in this server's own page,
   * or `undefined`. A read needs no `Origin` (a same-origin `GET` sends none).
   */
  function refuseCaller(c: Context<ApiEnv>, write: boolean): Response | undefined {
    const facts = honoRequestFacts(c);
    const program =
      presentsAgentIdentity(facts) ||
      facts.headers[APPROVAL_TOKEN_HEADER] !== undefined ||
      facts.headers.authorization !== undefined;
    const origin = facts.headers.origin;
    const site = facts.headers['sec-fetch-site'];
    const ownPage =
      (origin === undefined ? !write : deps.trustedOrigins().includes(origin)) &&
      (site === undefined || site === 'same-origin');
    if (program || !ownPage) return refuse(c, 'not-a-person');
    return undefined;
  }

  /** The live held action this caller held, or the refusal. */
  function heldOrRefusal(c: Context<ApiEnv>): HeldStepUp | Response {
    const entry = peekHeldStepUp(c.req.param('heldActionId') ?? '');
    if (!entry) return refuse(c, 'expired');
    const sessionId = honoRequestFacts(c).user?.sessionId ?? null;
    if (entry.sessionId !== sessionId) return refuse(c, 'not-your-action');
    return entry;
  }

  /** Why this caller may not confirm by password, if it may not. */
  function passwordUnavailable(c: Context<ApiEnv>): StepUpPasswordUnavailable | undefined {
    if (!passwordMayCross(honoRequestFacts(c))) return 'insecure-connection';
    return deps.ownerId() ? undefined : 'no-password';
  }

  /**
   * Check a password against the owner's for one held action, counting a
   * wrong one against it. `undefined` once it matched.
   */
  async function refusePassword(
    c: Context<ApiEnv>,
    entry: HeldStepUp,
    password: string | undefined
  ): Promise<Response | undefined> {
    const check = await deps.checkPassword(password);
    if (check === 'ok') return undefined;
    if (check === 'too-many-attempts') {
      const retryAfterSeconds = Math.ceil(ownerPasswordRetryAfterMs() / 1000);
      c.header('Retry-After', String(retryAfterSeconds));
      audit(entry, 'refused', check);
      return refuse(c, 'too-many-attempts', { retryAfterSeconds });
    }
    if (check === 'no-owner' || check === 'no-password') return refuse(c, 'no-password');
    if (check === 'required') {
      return c.json(errorBody('Enter your password.', 'wrong-password'), 400);
    }
    const triesLeft = spendStepUpTry(entry.statement.heldActionId);
    audit(entry, 'refused', triesLeft === 0 ? 'too-many-tries' : 'wrong-password');
    if (triesLeft === 0) return refuse(c, 'too-many-tries');
    return refuse(c, 'wrong-password', { triesLeft });
  }

  /** Take the held action and run it: the one place a held action commits. */
  async function commit(c: Context<ApiEnv>, entry: HeldStepUp): Promise<Response> {
    // Taken before it runs, so a second confirm racing this one finds nothing.
    const taken = takeHeldStepUp(entry.statement.heldActionId);
    if (!taken) return refuse(c, 'expired');
    try {
      const { status, body } = await taken.commit();
      audit(taken, 'ok', 'confirmed');
      const answer: StepUpConfirmedBody = { ok: true, status, result: body };
      return c.json(answer);
    } catch (error) {
      logger.error('[StepUp] A confirmed action failed to run', {
        kind: taken.statement.kind,
        error: (error as Error).name,
      });
      audit(taken, 'failed', 'commit-failed');
      return c.json(errorBody('That didn’t work. Try again.', 'STEP_UP_COMMIT_FAILED'), 500);
    }
  }

  router.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });

  router.get('/:heldActionId', (c) => {
    const callerRefusal = refuseCaller(c, false);
    if (callerRefusal) return callerRefusal;
    const entry = heldOrRefusal(c);
    if (entry instanceof Response) return entry;
    const unavailable = passwordUnavailable(c);
    const view: HeldStepUpView = {
      heldActionId: entry.statement.heldActionId,
      kind: entry.statement.kind,
      reason: entry.reason,
      notes: [...entry.notes],
      expiresAt: entry.statement.expiresAt,
      methods: unavailable ? [] : ['password'],
      ...(unavailable ? { passwordUnavailable: unavailable } : {}),
      triesLeft: entry.triesLeft,
    };
    return c.json(view);
  });

  router.post('/:heldActionId/password', async (c) => {
    const callerRefusal = refuseCaller(c, true);
    if (callerRefusal) return callerRefusal;
    const entry = heldOrRefusal(c);
    if (entry instanceof Response) return entry;
    const unavailable = passwordUnavailable(c);
    if (unavailable) return refuse(c, unavailable);
    const parsed = StepUpPasswordBodySchema.safeParse(readJsonBody(c));
    const password = parsed.success ? parsed.data.password : undefined;
    const passwordRefusal = await refusePassword(c, entry, password);
    if (passwordRefusal) return passwordRefusal;
    // It matched, but a password this short is too easy to guess offline:
    // keep the action held and offer change-and-confirm instead.
    const minLength = await deps.minPasswordLength();
    if ((password ?? '').length < minLength) {
      audit(entry, 'refused', 'password-too-short');
      return refuse(c, 'password-too-short', { minLength });
    }
    return commit(c, entry);
  });

  router.post('/:heldActionId/change-password', async (c) => {
    const callerRefusal = refuseCaller(c, true);
    if (callerRefusal) return callerRefusal;
    const entry = heldOrRefusal(c);
    if (entry instanceof Response) return entry;
    const unavailable = passwordUnavailable(c);
    if (unavailable) return refuse(c, unavailable);
    const parsed = StepUpChangePasswordBodySchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json(errorBody('Enter your password.', 'wrong-password'), 400);
    }
    const { currentPassword, newPassword } = parsed.data;
    const passwordRefusal = await refusePassword(c, entry, currentPassword);
    if (passwordRefusal) return passwordRefusal;
    const minLength = await deps.minPasswordLength();
    if (newPassword.length < minLength || newPassword.length > MAX_PASSWORD_LENGTH) {
      return refuse(c, 'new-password-invalid', { minLength });
    }
    const ownerId = deps.ownerId();
    if (!ownerId) return refuse(c, 'no-password');
    await deps.setOwnerPassword(ownerId, newPassword);
    logger.info('[StepUp] The owner chose a longer password before confirming');
    return commit(c, entry);
  });

  router.delete('/:heldActionId', (c) => {
    const callerRefusal = refuseCaller(c, true);
    if (callerRefusal) return callerRefusal;
    const entry = heldOrRefusal(c);
    if (entry instanceof Response) return entry;
    cancelHeldStepUp(entry.statement.heldActionId);
    return c.body(null, 204);
  });

  return router;
}
