/**
 * `/api/session-relay`: the computer's own switch for chatting with its agents
 * from the web, through the owner's hub (spec `everything-is-a-space` step B3,
 * DOR-2946; ADR 261015-042933 rules 4 and 5).
 *
 * - `GET /status`: where the link stands, for anyone the session gate let in.
 *   Never the relay secret.
 * - `GET /presence` and `GET /devices`: whether someone is using this
 *   computer from the web now, and the browsers seen here, for anyone the
 *   session gate let in but an agent, as the live event goes to the owner's
 *   windows only. Labels and times only, never what was said.
 * - `POST /presence/end`: end use from the web now. Behind the same bar as
 *   the writes below; it closes the relay and pauses the link, as Pause does,
 *   so it needs no password: it only narrows access.
 * - `POST /link`, `PATCH /level`, `POST /pause`, `POST /resume` and
 *   `DELETE /link`: behind {@link requirePersonAtThisComputer}, the owner at
 *   this computer using the app, so nothing reached from the web (the relay
 *   itself included) can link a computer, raise what the web may do, or undo
 *   a pause. Linking also needs an owner account, since the relay only ever
 *   serves one.
 * - `/passkeys`: the approvals passkeys a web approval is signed with, behind
 *   the same two bars (`routes/session-relay-passkeys.ts`, B4c).
 * - **The owner's password, on top, for every change that opens access or
 *   raises it**: linking, raising the level to Full control, resuming, and
 *   adding or removing an approvals passkey. The
 *   bar above cannot tell the app from an agent's shell calling loopback while
 *   this computer asks for no password (DOR-505); the agent does not have the
 *   owner's password (`services/core/auth/owner-password.ts`). This holds in
 *   every posture, a browser session included. Pausing, lowering the level and
 *   unlinking only narrow access, so they need no password. The step-up covers
 *   the API and MCP paths only: anything that can write the data folder (an
 *   agent with a shell, say) can still write a pin directly, as it could open
 *   any other channel. That is the DOR-505 class, tracked separately.
 * - Every change to the pin runs one at a time (`withRelayPinLock`) and reads
 *   the pin inside the lock, so a resume racing an unlink cannot bring it back.
 *
 * Unlinking and pausing work with the network off: they change the pin file
 * and close the live connection, and tell nobody. The hub learns when the
 * dial stops.
 *
 * The whole group answers the `/api` 404 on a hub and while the
 * `sessionRelay.enabled` experiment is off. Every write is audited, never with
 * the code or the secret.
 *
 * @module routes/session-relay
 */
import { Hono, type Context } from 'hono';
import {
  SessionRelayLevelBodySchema,
  SessionRelayLinkBodySchema,
  SessionRelayResumeBodySchema,
  type SessionRelayDevice,
  type SessionRelayLinkRefusal,
  type SessionRelayPresence,
  type SessionRelayStatus,
} from '@dorkos/shared/session-relay-link';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { requirePersonAtThisComputer } from '../lib/caller-authority.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
import { errorBody } from '../lib/route-utils.js';
import { currentServerRole } from '../lib/server-role.js';
import { recordAudit } from '../services/audit/audit-trail.js';
import { AUTH_REQUIRED_FOR_EXPOSURE, canExpose } from '../services/core/auth/exposure-guard.js';
import {
  checkOwnerPassword,
  type OwnerPasswordCheck,
} from '../services/core/auth/owner-password.js';
import {
  closeSessionRelay,
  sessionRelayConnected,
  sessionRelayDevices,
  sessionRelayEnabled,
  sessionRelayPresence,
} from '../services/core/session-relay/index.js';
import {
  clearRelayPin,
  readRelayPin,
  updateRelayPin,
  withRelayPinLock,
  type RelayPin,
} from '../services/core/session-relay/pin-store.js';
import {
  defaultComputerName,
  linkToHub,
  type LinkToHubResult,
} from '../services/core/session-relay/relay-link.js';
import {
  createSessionRelayPasskeyRoutes,
  livePasskeyDeps,
  type SessionRelayPasskeyDeps,
} from './session-relay-passkeys.js';

