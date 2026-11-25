/** Document the shared 428 ceremony on every front-door write that can hold. */
import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi';
import {
  StepUpRequiredBodySchema,
  HeldStepUpViewSchema,
  StepUpPasswordBodySchema,
  StepUpChangePasswordBodySchema,
  StepUpConfirmedBodySchema,
} from '@dorkos/shared/step-up';
import { z } from 'zod';
import { CommunityShortNameSchema } from '@dork-labs/cloud-api';

import { problemResponse } from '../../openapi/problem-openapi.js';

const AUTH_WRITES = [
  'api-key/create',
  'api-key/update',
  'revoke-session',
  'revoke-other-sessions',
  'revoke-sessions',
] as const;

/** Guarded route keys, checked against the front-door census. */
export const HELD_WRITES = new Set([
  ...AUTH_WRITES.map((path) => `post /api/auth/${path}`),
  'post /api/remote-access/enrolment',
  'post /api/remote-access/mode',
  'post /api/tunnel/start',
  'post /api/lan-access',
  'patch /api/config',
  'post /api/config/mcp/reveal-token',
  'post /api/config/mcp/rotate-token',
  'put /api/heartbeats/triage-credits',
  'post /api/tasks',
  'patch /api/tasks/{id}',
  'patch /api/mesh/agents/{id}',
  'post /api/session-relay/link',
  'patch /api/session-relay/level',
  'post /api/session-relay/resume',
  'post /api/session-relay/passkeys/start',
  'post /api/extensions/trusted-sources',
  'post /api/cloud/link/start',
  'post /api/cloud/billing/{page}',
  'post /api/cloud/account/export',
  'post /api/cloud/account/deletion',
  'post /api/cloud/seats/{seatId}/assign',
  'put /api/cloud/credits/default',
  'post /api/cloud/communities',
  'post /api/cloud/communities/moves',
  'post /api/cloud/communities/moves/{moveId}/upload',
  'post /api/cloud/communities/{communityId}/claim-link',
  'post /api/cloud/communities/{communityId}/keep',
  'post /api/cloud/communities/{communityId}/restore',
  'delete /api/devices/sessions/{id}',
  'post /api/devices/sign-out-all',
  // Adding or removing a sign-in check (DOR-3647).
  'post /api/owner-factors/passkeys/options',
  'post /api/owner-factors/authenticator/start',
  'delete /api/owner-factors/{id}',
  // A raise, or an Undo, of what agents may do; lowering answers at once.
  'put /api/permissions/preset',
  'patch /api/permissions/defaults',
  'patch /api/agents/{id}/permissions',
  'post /api/permissions/history/{eventId}/undo',
  'post /api/extensions/{id}/enable',
  // Raising or removing the limit; lowering it answers at once.
  'put /api/community-connections/{ref}/teammate-spend',
  // DOR-4355 M3: raises only; the reverse of each answers at once. Routes with no
  // documented operation yet are held in code and covered by their own tests.
  'put /api/connectors/providers/{provider}/credential',
  'post /api/connectors/reviews/{reviewRequestId}/decision',
  'delete /api/connectors/connections/{connectionId}/exclusions/{agentId}',
  'post /api/connectors/reconciliation/apply',
  'post /api/connectors/connections',
  'post /api/connectors/connections/{connectionId}/reconnect',
  'post /api/connectors/connections/{connectionId}/resume',
  'post /api/connectors/connections/{connectionId}/events/subscriptions',
  'put /api/connectors/connections/{connectionId}/events/source',
  'post /api/connectors/access-changes/{changeId}/undo',
  // DOR-4794: turning writes back on; turning it off answers at once.
  'put /api/connectors/connections/{connectionId}/writes-back',
  'post /api/marketplace/packages/{name}/install',
  'post /api/marketplace/packages/{name}/keep-files',
  'post /api/marketplace/updates',
  'post /api/marketplace/dev-links',
  'post /api/marketplace/held-back/{name}/decision',
  'post /api/marketplace/sources',
  'post /api/shapes/{name}/apply',
  'post /api/relay/bindings/{id}/move',
  'post /api/relay/unclaimed-chats/{id}/claim',
  // DOR-4355 M3, Security's census nit: every held M3 route documents its 428.
  'post /api/connectors/agent-requests/{requestId}/decision',
  'post /api/connectors/agent-requests/{requestId}/authentication-flows',
  'post /api/connectors/mini-app-access/decision',
  'post /api/workspaces',
  'delete /api/workspaces/{id}',
  'post /api/tasks/{id}/approve-file',
  'post /api/tasks/{id}/undo-agent-mode',
  'post /api/runtimes/opencode/openrouter/key',
  'post /api/runtimes/opencode/openrouter/oauth/start',
  'post /api/runtimes/opencode/provider/credential',
  'post /api/runtimes/{type}/credential',
  'put /api/runtimes/claude-code/project-accounts',
  'put /api/runtimes/claude-code/accounts/{id}/only-projects',
  'put /api/runtimes/claude-code/accounts/{id}/no-auto-move',
  'put /api/runtimes/claude-code/accounts/{id}/agents-may-pick',
  'post /api/community-connections',
  'put /api/community-connections/{ref}/wake-agents-from',
  'put /api/community-connections/{ref}/answer-in',
  'post /api/canvas/docs/{id}/routes/{routeId}/approve',
  'put /api/extensions/{id}/secrets/{key}',
  'post /api/relay/bindings',
  'patch /api/relay/bindings/{id}',
  'post /api/relay/adapters/test',
  'post /api/relay/adapters',
  'patch /api/relay/adapters/{id}/config',
  'post /api/relay/adapters/{id}/enable',
  // Main's DOR-4204 spending routes: raising the limit, or lowering a price, holds.
  'put /api/connectors/spending/limit',
  'put /api/connectors/spending/prices/{toolkit}',
]);

