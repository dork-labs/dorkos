/**
 * Who may create an account here, decided per request (ADR 261015-125850 rule
 * 4; spec `specs/request-classifier` section 6).
 *
 * One function answers with a mode, and the sign-up hook in `./index.ts` acts
 * on it:
 *
 * - **`local-open`**: no account exists yet and the request comes from this
 *   computer, so its person may create the owner.
 * - **`setup-code`**: no account exists yet and the request comes from another
 *   device. Creating the owner from there will need the setup code this
 *   computer prints (F5, DOR-2968). Until F5 ships, the hook still allows it,
 *   which is today's behavior and the "one release of loud warning" that ADR
 *   rule 11 gives existing Docker installs.
 * - **`provisioned`**: a hub, whose owner comes from provisioning (A2,
 *   DOR-2934). Every sign-up request is refused.
 * - **`closed`**: an account exists, or the caller is the session relay, which
 *   is never a person.
 *
 * ## Getting the request to the hook
 *
 * Better Auth's database hook sees no socket. `http/better-auth.ts` classifies
 * each request and runs Better Auth inside {@link withRegistrationCaller}; the
 * hook reads {@link currentRegistrationCaller}. With no scope the call came
 * from no network request at all (server code calling `auth.api` directly, or
 * a test), and it is `in-process`: only code in this process can make one.
 * The CLI's `dorkos auth` uses its own Better Auth instance and hook
 * (`packages/cli/src/commands/auth-instance.ts`) and never reaches this one.
 *
 * @module services/core/auth/registration-policy
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { RequestClass } from '../../../lib/request-classifier.js';
import type { ServerRole } from '../../../lib/server-role.js';

/** How an owner-less sign-up is treated for one request. */
export type RegistrationMode = 'local-open' | 'setup-code' | 'provisioned' | 'closed';

/** Who is signing up: a classified request, or code in this process. */
export type RegistrationCaller = RequestClass | 'in-process';

/** What {@link decideRegistration} reads. */
export interface RegistrationFacts {
  /** The request's class, or `in-process` for a call no network request made. */
  caller: RegistrationCaller;
  /** Whether any account exists. */
  hasUsers: boolean;
  /** What this server is (`currentServerRole`). */
  role: ServerRole;
}

/**
 * The registration mode for one sign-up attempt.
 *
 * Rules, first match wins: a hub is `provisioned`; an existing account makes
 * it `closed`; this computer (or code in this process) is `local-open`; the
 * relay is `closed`; any other device is `setup-code`.
 *
 * @param facts - The caller, whether an account exists, and the server role.
 */
export function decideRegistration(facts: RegistrationFacts): RegistrationMode {
  if (facts.role === 'hub') return 'provisioned';
  if (facts.hasUsers) return 'closed';
  const { caller } = facts;
  if (caller === 'in-process' || caller.kind === 'this-computer') return 'local-open';
  if (caller.kind === 'relayed') return 'closed';
  return 'setup-code';
}

/**
 * Whether a mode lets the owner be created right now. `setup-code` still does
 * until F5 (DOR-2968) checks the code here.
 *
 * @param mode - The decided mode.
 */
export function registrationAllowed(mode: RegistrationMode): boolean {
  return mode === 'local-open' || mode === 'setup-code';
}

const scope = new AsyncLocalStorage<RequestClass>();

/**
 * Run `fn` with `caller` as the request every sign-up inside it came from.
 *
 * @param caller - The classified request.
 * @param fn - The work, typically Better Auth's handler.
 */
export function withRegistrationCaller<T>(caller: RequestClass, fn: () => T): T {
  return scope.run(caller, fn);
}

/** The request a sign-up in progress came from, or `in-process` outside any request. */
export function currentRegistrationCaller(): RegistrationCaller {
  return scope.getStore() ?? 'in-process';
}