/** Refusal code for a write from anywhere but the owner at this computer. */
export const SESSION_RELAY_NEEDS_THIS_COMPUTER = 'SESSION_RELAY_NEEDS_THIS_COMPUTER';

/** What the routes read and change, injectable for tests. */
export interface SessionRelayRouteDeps {
  /** Whether this server is a hub. */
  isHub: () => boolean;
  /** Whether the experiment is on. */
  enabled: () => boolean;
  /** Whether an owner account exists. */
  ownerExists: () => boolean;
  /** The stored pin, paused or not. */
  readPin: () => RelayPin | null;
  /** Change the level or the pause. */
  updatePin: (patch: Partial<Pick<RelayPin, 'level' | 'paused'>>) => Promise<RelayPin | null>;
  /** Forget the pin and close the live connection. */
  clearPin: () => void;
  /** Close the live connection, keeping the pin. */
  closeRelay: () => void;
  /** Whether the relay connection is open now. */
  connected: () => boolean;
  /** Link to a hub. */
  link: (input: { linkCode: string; computerName: string }) => Promise<LinkToHubResult>;
  /** The name to offer when linking. */
  suggestedName: () => string;
  /** Check the install owner's password. */
  checkPassword: (password: string | undefined) => Promise<OwnerPasswordCheck>;
  /** Whether someone is using this computer from the web now. */
  presence: () => SessionRelayPresence;
  /** Every browser seen here, most recent first. */
  devices: () => SessionRelayDevice[];
  /** The approvals passkeys and their enrolment (`routes/session-relay-passkeys.ts`). */
  passkeys: SessionRelayPasskeyDeps;
}

const liveDeps: SessionRelayRouteDeps = {
  isHub: () => currentServerRole() === 'hub',
  enabled: sessionRelayEnabled,
  ownerExists: canExpose,
  readPin: () => readRelayPin(),
  updatePin: (patch) => updateRelayPin(patch),
  clearPin: () => clearRelayPin(undefined, closeSessionRelay),
  closeRelay: closeSessionRelay,
  connected: sessionRelayConnected,
  link: (input) => linkToHub(input),
  suggestedName: defaultComputerName,
  checkPassword: (password) => checkOwnerPassword(password),
  presence: () => sessionRelayPresence().snapshot(),
  devices: () => sessionRelayDevices().list(),
  passkeys: livePasskeyDeps,
};

/** Code for every refusal of the password step-up. */
export const SESSION_RELAY_PASSWORD_CODE = 'SESSION_RELAY_PASSWORD';

/** The status and sentence for each way the password step-up can refuse. */
const PASSWORD_REFUSALS: Record<
  Exclude<OwnerPasswordCheck, 'ok'>,
  { status: 403 | 409 | 429; error: string }
> = {
  required: { status: 403, error: 'Enter your password for this computer.' },
  wrong: { status: 403, error: 'That password didn’t match. Try again.' },
  'too-many-attempts': {
    status: 429,
    error: 'Too many wrong passwords. Try again in a few minutes.',
  },
  'no-owner': { status: 409, error: 'Create an owner account first, then link.' },
  'no-password': { status: 409, error: 'Set a password for this computer’s owner first.' },
};

/** The sentence and status for each way linking can fail. */
const LINK_REFUSALS: Record<SessionRelayLinkRefusal, { status: 400 | 409 | 502; error: string }> = {
  'bad-code': { status: 400, error: 'That isn’t a link code. Copy it again from your hub.' },
  'hub-unreachable': { status: 502, error: 'Couldn’t reach your hub. Try again.' },
  'hub-refused': { status: 409, error: 'Your hub didn’t accept that code. Make a new one.' },
  'signature-failed': { status: 502, error: 'Your hub couldn’t be verified. Nothing was linked.' },
  'different-account': {
    status: 409,
    error: 'That hub isn’t owned by your DorkOS account.',
  },
  'not-public': {
    status: 400,
    error: 'That code points to a private address. Use your hub’s code.',
  },
  'already-linked': {
    status: 409,
    error: 'This computer is already linked. Remove it on your hub first.',
  },
  'account-unreadable': {
    status: 502,
    error: 'Couldn’t check your DorkOS account. Try again.',
  },
};

