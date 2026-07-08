/**
 * Shared metadata for the external MCP server (`/mcp`): tool annotation
 * presets and the server icon.
 *
 * Every `server.registerTool(...)` call in `mcp-server.ts` and
 * `marketplace-mcp-tools.ts` picks one of the {@link ToolAnnotationPresets}
 * describing its read/write, destructive, idempotent, and open-world
 * semantics. Presets are deduplicated by their exact 4-hint combination —
 * see the PR description for the full per-tool annotation matrix — so this
 * file stays a short, reviewable lookup rather than 48 near-identical inline
 * object literals.
 *
 * @module services/core/mcp-tool-metadata
 */
import type { Icon, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/**
 * Named tool-annotation presets, keyed by their `(readOnly, destructive,
 * idempotent, openWorld)` combination. Every external tool maps to exactly
 * one of these — see the annotation matrix in the PR description for the
 * per-tool assignment and the judgment calls behind the less obvious ones
 * (e.g. `relay_inbox` is not read-only because `ack:true` mutates message
 * state; `mesh_discover` is not read-only because auto-import upserts the
 * agent registry as a scan side effect).
 */
export const ToolAnnotationPresets = {
  /** Pure lookups: get/list/status/inspect tools that only read local state. */
  readOnlyLocal: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  /** Lookups that fetch from configured external marketplace sources. */
  readOnlyOpenWorld: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  /** Creates a new resource each call (not idempotent); local effects only. */
  mutateCreateLocal: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  /** Creates a new resource each call and fetches/writes an external source. */
  mutateCreateOpenWorld: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  /** Updates or upserts existing local state; repeat calls converge. */
  mutateUpdateLocal: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  /** Updates state that also opens/reconnects an external adapter connection. */
  mutateUpdateOpenWorld: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  /** Deletes/unregisters a resource; repeat calls have no further effect. */
  mutateDeleteLocal: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
} as const satisfies Record<string, ToolAnnotations>;

/**
 * DorkOS "D" glyph, 1024x1024, matching `apps/desktop/build/icon.svg` — the
 * only square DorkOS icon mark in the repo (the wordmark SVGs under
 * `apps/site/public/images/` are wide banners, not icon-shaped). Embedded as
 * a base64 data URI rather than referenced by path since the external MCP
 * server has no static-asset route and no guaranteed public base URL to
 * resolve a relative path against.
 */
const SERVER_ICON_SVG_BASE64 =
  'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMDI0IiBoZWlnaHQ9IjEwMjQiIHZpZXdCb3g9IjAgMCAxMDI0IDEwMjQiIGZpbGw9Im5vbmUiPgogIDxyZWN0IHdpZHRoPSIxMDI0IiBoZWlnaHQ9IjEwMjQiIHJ4PSIxODAiIGZpbGw9IiMxQTFBMUEiLz4KICA8IS0tICJEIiBnbHlwaCBmcm9tIHRoZSBET1JLIHdvcmRtYXJrLCBjZW50ZXJlZCBhbmQgc2NhbGVkIHRvIGZpbGwgdGhlIGljb24gLS0+CiAgPGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoMjEyLCAyMTIpIHNjYWxlKDEuNSkiPgogICAgPHBhdGggZD0iTTI5Mi4zMzMgMC4xMjdMMzk5LjgzMyA5Ni4xMjdMNDAwIDk2LjI3NlYyOTIuMjA3TDI5Mi4yMDcgNDAwSDBWMEgyOTIuMTlMMjkyLjMzMyAwLjEyN1pNMTM0LjUgMTQ4VjI0OUgyMzUuNVYxNDhIMTM0LjVaIiBmaWxsPSIjRkZGRkZGIi8+CiAgPC9nPgo8L3N2Zz4K';

/**
 * Server-level icon advertised in the `initialize` response's
 * `serverInfo.icons`. The MCP SDK's `registerTool()` config (1.29.0) does not
 * expose a per-tool `icons` field — only the wire-level `Tool` schema has
 * one — so per-tool icons aren't reachable without dropping to the low-level
 * `Server` API; see the PR description.
 */
export const SERVER_ICONS: Icon[] = [
  {
    src: `data:image/svg+xml;base64,${SERVER_ICON_SVG_BASE64}`,
    mimeType: 'image/svg+xml',
    sizes: ['any'],
  },
];
