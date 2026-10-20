/**
 * `/api/session-relay/passkeys`: the approvals passkeys this computer accepts
 * approvals from the web with (spec `everything-is-a-space` B4c; Security's
 * Musts 2 and 3). Mounted inside `routes/session-relay.ts`, so the whole group
 * answers the `/api` 404 on a hub and while the experiment is off.
 *
 * - `GET /`: the pinned approve page and passkeys, labels and dates only,
 *   never key material. The person at this computer only.
 * - `POST /start`: the person at this computer, with the owner's password, on
 *   a linked computer. Writes an enrol statement
 *   (`services/core/session-relay/passkeys/passkey-enrolment.ts`) and answers the
 *   approve page to open.
 * - `POST /finish`: the loopback return page at `GET /relay-passkey`
 *   (`routes/relay-passkey-page.ts`). See "Why `/finish` needs no session".
 *
 * ## Why `/finish` needs no session
 *
 * The return page opens in the system browser, which may not be signed in
 * here even when this computer asks for a password, so the login gate lets
 * this one path through (`services/core/auth/session-gate.ts`). In its place:
 *
 * 1. a direct loopback caller: the request classifier's `this-computer`, so no
 *    marked listener (Wi-Fi, a tunnel, the relay), no proxy forwarding header,
 *    a loopback peer and `Host`, and no page elsewhere in `Origin`; and no
 *    agent identity or approval token;
 * 2. an `Origin` that is exactly the return page's own (the live statement's
 *    `returnTo` origin) and a JSON body, so only that page's own script can
 *    send it;
 * 3. the exact live enrol statement. It is the capability: minted only by
 *    `/start`, after the owner's password and the person at this computer;
 *    delivered only in a URL fragment to the browser the owner opened (never
 *    to a server's logs); good for one attempt, pass or fail; dead after two
 *    minutes. Without it nothing is pinned.
 * - `DELETE /:credentialId`: the person at this computer, with the password.
 * - `DELETE /`: the same bar; removes a keys file that is damaged (the list
 *   says `damaged: true`), so a passkey can be added again.
 *
 * Only a request the classifier calls this computer passes any of these, so
 * a container install, reached through its bridge, cannot add a passkey.
 *
 * Every key added or removed is audited by the store, as the caller who asked,
 * on the `app` surface; every refused finish is audited with why.
 *
 * @module routes/session-relay-passkeys
 */
import { Hono, type Context } from 'hono';
import {
  SessionRelayPasskeyFinishBodySchema,
  SessionRelayPasskeyRemoveBodySchema,
  SessionRelayPasskeyStartBodySchema,
  type SessionRelayPasskeyList,
} from '@dorkos/shared/session-relay-link';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { classifyRequest } from '../lib/request-classifier.js';
import { currentServerRole } from '../lib/server-role.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { APPROVAL_TOKEN_HEADER } from '../services/core/capabilities/approval-wording.js';
import { errorBody } from '../lib/route-utils.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import {
  ApprovalKeyStoreError,
  UNREADABLE_KEYS_REFUSAL,
  addApprovalKey,
  approvalKeysUnreadable,
  readApprovalKeys,
  removeApprovalKey,
  removeDamagedApprovalKeys,
  KEYS_READ_ERROR,
  type RemoveDamagedResult,
  type ApprovalKey,
  type ApprovalKeys,
  type ApprovalRelyingParty,
} from '../services/core/session-relay/approval-key-store.js';
import { relayOwnerActor } from '../services/core/session-relay/live-deps.js';
import {
  passkeyEnrolment,
  type EnrolFinishRefusal,
  type EnrolStartRefusal,
  type PasskeyEnrolment,
} from '../services/core/session-relay/passkeys/passkey-enrolment.js';
import type { RelayAuditDeps } from '../services/core/session-relay/relay-audit.js';
import type { RelayPin } from '../services/core/session-relay/pin-store.js';