/** Bodies for newly documented native writes; auth and the general patch validate flexible JSON. */
function nativeBody(path: string): z.ZodType {
  if (path === '/api/remote-access/mode')
    return z.object({ mode: z.enum(['off', 'byo', 'managed']) });
  if (path === '/api/lan-access') return z.object({ enabled: z.boolean() });
  if (path === '/api/heartbeats/triage-credits') return z.object({ useCredits: z.boolean() });
  if (path === '/api/cloud/credits/default')
    return z.object({ runtime: z.string().min(1), useCredits: z.boolean() });
  if (path === '/api/cloud/communities')
    return z.object({
      idempotencyKey: z.string().min(1).max(200),
      name: z.string().trim().min(1).max(80),
      shortName: CommunityShortNameSchema.optional(),
    });
  if (path.endsWith('/keep'))
    return z.object({ expectedHeldCommunityIds: z.array(z.string().min(1)).max(1000) });
  if (path === '/api/auth/revoke-session') return z.object({ token: z.string() });
  if (path.endsWith('/teammate-spend'))
    return z.object({ monthlyLimitUsd: z.number().positive().nullable() });
  if (path.includes('/seats/'))
    return z.object({
      subject: z.object({ kind: z.enum(['agent', 'user']), id: z.string().min(1) }),
    });
  if (path === '/api/config' || path.startsWith('/api/auth/api-key/'))
    return z.record(z.string(), z.unknown());
  return z.object({});
}

/** Add the same shared response to registered writes, without duplicating their schemas. */
export function documentFrontDoorStepUps(registry: OpenAPIRegistry): void {
  const registered = new Set(
    registry.definitions
      .filter((definition) => definition.type === 'route')
      .map((definition) => `${definition.route.method} ${definition.route.path.replace(/\/$/, '')}`)
  );
  documentCeremonyRoutes(registry, registered);
  // Fill gaps for routes previously absent from the main API document. Existing
  // registered bodies remain authoritative; Better Auth validates its own bodies.
  for (const key of HELD_WRITES) {
    if (registered.has(key)) continue;
    const [method, path] = key.split(' ') as [RouteConfig['method'], string];
    const params = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => [match[1]!, z.string()]);
    const binary = path === '/api/cloud/communities/moves';
    registry.registerPath({
      method,
      path,
      tags: [path.startsWith('/api/auth/') ? 'Auth' : 'Access'],
      summary: 'Confirm a lasting access or account change',
      description:
        'The owner confirms this action in the app before it changes access or account data. Narrowing and signing out your own device stay immediate. Hubs keep their existing owner flow.',
      request: {
        ...(params.length ? { params: z.object(Object.fromEntries(params)) } : {}),
        ...(binary
          ? {
              query: z.object({
                idempotencyKey: z.string().min(1).max(200),
                name: z.string().trim().min(1).max(80),
                shortName: CommunityShortNameSchema.optional(),
              }),
            }
          : {}),
        body: {
          // The archive is raw bytes; the docs site renders only the generic binary type.
          content: binary
            ? { 'application/octet-stream': { schema: z.string().openapi({ format: 'binary' }) } }
            : { 'application/json': { schema: nativeBody(path) } },
        },
      },
      responses: {
        200: {
          description: 'The action completed',
          content: { 'application/json': { schema: z.unknown() } },
        },
        403: problemResponse('This caller cannot change access here'),
      },
    });
  }
  for (const definition of registry.definitions) {
    if (definition.type !== 'route') continue;
    const route = definition.route;
    if (!HELD_WRITES.has(`${route.method} ${route.path.replace(/\/$/, '')}`)) continue;
    // What `holdForStepUp` (`routes/step-up-guard.ts`) actually sends: the
    // step-up body as plain JSON with `Cache-Control: no-store`. It stays the
    // named `StepUpRequired` component, not a problem document, though
    // `step_up_required` is on the problem code list: every held write and
    // its readers share that one shape (DOR-4979).
    route.responses[428] = {
      description:
        'Confirm this action in the app. Complete /api/step-up/{heldActionId}/password from the same signed-in browser. Nothing has changed yet. Narrowing and signing out your own device stay immediate. This answer is the step-up body below as `application/json`, not an `application/problem+json` document; read `heldActionId` and `requestCode` from it.',
      headers: {
        'Cache-Control': {
          description: 'Always `no-store`: the held action is for this request only.',
          schema: { type: 'string', enum: ['no-store'] },
        },
      },
      content: { 'application/json': { schema: StepUpRequiredBodySchema } },
    };
  }
}

