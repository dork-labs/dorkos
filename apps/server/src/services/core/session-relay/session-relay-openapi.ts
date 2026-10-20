/**
 * OpenAPI entries for a computer's own switch for chatting from the web
 * (step B3, DOR-2946, `routes/session-relay.ts`). Bodies are the protocol's
 * own (`@dorkos/shared/session-relay-link`).
 *
 * @module services/core/session-relay/session-relay-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { links } from '@dorkos/shared/links';
import {
  SessionRelayDeviceListSchema,
  SessionRelayLevelBodySchema,
  SessionRelayLinkBodySchema,
  SessionRelayPasskeyFinishBodySchema,
  SessionRelayPasskeyListSchema,
  SessionRelayPasskeyRemoveBodySchema,
  SessionRelayPasskeyStartBodySchema,
  SessionRelayPasskeyStartSchema,
  SessionRelayPresenceSchema,
  SessionRelayResumeBodySchema,
  SessionRelayStatusSchema,
} from '@dorkos/shared/session-relay-link';

const TAGS = ['Session relay'];

const ErrorSchema = z.object({ error: z.string(), code: z.string() });

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const STATUS = json(SessionRelayStatusSchema, 'Where the link stands now');
const PRESENCE = json(
  SessionRelayPresenceSchema,
  'Whether someone is using this computer from the web'
);
const OFF = json(ErrorSchema, 'On a hub, or while the `sessionRelay.enabled` experiment is off');
const NOT_HERE = json(
  ErrorSchema,
  'Not the owner at this computer using the app: the relay, another device, an agent, an ' +
    'approval token, an API key or any other bearer'
);
const AGENT = json(ErrorSchema, 'A caller presenting agent identity');
const NOT_LINKED = json(ErrorSchema, 'This computer is not linked');
const PASSWORD = json(
  ErrorSchema,
  "Not the owner at this computer using the app, or the owner's password was missing or " +
    'wrong (`SESSION_RELAY_PASSWORD`)'
);
const THROTTLED = json(ErrorSchema, 'Too many wrong passwords lately, from anywhere');

/** One write behind the person-at-this-computer bar. */
function registerWrite(
  registry: OpenAPIRegistry,
  method: 'post' | 'patch' | 'delete',
  path: string,
  summary: string,
  description: string,
  extra: Record<number, ReturnType<typeof json>> = {},
  body?: z.ZodType,
  answer: ReturnType<typeof json> = STATUS
): void {
  registry.registerPath({
    method,
    path: `/api/session-relay${path}`,
    tags: TAGS,
    summary,
    description,
    ...(body ? { request: { body: { content: { 'application/json': { schema: body } } } } } : {}),
    responses: { 200: answer, 403: NOT_HERE, 404: OFF, ...extra },
  });
}