/** What the passkey routes read and change, injectable for tests. */
export interface SessionRelayPasskeyDeps {
  /** The pinned keys, or `null` when none. */
  readKeys: () => ApprovalKeys | null;
  /** Whether the keys file is there but damaged. */
  keysUnreadable: () => boolean;
  /** Pin a key. */
  addKey: (
    party: ApprovalRelyingParty,
    key: ApprovalKey,
    audit: RelayAuditDeps,
    stillLinked: () => boolean
  ) => Promise<unknown>;
  /** Unpin a key. */
  removeKey: (credentialId: string, audit: RelayAuditDeps) => Promise<boolean>;
  /** Remove a damaged keys file. */
  removeDamaged: (audit: RelayAuditDeps) => Promise<RemoveDamagedResult>;
  /** The one live enrolment. */
  enrolment: PasskeyEnrolment;
  /** Who the audit log names for a key added or removed here, and its writer. */
  audit: RelayAuditDeps;
}

/**
 * The store records every key added or removed through the relay's audit
 * writer; here that is the request's own caller, on the `app` surface, since
 * a passkey is only ever added or removed at this computer.
 */
const appAudit: RelayAuditDeps = {
  owner: relayOwnerActor,
  recordAudit: (input) => {
    const { actor: _owner, source: _relay, ...rest } = input;
    recordAudit({ ...rest, source: { surface: 'app' } });
  },
};

/** The live passkey store and enrolment. */
export const livePasskeyDeps: SessionRelayPasskeyDeps = {
  readKeys: () => readApprovalKeys(),
  keysUnreadable: () => approvalKeysUnreadable(),
  addKey: (party, key, audit, stillLinked) =>
    addApprovalKey(party, key, audit, undefined, stillLinked),
  removeKey: (credentialId, audit) => removeApprovalKey(credentialId, audit),
  removeDamaged: (audit) => removeDamagedApprovalKeys(audit),
  enrolment: passkeyEnrolment(),
  audit: appAudit,
};

/** The two bars `routes/session-relay.ts` already answers with. */
export interface SessionRelayBars {
  /** The person-at-this-computer refusal, or `undefined` to go on. */
  refusePerson: (c: Context<ApiEnv>) => Response | undefined;
  /** The password step-up's refusal, or `undefined` once it matched. */
  refusePassword: (
    c: Context<ApiEnv>,
    password: string | undefined
  ) => Promise<Response | undefined>;
  /** The stored pin. */
  readPin: () => RelayPin | null;
}

/** `/finish` from anywhere but a direct loopback caller. */
const NOT_HERE = 'Add the passkey on the computer DorkOS runs on.';

/** `/finish` from anything but the return page's own script. */
const WRONG_PAGE = 'Add the passkey from the page this computer opened. Start again in Settings.';

/** Code for every refusal on these routes but the two bars'. */
export const SESSION_RELAY_PASSKEY_CODE = 'SESSION_RELAY_PASSKEY';

const START_REFUSALS: Record<EnrolStartRefusal, { status: 400 | 409 | 500; error: string }> = {
  'bad-origin': { status: 400, error: 'That approve page isn’t a valid https address.' },
  'other-origin': {
    status: 409,
    error: 'Your passkeys use another approve page. Remove them to switch.',
  },
  // A self-hosted hub that names no account has no user handle to build yet;
  // a follow-up gives those hubs a way in. Until then, refused.
  'no-account': { status: 409, error: 'This hub doesn’t name an account yet.' },
  'hub-origin': { status: 400, error: 'The approve page can’t be your hub itself.' },
  'cloud-only': {
    status: 400,
    error: 'A DorkOS account uses the DorkOS approve page. Leave it unset.',
  },
  'cannot-start': {
    status: 500,
    error: 'Couldn’t start adding a passkey here. Try again in the app.',
  },
};

