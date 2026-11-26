/**
 * The computer's own switch for chatting with its agents from the web
 * (`/api/session-relay`, spec `everything-is-a-space` B3), as capabilities the
 * mount serves on the paths the app always used (DOR-4978, ADR 261125-114705):
 *
 * - `session-relay.status`: `GET /status`, where the link stands. Open to
 *   anyone the session gate let in, as it was; an agent reads it without the
 *   hub's address, the computer's linked name, when it was linked or its host
 *   name (`suggestedName`).
 * - `session-relay.presence` and `session-relay.devices`: `GET /presence` and
 *   `GET /devices`, whether someone uses this computer from the web now and the
 *   browsers seen here. A person's only (`http.audience: 'person'`).
 * - `session-relay.passkeys`: `GET /passkeys`, the approvals passkeys, labels
 *   and dates only. A person's only, and only at this computer.
 * - `session-relay.pause`, `session-relay.end_presence` and
 *   `session-relay.unlink`: `POST /pause`, `POST /presence/end` and
 *   `DELETE /link`. They only narrow access, so they ask no password. A
 *   person's only, behind the owner bar (`context.request.frontDoorOwner`): the
 *   owner at this computer or on their own encrypted connection, never Wi-Fi
 *   or the relay.
 *
 * Every change that opens access wider (linking, Full control, resuming,
 * adding or removing a passkey) stays a hand route in `routes/session-relay.ts`,
 * because it asks "Confirm it's you" with the owner's password.
 *
 * The whole group is the `/api` 404 on a hub and while the `sessionRelay`
 * experiment is off, and every answer carries `Cache-Control: no-store`. The
 * mount's own refusals come before that 404, since the registry has no check a
 * door runs ahead of them: an agent or an API key on a person's door gets
 * `person_only`, and a Wi-Fi sign-in's Pause, End or Unlink `not_from_wifi`,
 * whether the group is on or not. Neither tells the caller anything the 404
 * would hide (`routes/__tests__/session-relay-doors.test.ts` pins it). Never
 * the relay secret, a passkey's key or a link code in an answer, an error or
 * the audit log. Every change is audited, as the caller who asked, on the
 * `app` surface.
 *
 * @module services/core/session-relay-doors/session-relay-capabilities
 */
import { z } from 'zod';
import {
  SessionRelayDeviceListSchema,
  SessionRelayPasskeyListSchema,
  SessionRelayPresenceSchema,
  SessionRelayStatusSchema,
  type SessionRelayDevice,
  type SessionRelayPasskeyList,
  type SessionRelayPresence,
  type SessionRelayStatus,
} from '@dorkos/shared/session-relay-link';
import type { HttpSurface } from '@dorkos/shared/capabilities';
import type { CapabilityHandlerContext } from '../capabilities/index.js';
import {
  CapabilityToolError,
  defineCapability,
  type CapabilityDeps,
  type CapabilityDomain,
} from '../capabilities/capability-definition.js';
import type { RecordAuditInput } from '../../audit/audit-trail.js';
import type { RelayPin } from '../session-relay/pin-store.js';
import type { ApprovalKeys } from '../session-relay/approval-key-store.js';
import { SESSION_RELAY_SAYS } from './session-relay-refusals.js';

/** What the session-relay doors read and change, composed at boot (`routes/session-relay.ts`). */
export interface SessionRelayDoorDeps {
  /** Whether this server is a hub. */
  isHub: () => boolean;
  /** Whether the experiment is on. */
  enabled: () => boolean;
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
  /** The name to offer when linking. */
  suggestedName: () => string;
  /** Whether someone is using this computer from the web now. */
  presence: () => SessionRelayPresence;
  /** Every browser seen here, most recent first. */
  devices: () => SessionRelayDevice[];
  /** The approvals passkeys. */
  passkeys: {
    /** The pinned keys, or `null` when none. */
    readKeys: () => ApprovalKeys | null;
    /** Whether the keys file is there but damaged. */
    keysUnreadable: () => boolean;
  };
  /** Run one change to the pin at a time (`withRelayPinLock`). */
  withPinLock: <T>(change: () => T | Promise<T>) => Promise<T>;
  /** Record one change in the audit log, as the request's own caller. */
  recordAudit: (input: RecordAuditInput) => unknown;
}

declare module '../capabilities/capability-definition.js' {
  interface CapabilityDeps {
    /** The session-relay doors on `/api/session-relay` (DOR-4978). */
    sessionRelayDeps?: SessionRelayDoorDeps;
  }
}

/** The deps, or a fault: the domain is composed only with them. */
function depsOf(deps: CapabilityDeps): SessionRelayDoorDeps {
  if (!deps.sessionRelayDeps) throw new Error('Chat from the web is unavailable.');
  return deps.sessionRelayDeps;
}

