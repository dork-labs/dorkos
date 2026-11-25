/**
 * The hand routes that stay hand routes (ADR 261123-170830).
 *
 * Every other `/api` route is moving onto a capability `http` surface, which
 * the generic mount serves (`routes/capability-http.ts`). A route belongs here
 * only when its shape is one a capability cannot express: a stream, raw bytes
 * in or out, a callback another site calls, a sign-in handshake that sets a
 * cookie, an HTML page, the health and docs routes, or the invoke endpoint
 * every capability already runs through. One more holds writes the app makes
 * from Wi-Fi on purpose until the mount can tell an API key from a person
 * (`network-reachable`, DOR-5267). Each entry says which, and why.
 *
 * `../__tests__/hand-route-census.test.ts` holds the line: every served `/api`
 * route is a mounted capability, on this list, or on the pending list
 * (`pending.json` beside it), which may only shrink. `scripts/api-lint` reads
 * this file too, so its `hand-registered-path` rule skips these routes.
 *
 * This file imports nothing, so a script can load it with plain Node.
 *
 * @module http/hand-routes/allowlist
 */

/** Why a route stays a hand route. */
export type HandRouteCategory =
  | 'stream'
  | 'bytes'
  | 'callback'
  | 'sign-in-handshake'
  | 'html-page'
  | 'health-docs'
  | 'invoke'
  /**
   * A write reachable from Wi-Fi by design, held by hand until the mount can
   * tell an API key from a person (A5, DOR-5267). Security's ruling, 2026-11-25.
   */
  | 'network-reachable';

/** One route that stays a hand route. */
export interface HandRouteAllowlistEntry {
  /** The method, upper-cased as the route census writes it (`ALL` for any). */
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';
  /** The path as Hono registers it and the route census writes it (`:param`). */
  readonly path: string;
  /** Which shape a capability cannot express. */
  readonly category: HandRouteCategory;
  /** One line on why. */
  readonly reason: string;
}

/** Why the scheduled-task writes stay by hand (Security's ruling on DOR-4978). */
const TASK_WRITE_HELD = 'network-reachable by design, waits for A5 (API-key audience), DOR-5267';

