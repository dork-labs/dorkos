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
 *   computer prints (`setup-code.ts`, F5 DOR-2968), checked by the hook in
 *   `setup-code-gate.ts`. A browser at a container's published port is the one
 *   exception, for one release with a loud warning (ADR rule 11).
 * - **`provisioned`**: a hub with no account yet. Its owner comes from
 *   provisioning (A2, DOR-2934): only code running inside
 *   `withRegistrationCaller('provisioning', …)` may create it, and every
 *   sign-up request is refused.
 * - **`closed`**: an account exists, the caller is the session relay, which
 *   is never a person, or this server is an agent computer, which serves no
 *   person at all (DOR-2940), so nobody may create an account there by any
 *   route, this process's own code included.
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

/**
 * Who is signing up: a classified request; hub provisioning creating the owner
 * (A2); or other code in this process.
 */
export type RegistrationCaller = RequestClass | 'provisioning' | 'in-process';

/** What {@link decideRegistration} reads. */
export interface RegistrationFacts {
  /**
   * The request's class, `provisioning` for hub provisioning, or `in-process`
   * for any other call no network request made.
   */
  caller: RegistrationCaller;
  /** Whether any account exists. */
  hasUsers: boolean;
  /** What this server is (`currentServerRole`). */
  role: ServerRole;
}

/**
 * The registration mode for one sign-up attempt.
 *
 * Rules, first match wins: an agent computer is `closed` for every caller; an
 * existing account makes it `closed`; a hub is
 * `provisioned`; provisioning anywhere but a hub is `closed`; this computer (or
 * other code in this process) is `local-open`; the relay, or a hub-kind request
 * on a computer, is `closed`; any other device is `setup-code`.
 *
 * @param facts - The caller, whether an account exists, and the server role.
 */
export function decideRegistration(facts: RegistrationFacts): RegistrationMode {
  if (facts.role === 'agent-computer') return 'closed';
  if (facts.hasUsers) return 'closed';
  if (facts.role === 'hub') return 'provisioned';
  const { caller } = facts;
  if (caller === 'provisioning') return 'closed';
  if (caller === 'in-process' || caller.kind === 'this-computer') return 'local-open';
  if (caller.kind === 'other-device') return 'setup-code';
  return 'closed';
}

/**
 * Whether this caller may create the owner under the decided mode.
 * `setup-code` passes here and is checked by the hook against the setup code
 * (`setup-code-gate.ts`); `provisioned` allows hub provisioning only.
 *
 * @param mode - The decided mode.
 * @param caller - Who is signing up.
 */
export function registrationAllowed(mode: RegistrationMode, caller: RegistrationCaller): boolean {
  if (mode === 'provisioned') return caller === 'provisioning';
  return mode === 'local-open' || mode === 'setup-code';
}

const scope = new AsyncLocalStorage<RequestClass | 'provisioning'>();

/**
 * Run `fn` with `caller` as who every sign-up inside it comes from: the
 * classified request (`http/better-auth.ts`), or `provisioning` for the code
 * that creates a hub's owner (A2).
 *
 * @param caller - The classified request, or `provisioning`.
 * @param fn - The work, typically Better Auth's handler.
 */
export function withRegistrationCaller<T>(caller: RequestClass | 'provisioning', fn: () => T): T {
  return scope.run(caller, fn);
}

/** The request a sign-up in progress came from, or `in-process` outside any request. */
export function currentRegistrationCaller(): RegistrationCaller {
  return scope.getStore() ?? 'in-process';
}