/** The deps, once the group is on here: the `/api` 404 on a hub or with the experiment off. */
function liveDepsOf(deps: CapabilityDeps): SessionRelayDoorDeps {
  const relay = depsOf(deps);
  if (relay.isHub() || !relay.enabled()) {
    throw new CapabilityToolError({ code: 'SESSION_RELAY_OFF', error: SESSION_RELAY_SAYS.off });
  }
  return relay;
}

/** Whether an agent, or a machine that presented an agent token, is asking. */
function agentIsAsking(context: CapabilityHandlerContext): boolean {
  return context.identity !== undefined || context.agentIdentityPresented === true;
}

/**
 * Refuse anyone but the owner in the app at this computer or on their own
 * encrypted connection, in the hand route's words. The person bar itself is
 * the mount's (`audience: 'person'`).
 */
function assertOwnerHere(context: CapabilityHandlerContext): void {
  const request = context.request;
  if (request?.frontDoorOwner) return;
  throw new CapabilityToolError({
    code: 'SESSION_RELAY_PERSON_HERE',
    error: request?.frontDoorElsewhere
      ? SESSION_RELAY_SAYS.elsewhere
      : SESSION_RELAY_SAYS.notTheOwner,
  });
}

/**
 * The same bar, held to this computer: a passkey strengthens a sign-in, so it
 * is managed only where the owner is proved best.
 */
function assertOwnerAtThisComputer(context: CapabilityHandlerContext): void {
  if (!context.request?.atThisComputerWithoutProgramKey) {
    throw new CapabilityToolError({
      code: 'SESSION_RELAY_PERSON_HERE',
      error: SESSION_RELAY_SAYS.elsewhere,
    });
  }
  assertOwnerHere(context);
}

/**
 * Where the link stands now. Never the relay secret. The hand routes answer
 * with it too (`routes/session-relay.ts`).
 *
 * @param relay - The pin, the live connection and the name to offer.
 */
export function statusOf(
  relay: Pick<SessionRelayDoorDeps, 'readPin' | 'connected' | 'suggestedName'>
): SessionRelayStatus {
  const pin = relay.readPin();
  return {
    linked: pin !== null,
    hubOrigin: pin?.hubOrigin ?? null,
    computerName: pin?.computerName ?? null,
    level: pin?.level ?? 'chat',
    paused: pin?.paused ?? false,
    connected: pin !== null && !pin.paused && relay.connected(),
    pinnedAt: pin?.pinnedAt ?? null,
    suggestedName: relay.suggestedName(),
  };
}