/** The refusal a page from before 0.141.0 reads (`olderPageRefusal` in `routes/step-up.ts`). */
const OlderPageRefusalSchema = z.object({
  error: z.string(),
  code: z.literal('extension-risk'),
  blockedBy: z.array(z.unknown()).max(0).optional(),
  stale: z.enum(['stale-sign-in', 'stale-page']),
});

/** A held action this caller may not see or answer. */
const NOT_THIS_BROWSER = problemResponse(
  'Not the app’s own page or a program (`person_only`), or another browser held it ' +
    '(`held_by_another_browser`)'
);

/** A held action that is gone. */
const EXPIRED = problemResponse(
  'The action expired, was cancelled or already ran (`expired`, answered as `404`)'
);

/** Describe the existing ceremony, including the action kinds the sheet can show. */
function documentCeremonyRoutes(registry: OpenAPIRegistry, registered: ReadonlySet<string>): void {
  const path = '/api/step-up/{heldActionId}';
  const params = z.object({ heldActionId: z.string().min(1) });
  if (!registered.has(`get ${path}`))
    registry.registerPath({
      method: 'get',
      path,
      tags: ['Access'],
      summary: 'Read an action waiting for confirmation',
      request: { params },
      responses: {
        200: {
          description: 'The action held by this browser',
          content: { 'application/json': { schema: HeldStepUpViewSchema } },
        },
        403: NOT_THIS_BROWSER,
        404: EXPIRED,
        // Not a problem document on purpose: the one body a page from before
        // 0.141.0 reads. Since 0.141, remove in 0.143 (DOR-5089).
        409: {
          description:
            'A page from before 0.141.0 (no page stamp) that is too old to confirm from. The one body that page reads.',
          content: { 'application/json': { schema: OlderPageRefusalSchema } },
        },
      },
    });
  for (const [method, schema] of [
    ['password', StepUpPasswordBodySchema],
    ['change-password', StepUpChangePasswordBodySchema],
  ] as const) {
    const confirmPath = `${path}/${method}`;
    if (!registered.has(`post ${confirmPath}`))
      registry.registerPath({
        method: 'post',
        path: confirmPath,
        tags: ['Access'],
        summary: 'Confirm one held action',
        description:
          'The same signed-in browser confirms this fixed action. Its result carries the held action’s own status and response.',
        request: { params, body: { content: { 'application/json': { schema } } } },
        responses: {
          200: {
            description: 'The action ran once',
            content: { 'application/json': { schema: StepUpConfirmedBodySchema } },
          },
          400: problemResponse(
            'No password sent, or a new password too short or too long, with `minLength` ' +
              '(`invalid_request`)'
          ),
          403: problemResponse(
            'Refused: a wrong password with `triesLeft` (`wrong_password`), the last one ' +
              '(`too_many_tries`), a connection a password may not cross ' +
              '(`insecure_connection`), or not this browser (`person_only`, ' +
              '`held_by_another_browser`)'
          ),
          404: EXPIRED,
          409: problemResponse(
            'Can’t confirm now: a matched password too short, with `minLength` ' +
              '(`password_too_short`), no owner password (`no_password`), a mini app an agent ' +
              'can edit, with `blockedBy` (`extension_risk`), or a sign-in or page from before ' +
              'a change, with `stale` (`stale_sign_in`, `stale_page`). A page from before ' +
              '0.141.0 gets `{ error, code: "extension-risk", blockedBy, stale }` instead'
          ),
          412: problemResponse(
            'The stored request changed after it was held (`precondition_failed`)'
          ),
          429: problemResponse(
            'Too many wrong passwords lately; `retryAfterMs` and `Retry-After` say when ' +
              '(`rate_limited`)'
          ),
          500: problemResponse('The confirmed action failed to run (`internal_error`)'),
        },
      });
  }
  if (!registered.has(`delete ${path}`))
    registry.registerPath({
      method: 'delete',
      path,
      tags: ['Access'],
      summary: 'Cancel one held action',
      request: { params },
      responses: {
        204: { description: 'The action was cancelled without running' },
        403: NOT_THIS_BROWSER,
        404: EXPIRED,
      },
    });
}