/** Every route that stays a hand route, grouped by category. */
export const HAND_ROUTE_ALLOWLIST: readonly HandRouteAllowlistEntry[] = [
  // Streams: a response that stays open and sends events as they happen.
  {
    method: 'GET',
    path: '/api/events',
    category: 'stream',
    reason: 'The global event stream (SSE).',
  },
  {
    method: 'GET',
    path: '/api/sessions/:id/events',
    category: 'stream',
    reason: "A chat's durable event stream (SSE, Last-Event-ID replay).",
  },
  {
    method: 'GET',
    path: '/api/rooms/:id/events',
    category: 'stream',
    reason: "A room's live event stream (SSE).",
  },
  {
    method: 'GET',
    path: '/api/communities/:ref/rooms/:roomId/events',
    category: 'stream',
    reason: "A remote space room's live event stream (SSE).",
  },
  {
    method: 'GET',
    path: '/api/relay/stream',
    category: 'stream',
    reason: "Relay's live message stream (SSE).",
  },
  {
    method: 'GET',
    path: '/api/tunnel/stream',
    category: 'stream',
    reason: "The tunnel's status stream (SSE).",
  },
  {
    method: 'GET',
    path: '/api/extensions/events',
    category: 'stream',
    reason: "Apps' status stream (SSE).",
  },
  {
    method: 'GET',
    path: '/api/extensions/:id/rooms/:roomId/threads/:entryId/events',
    category: 'stream',
    reason: "An app's thread event stream (SSE).",
  },
  {
    method: 'GET',
    path: '/api/hub/computers/:computerId/sessions/:sessionId/stream',
    category: 'stream',
    reason: "A linked computer's chat stream, relayed by the hub (SSE).",
  },
  {
    method: 'POST',
    path: '/api/discovery/scan',
    category: 'stream',
    reason: 'A folder scan that streams what it finds (SSE).',
  },
  {
    method: 'POST',
    path: '/api/runtimes/claude-code/provision',
    category: 'stream',
    reason: 'An install that streams its progress (SSE).',
  },
  {
    method: 'POST',
    path: '/api/runtimes/codex/provision',
    category: 'stream',
    reason: 'An install that streams its progress (SSE).',
  },
  {
    method: 'POST',
    path: '/api/runtimes/opencode/provision',
    category: 'stream',
    reason: 'An install that streams its progress (SSE).',
  },
  {
    method: 'POST',
    path: '/api/runtimes/opencode/ollama/provision',
    category: 'stream',
    reason: 'An install that streams its progress (SSE).',
  },

  // Bytes: a file's raw bytes out, or a multipart upload in.
  { method: 'GET', path: '/api/files/raw', category: 'bytes', reason: "A file's raw bytes." },
  {
    method: 'GET',
    path: '/api/diff/baseline/raw',
    category: 'bytes',
    reason: "A file's raw bytes at the diff's baseline.",
  },
  { method: 'POST', path: '/api/uploads', category: 'bytes', reason: 'A multipart upload.' },
  {
    method: 'GET',
    path: '/api/uploads/:filename',
    category: 'bytes',
    reason: "An uploaded file's bytes.",
  },
  {
    method: 'GET',
    path: '/api/rooms/:id/files/raw',
    category: 'bytes',
    reason: "A room file's raw bytes.",
  },
  {
    method: 'POST',
    path: '/api/rooms/:id/files/upload',
    category: 'bytes',
    reason: 'A multipart upload into a room folder.',
  },
  {
    method: 'POST',
    path: '/api/rooms/:id/attachments',
    category: 'bytes',
    reason: 'A multipart attachment upload.',
  },
  {
    method: 'GET',
    path: '/api/rooms/:id/attachments/:attachmentId',
    category: 'bytes',
    reason: "An attachment's bytes, never rendered on the app's origin.",
  },
  {
    method: 'GET',
    path: '/api/rooms/:id/canvas/media/:file',
    category: 'bytes',
    reason: "A canvas media file's bytes.",
  },
  {
    method: 'GET',
    path: '/api/rooms/:id/export',
    category: 'bytes',
    reason: 'A room export, streamed as a download.',
  },
  {
    method: 'GET',
    path: '/api/communities/:ref/rooms/:roomId/attachments/:attachmentId',
    category: 'bytes',
    reason: "A remote space attachment's bytes.",
  },
  {
    method: 'POST',
    path: '/api/communities/:ref/rooms/:roomId/attachments',
    category: 'bytes',
    reason: 'A multipart attachment upload to a remote space.',
  },
  {
    method: 'GET',
    path: '/api/sessions/:id/attachments/:file',
    category: 'bytes',
    reason: "An image a chat's turn produced.",
  },
  {
    method: 'POST',
    path: '/api/sessions/:id/devtools/recording',
    category: 'bytes',
    reason: 'A multipart browser recording upload.',
  },
  {
    method: 'GET',
    path: '/api/profile/avatar/:id',
    category: 'bytes',
    reason: "A profile photo's bytes.",
  },
  {
    method: 'POST',
    path: '/api/profile/avatar',
    category: 'bytes',
    reason: 'A multipart profile photo upload.',
  },
  {
    method: 'GET',
    path: '/api/connectors/catalog/logos/:serviceSlug',
    category: 'bytes',
    reason: "A service logo's bytes.",
  },
  {
    method: 'POST',
    path: '/api/cloud/communities/moves/:moveId/upload',
    category: 'bytes',
    reason: "A space move's export upload.",
  },
  {
    method: 'POST',
    path: '/api/browser-viewers/:viewerId/files',
    category: 'bytes',
    reason: 'A multipart file handed to a viewed browser.',
  },
  {
    method: 'ALL',
    path: '/api/extensions/media/:ticket',
    category: 'bytes',
    reason: "Video for an app's frame, by a one-time ticket (GET and HEAD).",
  },

  // Callbacks: another site or service calls these, in its own shape.
  {
    method: 'GET',
    path: '/api/agents/mcp-oauth/callback',
    category: 'callback',
    reason: "An MCP server's OAuth redirect.",
  },
  {
    method: 'GET',
    path: '/api/runtimes/opencode/openrouter/oauth/callback',
    category: 'callback',
    reason: "OpenRouter's OAuth redirect.",
  },
  {
    method: 'POST',
    path: '/api/connectors/webhooks/:providerInstanceId',
    category: 'callback',
    reason: "A connected service's signed webhook.",
  },
  {
    method: 'POST',
    path: '/api/relay/webhooks/:adapterId',
    category: 'callback',
    reason: "A chat connection's webhook.",
  },

  // Sign-in handshakes: steps that end by setting a session cookie.
  {
    method: 'ALL',
    path: '/api/auth/*',
    category: 'sign-in-handshake',
    reason: 'The sign-in library mounts its own routes and cookies.',
  },
  {
    method: 'POST',
    path: '/api/desktop/sign-in',
    category: 'sign-in-handshake',
    reason: "The desktop app's sign-in, which sets the cookie.",
  },
  {
    method: 'POST',
    path: '/api/wifi-sign-in/start',
    category: 'sign-in-handshake',
    reason: 'The first step of signing in from Wi-Fi, answered before the session gate.',
  },
  {
    method: 'POST',
    path: '/api/wifi-sign-in/finish',
    category: 'sign-in-handshake',
    reason: 'The step that sets the Wi-Fi sign-in cookie.',
  },
  {
    method: 'POST',
    path: '/api/owner-sign-in/passkey/options',
    category: 'sign-in-handshake',
    reason: "The first step of the owner's passkey sign-in, answered before the session gate.",
  },
  {
    method: 'POST',
    path: '/api/owner-sign-in/passkey/finish',
    category: 'sign-in-handshake',
    reason: "The step that sets the owner's passkey sign-in cookie.",
  },
  {
    method: 'POST',
    path: '/api/person-session',
    category: 'sign-in-handshake',
    reason: "The owner's password step-up, which sets its cookie.",
  },

  // HTML pages and the files they load.
  {
    method: 'GET',
    path: '/api/connectors/mini-app-access/page',
    category: 'html-page',
    reason: "The mini app access page's HTML.",
  },
  {
    method: 'GET',
    path: '/api/connectors/mini-app-access/page.css',
    category: 'html-page',
    reason: "The mini app access page's stylesheet.",
  },
  {
    method: 'GET',
    path: '/api/connectors/mini-app-access/page.js',
    category: 'html-page',
    reason: "The mini app access page's script.",
  },
  {
    method: 'GET',
    path: '/api/extension-frame',
    category: 'html-page',
    reason: "The empty, sandboxed document an app's screens run in.",
  },
  {
    method: 'GET',
    path: '/api/workbench/serve/:token',
    category: 'html-page',
    reason: 'A served workbench page.',
  },
  {
    method: 'GET',
    path: '/api/workbench/serve/:token/:splat{.+}',
    category: 'html-page',
    reason: "A served workbench page's files.",
  },

  // Health and the API's own document.
  {
    method: 'GET',
    path: '/api/health',
    category: 'health-docs',
    reason: 'The liveness check, answered before anything else is up.',
  },
  {
    method: 'GET',
    path: '/api/health/deep',
    category: 'health-docs',
    reason: 'The deep health check.',
  },
  {
    method: 'GET',
    path: '/api/openapi.json',
    category: 'health-docs',
    reason: 'The OpenAPI document itself.',
  },
  { method: 'ALL', path: '/api/docs', category: 'health-docs', reason: 'The API reference page.' },
  {
    method: 'ALL',
    path: '/api/docs/*',
    category: 'health-docs',
    reason: "The API reference page's files.",
  },

  // Scheduled-task writes the app makes from Wi-Fi on purpose (Security, DOR-5267).
  {
    method: 'POST',
    path: '/api/tasks',
    category: 'network-reachable',
    reason: TASK_WRITE_HELD,
  },
  {
    method: 'PATCH',
    path: '/api/tasks/:id',
    category: 'network-reachable',
    reason: TASK_WRITE_HELD,
  },
  {
    method: 'DELETE',
    path: '/api/tasks/:id',
    category: 'network-reachable',
    reason: TASK_WRITE_HELD,
  },
  {
    method: 'POST',
    path: '/api/tasks/:id/trigger',
    category: 'network-reachable',
    reason: TASK_WRITE_HELD,
  },
  {
    method: 'POST',
    path: '/api/tasks/runs/:id/cancel',
    category: 'network-reachable',
    reason: TASK_WRITE_HELD,
  },
  {
    method: 'POST',
    path: '/api/tasks/:id/approve-file',
    category: 'network-reachable',
    reason: TASK_WRITE_HELD,
  },
  {
    method: 'POST',
    path: '/api/tasks/:id/undo-agent-mode',
    category: 'network-reachable',
    reason: TASK_WRITE_HELD,
  },

  // The generic door every capability already runs through.
  {
    method: 'POST',
    path: '/api/capabilities/:id/invoke',
    category: 'invoke',
    reason: 'Runs any capability by id, through the same dispatcher as its own path.',
  },

  // Reachable from your network on purpose. Security's ruling on DOR-4978: they
  // stay by hand until the API-key audience (A5) lands (DOR-5267).
  {
    method: 'PATCH',
    path: '/api/agents/:id/permissions',
    category: 'network-reachable',
    reason: 'network-reachable to lower only, wifi-raise-guard; waits for A5, DOR-5267',
  },
  {
    method: 'POST',
    path: '/api/mesh/agents/:id/heartbeat',
    category: 'network-reachable',
    reason: 'network-reachable by design, waits for A5 (API-key audience), DOR-5267',
  },
  {
    method: 'POST',
    path: '/api/agents/resolve',
    category: 'network-reachable',
    reason: 'network-reachable by design, waits for A5 (API-key audience), DOR-5267',
  },
  {
    method: 'PATCH',
    path: '/api/agents/current',
    category: 'network-reachable',
    reason: 'network-reachable by design, waits for A5 (API-key audience), DOR-5267',
  },
];