/**
 * Register the session relay's routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerSessionRelayOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/session-relay/status',
    tags: TAGS,
    summary: 'Where chatting from the web stands',
    description:
      'Whether this computer is linked to a hub, its level and pause, and whether the relay ' +
      'is connected now. Never the relay secret.',
    responses: { 200: STATUS, 404: OFF },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/session-relay/presence',
    tags: TAGS,
    summary: 'Whether someone is using this computer from the web',
    description:
      'Active while the relay is connected and the hub has at least one of its chats open, ' +
      'with when that began and the browsers seen since. Pushed as `session_relay_presence` ' +
      'on `GET /api/events` whenever it changes.',
    responses: { 200: PRESENCE, 403: AGENT, 404: OFF },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/session-relay/devices',
    tags: TAGS,
    summary: 'Browsers that used chat from the web here',
    description:
      "Every browser the hub named on a relayed request, by the hub's label, with when it was " +
      'first and last seen. Most recent first; at most 50.',
    responses: {
      200: json(SessionRelayDeviceListSchema, 'The browsers seen here'),
      403: AGENT,
      404: OFF,
    },
  });

  registerWrite(
    registry,
    'post',
    '/presence/end',
    'End use from the web now',
    'Closes the live connection and pauses the link, as Pause does. Resuming needs the ' +
      "owner's password.",
    { 409: NOT_LINKED },
    undefined,
    PRESENCE
  );

  registerWrite(
    registry,
    'post',
    '/link',
    'Link this computer to a hub',
    'Sends a signed link request to the hub the code names (https only, no redirects, 15 s), ' +
      "checks the hub's signed answer, and pins the hub's key. Needs an owner account and the " +
      "owner's password. A code naming this computer or a private address is refused, and a " +
      'computer linked to a DorkOS account accepts only a hub naming that account as its owner.',
    {
      400: json(ErrorSchema, 'Not a link code, or it names a private address'),
      403: PASSWORD,
      429: THROTTLED,
      409: json(
        ErrorSchema,
        'No owner account, already linked, the hub said no, or a different DorkOS account'
      ),
      502: json(ErrorSchema, 'The hub could not be reached or verified'),
    },
    SessionRelayLinkBodySchema
  );

  registerWrite(
    registry,
    'patch',
    '/level',
    'Choose what the web may do here',
    "Chat or Full control. Raising to Full control needs the owner's password; lowering does " +
      'not. Stored in the relay pin; every relayed turn is held to Chat today.',
    { 400: json(ErrorSchema, 'Not a level'), 403: PASSWORD, 409: NOT_LINKED, 429: THROTTLED },
    SessionRelayLevelBodySchema
  );

  registerWrite(
    registry,
    'post',
    '/pause',
    'Pause chatting from the web',
    'Keeps the link, closes the live connection, and stops every dial until resumed.',
    { 409: NOT_LINKED }
  );

  registerWrite(
    registry,
    'post',
    '/resume',
    'Resume chatting from the web',
    "Lets the relay dial its hub again. Needs the owner's password.",
    { 403: PASSWORD, 409: NOT_LINKED, 429: THROTTLED },
    SessionRelayResumeBodySchema
  );

  registerWrite(
    registry,
    'delete',
    '/link',
    'Unlink this computer',
    'Forgets the hub and closes the live connection. Works with the network off.'
  );

  registerPasskeyOpenApi(registry);
}

const PASSKEYS = json(SessionRelayPasskeyListSchema, 'The pinned approve page and passkeys');
const PASSKEY_REFUSED = json(ErrorSchema, 'Refused (`SESSION_RELAY_PASSKEY`), with why');

/** The approvals passkeys (B4c): adding one, listing them, removing one. */
function registerPasskeyOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/session-relay/passkeys',
    tags: TAGS,
    summary: 'The approvals passkeys pinned here',
    description:
      'The approve page approvals from the web must come from, and each passkey by label, ' +
      'date and algorithm. Never key material. The owner at this computer only.',
    responses: { 200: PASSKEYS, 403: NOT_HERE, 404: OFF },
  });

  registerWrite(
    registry,
    'post',
    '/passkeys/start',
    'Begin adding an approvals passkey',
    "Needs the owner's password and a linked computer. Writes a single-use enrol statement " +
      '(two minutes, one live at a time; a new start replaces it) for the approve page ' +
      `(\`${links.approve}\` unless a self-hoster names their own https origin, and ` +
      'always the one already pinned once a passkey exists; never the hub itself, and only ' +
      "DorkOS's own for a DorkOS Cloud account). Answers the approve page to open: " +
      '`<origin>/enrol#<base64url statement>`. The statement sends the browser back to the ' +
      'loopback address this request arrived on (`127.0.0.1`, or `[::1]` for `::1`) at ' +
      "this server's port, `/relay-passkey`. Only a direct request on this computer passes, " +
      'so a container install cannot add a passkey.',
    {
      400: PASSKEY_REFUSED,
      403: PASSWORD,
      409: PASSKEY_REFUSED,
      429: THROTTLED,
      500: json(ErrorSchema, 'This computer could not write the statement'),
    },
    SessionRelayPasskeyStartBodySchema,
    json(SessionRelayPasskeyStartSchema, 'The enrol statement and the approve page to open')
  );

  registerWrite(
    registry,
    'post',
    '/passkeys/finish',
    'Pin the approvals passkey just made',
    'Takes the live enrol statement whether it passes or not. Accepts only the same bytes ' +
      '`/start` issued, unexpired, and a registration over `SHA-256` of them from the ' +
      "statement's origin and relying party, with the person verified, signing with ES256, " +
      'EdDSA or RS256, and not already pinned. Sent by the loopback page `GET /relay-passkey`. ' +
      'Needs no session even when this computer asks for a password; instead a direct ' +
      "loopback caller with no forwarding header, an `Origin` that is exactly the return page's, " +
      'and a JSON body. The single-use statement is the credential.',
    {
      400: PASSKEY_REFUSED,
      403: json(ErrorSchema, "Not a direct loopback caller, or not the return page's own request"),
      409: PASSKEY_REFUSED,
      410: json(ErrorSchema, 'The statement expired'),
    },
    SessionRelayPasskeyFinishBodySchema,
    PASSKEYS
  );

  registerWrite(
    registry,
    'delete',
    '/passkeys',
    'Remove a damaged passkeys file',
    "Needs the owner's password. Removes the passkeys file only when it is damaged (the list " +
      'says `damaged: true`), so a passkey can be added again; a sound file is refused.',
    {
      403: PASSWORD,
      409: json(ErrorSchema, 'The file is not damaged: remove passkeys one at a time'),
      429: THROTTLED,
      500: json(ErrorSchema, 'The file could not be read just now; nothing was removed'),
    },
    SessionRelayPasskeyRemoveBodySchema,
    PASSKEYS
  );

  registry.registerPath({
    method: 'delete',
    path: '/api/session-relay/passkeys/{credentialId}',
    tags: TAGS,
    summary: 'Remove an approvals passkey',
    description:
      "Needs the owner's password. Approvals from the web stop at once when the last one goes.",
    request: {
      params: z.object({ credentialId: z.string().describe('The passkey, base64url') }),
      body: { content: { 'application/json': { schema: SessionRelayPasskeyRemoveBodySchema } } },
    },
    responses: {
      200: PASSKEYS,
      403: PASSWORD,
      404: json(ErrorSchema, 'No such passkey here, or the experiment is off'),
      429: THROTTLED,
    },
  });
}