const FINISH_REFUSALS: Record<EnrolFinishRefusal, { status: 400 | 409 | 410; error: string }> = {
  'no-enrolment': { status: 409, error: 'Start adding the passkey again in Settings.' },
  'not-this-statement': {
    status: 400,
    error: 'That passkey wasn’t for this request. Start again in Settings.',
  },
  expired: { status: 410, error: 'That took too long. Start again in Settings.' },
  unlinked: { status: 409, error: 'This computer’s link changed. Start again in Settings.' },
  'not-verified': {
    status: 400,
    error: 'The passkey couldn’t be checked. Start again in Settings.',
  },
  algorithm: { status: 400, error: 'That kind of passkey isn’t supported. Try another.' },
  'already-added': { status: 409, error: 'That passkey is already added.' },
};

/** Record one passkey write, actor from the request's own scope. */
function audit(
  action: string,
  operation: 'create' | 'remove',
  summary: string,
  outcome: 'ok' | 'refused',
  error?: string
): void {
  recordAudit({
    action: `session-relay.passkey.${action}`,
    operation,
    outcome,
    ...(error ? { error } : {}),
    target: { type: 'session-relay', id: 'this-computer' },
    summary,
    source: { surface: 'app' },
  });
}

/** The keys as Settings lists them: never key material. */
function listOf(keys: ApprovalKeys | null, damaged = false): SessionRelayPasskeyList {
  return {
    ...(damaged ? { damaged: true } : {}),
    rpId: keys?.rpId ?? null,
    origin: keys?.origin ?? null,
    keys: (keys?.keys ?? []).map(({ credentialId, label, addedAt, alg }) => ({
      credentialId,
      label,
      addedAt,
      alg,
    })),
  };
}

/**
 * Build the routes mounted at `/api/session-relay/passkeys`.
 *
 * @param deps - The store and enrolment; the live ones by default.
 * @param bars - The person and password bars, and the pin.
 */