/** Record one write, actor taken from the request's own scope. */
function audit(
  action: string,
  operation: 'create' | 'modify' | 'remove',
  summary: string,
  outcome: 'ok' | 'refused' | 'failed',
  error?: string
): void {
  recordAudit({
    action: `session-relay.${action}`,
    operation,
    outcome,
    ...(error ? { error } : {}),
    target: { type: 'session-relay', id: 'this-computer' },
    summary,
    source: { surface: 'app' },
  });
}

/**
 * Build the routes mounted at `/api/session-relay`.
 *
 * @param deps - Seams for tests; the live relay by default.
 */
export function createSessionRelayRoutes(deps: SessionRelayRouteDeps = liveDeps): Hono<ApiEnv> {
  const router = new Hono<ApiEnv>();

  /** Where the link stands now. */
  function status(): SessionRelayStatus {
    const pin = deps.readPin();
    return {
      linked: pin !== null,
      hubOrigin: pin?.hubOrigin ?? null,
      computerName: pin?.computerName ?? null,
      level: pin?.level ?? 'chat',
      paused: pin?.paused ?? false,
      connected: pin !== null && !pin.paused && deps.connected(),
      pinnedAt: pin?.pinnedAt ?? null,
      suggestedName: deps.suggestedName(),
    };
  }

  /** The person-at-this-computer bar's refusal, or `undefined` to go on. */
  function refusePerson(c: Context<ApiEnv>): Response | undefined {
    const refusal = requirePersonAtThisComputer(honoRequestFacts(c));
    if (!refusal) return undefined;
    return c.json(
      errorBody(
        refusal === 'not-at-this-computer'
          ? 'Change this on the computer DorkOS runs on.'
          : 'Only you can change this, in the app on this computer.',
        SESSION_RELAY_NEEDS_THIS_COMPUTER
      ),
      403
    );
  }

  /** The password step-up's refusal, or `undefined` once it matched. */
  async function refusePassword(
    c: Context<ApiEnv>,
    password: string | undefined
  ): Promise<Response | undefined> {
    const check = await deps.checkPassword(password);
    if (check === 'ok') return undefined;
    const { status: code, error } = PASSWORD_REFUSALS[check];
    const body = errorBody(error, SESSION_RELAY_PASSWORD_CODE);
    return c.json({ ...body, reason: check }, code);
  }

  // The whole group is off on a hub and while the experiment is off.
  router.use('*', async (c, next) => {
    if (deps.isHub() || !deps.enabled()) {
      return c.json(errorBody('Not found', 'API_NOT_FOUND'), 404);
    }
    c.header('Cache-Control', 'no-store');
    await next();
  });

  router.get('/status', (c) => c.json(status()));

  router.post('/link', async (c) => {
    const refusal = refusePerson(c);
    if (refusal) return refusal;
    const parsed = SessionRelayLinkBodySchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json(errorBody(LINK_REFUSALS['bad-code'].error, 'bad-code'), 400);
    }
    if (!deps.ownerExists()) {
      // The relay serves only an owner, so there must be one to serve.
      return c.json(
        errorBody('Create an owner account first, then link.', AUTH_REQUIRED_FOR_EXPOSURE),
        409
      );
    }
    const passwordRefusal = await refusePassword(c, parsed.data.password);
    if (passwordRefusal) return passwordRefusal;
    const result = await withRelayPinLock(() =>
      deps.link({
        linkCode: parsed.data.linkCode,
        computerName: parsed.data.computerName ?? deps.suggestedName(),
      })
    );
    if (!result.ok) {
      audit('link', 'create', 'Could not link this computer to a hub', 'refused', result.reason);
      const { status: code, error } = LINK_REFUSALS[result.reason];
      return c.json(errorBody(error, result.reason), code);
    }
    audit('link', 'create', `Linked this computer to ${result.pin.hubOrigin}`, 'ok');
    return c.json(status());
  });

  router.patch('/level', async (c) => {
    const refusal = refusePerson(c);
    if (refusal) return refusal;
    const parsed = SessionRelayLevelBodySchema.safeParse(readJsonBody(c));
    if (!parsed.success) {
      return c.json(errorBody('Choose chat or full.', 'INVALID_LEVEL'), 400);
    }
    const { level, password } = parsed.data;
    // Raising what the web may do needs the password; lowering it does not.
    if (level === 'full') {
      const passwordRefusal = await refusePassword(c, password);
      if (passwordRefusal) return passwordRefusal;
    }
    const pin = await withRelayPinLock(() => deps.updatePin({ level }));
    if (!pin) return c.json(errorBody('This computer isn’t linked.', 'NOT_LINKED'), 409);
    audit('level', 'modify', `Set what the web may do here to ${pin.level}`, 'ok');
    return c.json(status());
  });

  /** Pause or resume: the pin's flag, and pausing closes the live connection. */
  async function setPaused(c: Context<ApiEnv>, paused: boolean): Promise<Response> {
    const refusal = refusePerson(c);
    if (refusal) return refusal;
    if (!paused) {
      const parsed = SessionRelayResumeBodySchema.safeParse(readJsonBody(c) ?? {});
      const passwordRefusal = await refusePassword(
        c,
        parsed.success ? parsed.data.password : undefined
      );
      if (passwordRefusal) return passwordRefusal;
    }
    const pin = await withRelayPinLock(async () => {
      const next = await deps.updatePin({ paused });
      // Inside the lock, so no resume can open a relay after this pause.
      if (next && paused) deps.closeRelay();
      return next;
    });
    if (!pin) return c.json(errorBody('This computer isn’t linked.', 'NOT_LINKED'), 409);
    audit(
      paused ? 'pause' : 'resume',
      'modify',
      paused ? 'Paused chatting from the web' : 'Resumed chatting from the web',
      'ok'
    );
    return c.json(status());
  }

  /** The browsers using this computer are the owner's to see, never an agent's. */
  function refuseAgent(c: Context<ApiEnv>): Response | undefined {
    if (!presentsAgentIdentity(honoRequestFacts(c))) return undefined;
    return c.json(errorBody('Only you can see this.', 'FORBIDDEN'), 403);
  }

  router.get('/presence', (c) => refuseAgent(c) ?? c.json(deps.presence()));

  router.get('/devices', (c) => refuseAgent(c) ?? c.json({ devices: deps.devices() }));

  // End use from the web now: pause the link and close the relay, as Pause
  // does. The live connection ending is what tells the open windows.
  router.post('/presence/end', async (c) => {
    const refusal = refusePerson(c);
    if (refusal) return refusal;
    const pin = await withRelayPinLock(async () => {
      const next = await deps.updatePin({ paused: true });
      if (next) deps.closeRelay();
      return next;
    });
    if (!pin) return c.json(errorBody('This computer isn’t linked.', 'NOT_LINKED'), 409);
    audit('presence.end', 'modify', 'Ended use from the web and paused chat from the web', 'ok');
    return c.json(deps.presence());
  });

  // The approvals passkeys, behind the same two bars (B4c).
  router.route(
    '/passkeys',
    createSessionRelayPasskeyRoutes(deps.passkeys, {
      refusePerson,
      refusePassword,
      readPin: deps.readPin,
    })
  );

  router.post('/pause', (c) => setPaused(c, true));
  router.post('/resume', (c) => setPaused(c, false));

  router.delete('/link', async (c) => {
    const refusal = refusePerson(c);
    if (refusal) return refusal;
    const had = await withRelayPinLock(() => {
      const pin = deps.readPin();
      deps.clearPin();
      return pin;
    });
    if (had) audit('unlink', 'remove', `Unlinked this computer from ${had.hubOrigin}`, 'ok');
    return c.json(status());
  });

  return router;
}