/** The passkeys as Settings lists them: never key material. */
function passkeyListOf(keys: ApprovalKeys | null, damaged: boolean): SessionRelayPasskeyList {
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

/** Record one change, actor taken from the request's own scope. */
function audit(
  relay: SessionRelayDoorDeps,
  action: string,
  operation: 'modify' | 'remove',
  summary: string
): void {
  relay.recordAudit({
    action: `session-relay.${action}`,
    operation,
    outcome: 'ok',
    target: { type: 'session-relay', id: 'this-computer' },
    summary,
    source: { surface: 'app' },
  });
}

/** Pause the link and close the live relay, as one change to the pin. */
async function pauseLink(relay: SessionRelayDoorDeps): Promise<RelayPin> {
  const pin = await relay.withPinLock(async () => {
    const next = await relay.updatePin({ paused: true });
    // Inside the lock, so no resume can open a relay after this pause.
    if (next) relay.closeRelay();
    return next;
  });
  if (!pin) {
    throw new CapabilityToolError({
      code: 'SESSION_RELAY_NOT_LINKED',
      error: SESSION_RELAY_SAYS.notLinked,
    });
  }
  return pin;
}

/** One door's path under `/api/session-relay`, with no cache. */
function door(method: HttpSurface['method'], path: string, person = true): HttpSurface {
  return {
    method,
    path: `/api/session-relay${path}`,
    noStore: true,
    ...(person ? { audience: 'person' as const } : {}),
  };
}

/** Why a person's door has no permission area: no agent can call it. */
const PERSON_NOTE = 'a person’s own chat-from-the-web setting; agents are refused';

/** The session-relay doors, on every server; each answers the `/api` 404 where it is off. */
export const sessionRelayDomain: CapabilityDomain = {
  name: 'session-relay',
  assertDeps: depsOf,
  capabilities: [
    defineCapability({
      id: 'session-relay.status',
      title: 'Read where chat from the web stands',
      description:
        'Whether this computer is linked to a hub for chatting from the web, at which level, ' +
        'and whether it is paused or connected. An agent reads it without the hub’s address, ' +
        'the linked name, when it was linked or this computer’s host name.',
      tier: 'observe',
      area: null,
      areaNote: 'reading a status; an agent gets no addresses or names',
      input: z.object({}),
      output: SessionRelayStatusSchema,
      surfaces: { http: door('get', '/status', false) },
      invoke: async (deps, _input, context) => {
        const status = statusOf(liveDepsOf(deps));
        return agentIsAsking(context)
          ? { ...status, hubOrigin: null, computerName: null, pinnedAt: null, suggestedName: '' }
          : status;
      },
    }),
    defineCapability({
      id: 'session-relay.presence',
      title: 'See who uses this computer from the web',
      description:
        'Whether someone is using this computer from the web now, and the browsers seen ' +
        'since. Labels and times only. A person’s only.',
      tier: 'observe',
      area: null,
      areaNote: PERSON_NOTE,
      input: z.object({}),
      output: SessionRelayPresenceSchema,
      surfaces: { http: door('get', '/presence') },
      invoke: async (deps) => liveDepsOf(deps).presence(),
    }),
    defineCapability({
      id: 'session-relay.devices',
      title: 'List the browsers seen here',
      description:
        'Every browser that used this computer from the web, most recent first. Labels and ' +
        'times only. A person’s only.',
      tier: 'observe',
      area: null,
      areaNote: PERSON_NOTE,
      input: z.object({}),
      output: SessionRelayDeviceListSchema,
      surfaces: { http: door('get', '/devices') },
      invoke: async (deps) => ({ devices: liveDepsOf(deps).devices() }),
    }),
    defineCapability({
      id: 'session-relay.passkeys',
      title: 'List the approvals passkeys',
      description:
        'The approve page and the passkeys web approvals are signed with: labels and dates, ' +
        'never key material. A person’s only, at this computer.',
      tier: 'observe',
      area: null,
      areaNote: PERSON_NOTE,
      input: z.object({}),
      output: SessionRelayPasskeyListSchema,
      surfaces: { http: door('get', '/passkeys') },
      invoke: async (deps, _input, context) => {
        const relay = liveDepsOf(deps);
        assertOwnerAtThisComputer(context);
        return passkeyListOf(relay.passkeys.readKeys(), relay.passkeys.keysUnreadable());
      },
    }),
    defineCapability({
      id: 'session-relay.pause',
      title: 'Pause chat from the web',
      description:
        'Pause this computer’s link to its hub and close the live relay. Resuming asks for ' +
        'the owner’s password. A person’s only.',
      tier: 'act',
      area: null,
      areaNote: PERSON_NOTE,
      input: z.object({}),
      output: SessionRelayStatusSchema,
      surfaces: { http: door('post', '/pause') },
      invoke: async (deps, _input, context) => {
        const relay = liveDepsOf(deps);
        assertOwnerHere(context);
        await pauseLink(relay);
        audit(relay, 'pause', 'modify', 'Paused chatting from the web');
        return statusOf(relay);
      },
    }),
    defineCapability({
      id: 'session-relay.end_presence',
      title: 'End use from the web now',
      description:
        'End all use of this computer from the web now: pause the link and close the live ' +
        'relay, as Pause does. A person’s only.',
      tier: 'act',
      area: null,
      areaNote: PERSON_NOTE,
      input: z.object({}),
      output: SessionRelayPresenceSchema,
      surfaces: { http: door('post', '/presence/end') },
      invoke: async (deps, _input, context) => {
        const relay = liveDepsOf(deps);
        assertOwnerHere(context);
        await pauseLink(relay);
        audit(
          relay,
          'presence.end',
          'modify',
          'Ended use from the web and paused chat from the web'
        );
        return relay.presence();
      },
    }),
    defineCapability({
      id: 'session-relay.unlink',
      title: 'Unlink this computer from its hub',
      description:
        'Forget the link and close the live relay. Works with the network off; the hub ' +
        'learns when the relay stops. A person’s only.',
      tier: 'act',
      area: null,
      areaNote: PERSON_NOTE,
      input: z.object({}),
      output: SessionRelayStatusSchema,
      surfaces: { http: door('delete', '/link') },
      invoke: async (deps, _input, context) => {
        const relay = liveDepsOf(deps);
        assertOwnerHere(context);
        const had = await relay.withPinLock(() => {
          const pin = relay.readPin();
          relay.clearPin();
          return pin;
        });
        if (had) audit(relay, 'unlink', 'remove', `Unlinked this computer from ${had.hubOrigin}`);
        return statusOf(relay);
      },
    }),
  ],
};