export function createSessionRelayPasskeyRoutes(
  deps: SessionRelayPasskeyDeps,
  bars: SessionRelayBars
): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();
  const refuse = (c: Context<ApiEnv>, status: 400 | 404 | 409 | 410 | 500, error: string) =>
    c.json(errorBody(error, SESSION_RELAY_PASSKEY_CODE), status);

  router.get(
    '/',
    (c) => bars.refusePerson(c) ?? c.json(listOf(deps.readKeys(), deps.keysUnreadable()))
  );

  router.post('/start', async (c) => {
    const personRefusal = bars.refusePerson(c);
    if (personRefusal) return personRefusal;
    const parsed = SessionRelayPasskeyStartBodySchema.safeParse(readJsonBody(c));
    if (!parsed.success) return refuse(c, 400, 'Name the passkey, up to 64 characters.');
    const passwordRefusal = await bars.refusePassword(c, parsed.data.password);
    if (passwordRefusal) return passwordRefusal;
    const pin = bars.readPin();
    if (!pin) return refuse(c, 409, 'Link this computer to your hub first.');
    if (deps.keysUnreadable()) return refuse(c, 409, UNREADABLE_KEYS_REFUSAL);
    const started = await deps.enrolment.start({
      computerId: pin.computerId,
      computerName: pin.computerName,
      accountId: pin.accountId,
      label: parsed.data.label,
      ...(parsed.data.origin !== undefined ? { origin: parsed.data.origin } : {}),
      ...(parsed.data.rpId !== undefined ? { rpId: parsed.data.rpId } : {}),
      pinned: deps.readKeys(),
      hubOrigin: pin.hubOrigin,
      issuer: pin.issuer,
      // The address and port this request reached: the server's own, on loopback.
      localAddress: c.env.incoming.socket.localAddress,
      port: c.env.incoming.socket.localPort,
    });
    if (typeof started === 'string') {
      const { status, error } = START_REFUSALS[started];
      return refuse(c, status, error);
    }
    return c.json(started);
  });

  router.post('/finish', async (c) => {
    // No session here (see the module doc): the strict loopback bar instead.
    const facts = honoRequestFacts(c);
    if (
      classifyRequest(facts, currentServerRole()).kind !== 'this-computer' ||
      presentsAgentIdentity(facts) ||
      facts.headers[APPROVAL_TOKEN_HEADER] !== undefined
    ) {
      return c.json(errorBody(NOT_HERE, SESSION_RELAY_PASSKEY_CODE), 403);
    }
    const expectedOrigin = deps.enrolment.returnOrigin();
    if (
      expectedOrigin !== null &&
      (facts.headers.origin !== expectedOrigin ||
        !/^application\/json(?:;|$)/i.test(facts.headers['content-type'] ?? ''))
    ) {
      // Not the return page's own script: the statement is used up all the same.
      deps.enrolment.cancel();
      audit('add', 'create', 'Refused a passkey for approvals from the web', 'refused', 'origin');
      return c.json(errorBody(WRONG_PAGE, SESSION_RELAY_PASSKEY_CODE), 403);
    }
    const parsed = SessionRelayPasskeyFinishBodySchema.safeParse(readJsonBody(c));
    // An unreadable body still uses up the live statement: each is tried once.
    const result = parsed.success
      ? await deps.enrolment.finish(parsed.data, deps.readKeys(), bars.readPin())
      : (deps.enrolment.cancel(), { ok: false as const, refusal: 'not-verified' as const });
    if (!result.ok) {
      // Nothing was open, so nothing was refused: no audit row for a stray post.
      if (result.refusal !== 'no-enrolment') {
        audit(
          'add',
          'create',
          'Refused a passkey for approvals from the web',
          'refused',
          result.refusal
        );
      }
      const { status, error } = FINISH_REFUSALS[result.refusal];
      return refuse(c, status, error);
    }
    try {
      // The pin again, inside the keys file's lock: an Unlink during the
      // checks above means no key lands.
      const { computerId, accountId } = result.link;
      await deps.addKey(result.party, result.key, deps.audit, () => {
        const pin = bars.readPin();
        return pin?.computerId === computerId && pin.accountId === accountId;
      });
    } catch (error) {
      if (!(error instanceof ApprovalKeyStoreError)) throw error;
      audit('add', 'create', 'Refused a passkey for approvals from the web', 'refused', 'store');
      return refuse(c, 409, error.message);
    }
    return c.json(listOf(deps.readKeys()));
  });

  // A damaged keys file, which cannot be read to remove one key from it.
  router.delete('/', async (c) => {
    const personRefusal = bars.refusePerson(c);
    if (personRefusal) return personRefusal;
    const parsed = SessionRelayPasskeyRemoveBodySchema.safeParse(readJsonBody(c) ?? {});
    const passwordRefusal = await bars.refusePassword(
      c,
      parsed.success ? parsed.data.password : undefined
    );
    if (passwordRefusal) return passwordRefusal;
    const removed = await deps.removeDamaged(deps.audit);
    if (removed === 'read-error') return refuse(c, 500, KEYS_READ_ERROR);
    if (removed === 'not-damaged') return refuse(c, 409, 'Remove passkeys one at a time.');
    return c.json(listOf(deps.readKeys(), false));
  });

  router.delete('/:credentialId', async (c) => {
    const personRefusal = bars.refusePerson(c);
    if (personRefusal) return personRefusal;
    const parsed = SessionRelayPasskeyRemoveBodySchema.safeParse(readJsonBody(c) ?? {});
    const passwordRefusal = await bars.refusePassword(
      c,
      parsed.success ? parsed.data.password : undefined
    );
    if (passwordRefusal) return passwordRefusal;
    const removed = await deps.removeKey(c.req.param('credentialId'), deps.audit);
    if (!removed) return refuse(c, 404, 'That passkey isn’t added here.');
    return c.json(listOf(deps.readKeys()));
  });

  return router;
}
