/**
 * DevTools bridge read tools (DOR-213, Phase 2) — the agent's eyes on the preview
 * it already opened.
 *
 * `browser_read_console` and `browser_read_network` are data-returning,
 * session-bound in-process MCP tools shaped exactly like `get_ui_state`
 * ({@link ./ui-tools}): each is bound to a session id at creation, reads that
 * session's server-side capture buffer synchronously, and returns structured
 * JSON. Together with `browser_navigate` (which opens the preview), they close
 * the loop that makes an agent trustworthy at frontend work: edit → preview →
 * read its own console errors and failed requests → fix, without a human relaying
 * "it's throwing a TypeError."
 *
 * The buffer is fed by the Phase 1 capture pipeline: an injected in-page shim
 * posts the preview's `console.*` + `fetch`/XHR activity to `window.parent`, the
 * DorkOS client relays it to `POST /api/sessions/:id/devtools/ingest`, and the
 * per-session {@link DevtoolsCaptureStore} rings retain it. These tools only
 * READ that store; they never touch the page or the injection path.
 *
 * WHY CLAUDE-CODE ONLY (Codex deliberately excluded, spec Assumption A2): the
 * rationale is identical to why `get_ui_state` is Codex-excluded
 * ({@link ../../codex/codex-ui-mcp-server}). Codex reaches DorkOS through an
 * EXTERNAL, session-less MCP server, so a tool there cannot resolve WHICH
 * session's buffer to read. And unlike the fire-and-forget `control_ui` write —
 * whose real effect the Codex event-mapper injects downstream where the session
 * IS in scope — a read tool must return the captured data IN its result, which a
 * session-less stub cannot produce. `browser_navigate` (opening the preview)
 * already works on both runtimes; Codex read parity is a tracked follow-up. So
 * these tools are registered ONLY on the in-process claude-code tool server and
 * are structurally absent from the Codex `dorkos_ui` server.
 *
 * @module services/runtimes/claude-code/mcp-tools/devtools-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type {
  DevtoolsConsoleEntry,
  DevtoolsConsoleLevel,
  DevtoolsNetworkEntry,
} from '@dorkos/shared/schemas';
import {
  devtoolsCaptureStore,
  type CaptureBufferView,
  type DevtoolsCaptureStore,
} from '../../../session/index.js';
import { WORKBENCH } from '../../../../config/constants.js';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/**
 * Default number of entries a read returns when the caller gives no `limit`.
 * Bounds the tool result so a chatty preview can't blow up the agent's context
 * window; the most-recent entries are the useful ones, so a read returns the
 * tail. Callers can raise it up to {@link MAX_READ_LIMIT}.
 */
const DEFAULT_READ_LIMIT = 50;

/** Hard ceiling on a single read, matching the largest server ring (console). */
const MAX_READ_LIMIT = WORKBENCH.DEVTOOLS_CONSOLE_BUFFER;

/** The subset of {@link DevtoolsCaptureStore} these read tools depend on. */
export type DevtoolsReadStore = Pick<DevtoolsCaptureStore, 'read'>;

/**
 * Error result returned by the session-less tool variants. Registering these
 * read tools without a bound session (an external MCP surface with no
 * interactive client) must not pretend to succeed — there is no session whose
 * preview buffer could be read.
 */
const SESSIONLESS_DEVTOOLS_ERROR = {
  error: 'browser_read_console and browser_read_network require an attached interactive session',
  detail:
    'These tools read the console/network the current session captured from its live preview. ' +
    'The current MCP surface has no session attached, so there is no preview buffer to read.',
};

/** Note shown when the session has never received a capture (no preview opened). */
const NO_PREVIEW_NOTE =
  'No preview is open for this session yet, so nothing has been captured. Open a local ' +
  'preview with browser_navigate first (a local HTML file or a localhost dev server); ' +
  'external sites and pages with a strict Content-Security-Policy are not instrumented.';

/** `limit` input shared by both read tools. */
const LIMIT_INPUT = z
  .number()
  .int()
  .positive()
  .max(MAX_READ_LIMIT)
  .optional()
  .describe(`Max entries to return, newest first (default ${DEFAULT_READ_LIMIT}).`);

/** Input shape for `browser_read_console`. */
const READ_CONSOLE_INPUT = {
  level: z
    .enum(['all', 'error', 'warn', 'info', 'log', 'debug'])
    .optional()
    .describe('Filter by console level (default "all"). Uncaught errors are captured at "error".'),
  limit: LIMIT_INPUT,
};

/** Input shape for `browser_read_network`. */
const READ_NETWORK_INPUT = {
  status: z
    .enum(['all', 'failed', '2xx', '3xx', '4xx', '5xx'])
    .optional()
    .describe(
      'Filter by outcome (default "all"). "failed" = any non-2xx response or network error; ' +
        '"2xx"/"3xx"/"4xx"/"5xx" filter by status class.'
    ),
  limit: LIMIT_INPUT,
};

/** Parsed, defaulted console args (tolerant of a raw handler payload). */
const ConsoleArgsSchema = z.object(READ_CONSOLE_INPUT);
/** Parsed, defaulted network args (tolerant of a raw handler payload). */
const NetworkArgsSchema = z.object(READ_NETWORK_INPUT);

/** Take the newest `limit` entries; returns `{ page, omitted }`. */
function tail<T>(entries: T[], limit: number): { page: T[]; omitted: number } {
  if (entries.length <= limit) return { page: entries, omitted: 0 };
  return { page: entries.slice(entries.length - limit), omitted: entries.length - limit };
}

/** Keep only network entries matching a status filter. */
function matchesNetworkStatus(
  entry: DevtoolsNetworkEntry,
  status: z.infer<typeof NetworkArgsSchema>['status']
): boolean {
  switch (status) {
    case undefined:
    case 'all':
      return true;
    case 'failed':
      return !entry.ok;
    case '2xx':
      return entry.status >= 200 && entry.status < 300;
    case '3xx':
      return entry.status >= 300 && entry.status < 400;
    case '4xx':
      return entry.status >= 400 && entry.status < 500;
    case '5xx':
      return entry.status >= 500 && entry.status < 600;
  }
}

/** Header fields every read result carries so the agent can judge freshness. */
function bufferHeader(buffer: CaptureBufferView | undefined) {
  return {
    documentUrl: buffer?.logicalUrl,
    capturedAt: buffer?.updatedAt,
  };
}

/**
 * Build the `note` for a result whose ring is empty. Distinguishes "no preview
 * open at all" (open one) from "preview connected but silent" (a clean console
 * is a good outcome, or the page simply hasn't emitted the signal yet).
 */
function emptyRingNote(
  buffer: CaptureBufferView | undefined,
  signal: 'console' | 'network'
): string {
  if (!buffer) return NO_PREVIEW_NOTE;
  const where = buffer.logicalUrl ? ` (${buffer.logicalUrl})` : '';
  return signal === 'console'
    ? `The preview${where} is connected but has logged nothing yet — a clean console, or the page hasn't run the code that logs.`
    : `The preview${where} is connected but has made no captured requests yet.`;
}

/**
 * Create the `browser_read_console` handler bound to a session id.
 *
 * Reads the session's capture buffer, filters by `level`, returns the newest
 * `limit` entries (default {@link DEFAULT_READ_LIMIT}), and flags `truncated`
 * when older entries were dropped — either by this call's `limit` or because the
 * server ring is at capacity and has already evicted the oldest lines.
 *
 * @param sessionId - The session whose preview buffer to read (bound at creation).
 * @param store - The capture store to read from (injectable for tests).
 */
export function createReadConsoleHandler(sessionId: string, store: DevtoolsReadStore) {
  return async (input: Record<string, unknown>) => {
    const { level, limit } = ConsoleArgsSchema.parse(input ?? {});
    const buffer = store.read(sessionId);
    const all = buffer?.console ?? [];
    const filtered =
      level && level !== 'all'
        ? all.filter((e) => e.level === (level as DevtoolsConsoleLevel))
        : all;

    if (filtered.length === 0) {
      return jsonContent({
        ...bufferHeader(buffer),
        entries: [] as DevtoolsConsoleEntry[],
        truncated: false,
        note: emptyRingNote(buffer, 'console'),
      });
    }

    const { page, omitted } = tail(filtered, limit ?? DEFAULT_READ_LIMIT);
    const ringAtCap = all.length >= WORKBENCH.DEVTOOLS_CONSOLE_BUFFER;
    const truncated = omitted > 0 || ringAtCap;
    return jsonContent({
      ...bufferHeader(buffer),
      entries: page,
      truncated,
      ...(truncated && {
        note:
          `Showing the ${page.length} most recent of ${filtered.length} captured console ` +
          `entries${omitted > 0 ? ` (raise \`limit\` to see up to ${MAX_READ_LIMIT})` : ''}` +
          `${ringAtCap ? '; the server buffer is full, so still-older lines were already dropped' : ''}.`,
      }),
    });
  };
}

/**
 * Create the `browser_read_network` handler bound to a session id.
 *
 * Reads the session's capture buffer, filters by `status` class, returns the
 * newest `limit` requests (default {@link DEFAULT_READ_LIMIT}), and flags
 * `truncated` when older requests were dropped by this call's `limit` or because
 * the server ring is at capacity.
 *
 * @param sessionId - The session whose preview buffer to read (bound at creation).
 * @param store - The capture store to read from (injectable for tests).
 */
export function createReadNetworkHandler(sessionId: string, store: DevtoolsReadStore) {
  return async (input: Record<string, unknown>) => {
    const { status, limit } = NetworkArgsSchema.parse(input ?? {});
    const buffer = store.read(sessionId);
    const all = buffer?.network ?? [];
    const filtered = all.filter((e) => matchesNetworkStatus(e, status));

    if (filtered.length === 0) {
      return jsonContent({
        ...bufferHeader(buffer),
        requests: [] as DevtoolsNetworkEntry[],
        truncated: false,
        note: emptyRingNote(buffer, 'network'),
      });
    }

    const { page, omitted } = tail(filtered, limit ?? DEFAULT_READ_LIMIT);
    const ringAtCap = all.length >= WORKBENCH.DEVTOOLS_NETWORK_BUFFER;
    const truncated = omitted > 0 || ringAtCap;
    return jsonContent({
      ...bufferHeader(buffer),
      requests: page,
      truncated,
      ...(truncated && {
        note:
          `Showing the ${page.length} most recent of ${filtered.length} captured requests` +
          `${omitted > 0 ? ` (raise \`limit\` to see up to ${MAX_READ_LIMIT})` : ''}` +
          `${ringAtCap ? '; the server buffer is full, so still-older requests were already dropped' : ''}.`,
      }),
    });
  };
}

const READ_CONSOLE_DESCRIPTION =
  "Read the console output your session's live preview captured — `console.*` lines plus " +
  'uncaught errors and unhandled promise rejections, with stack traces. Use it after ' +
  'browser_navigate opens a local preview to check your own work: read the errors, fix them, ' +
  're-read to confirm a clean console. Filter by `level` and cap with `limit`. Returns a note ' +
  'when no preview is open or the page cannot be instrumented.';

const READ_NETWORK_DESCRIPTION =
  "Read the network requests your session's live preview captured — each `fetch`/XHR call's " +
  'method, URL, status, timing, and response size, including failures. Use it after ' +
  'browser_navigate to catch a 404 on a missing asset or a failing API call. Filter by ' +
  '`status` ("failed" for anything non-2xx) and cap with `limit`. Returns a note when no ' +
  'preview is open or the page cannot be instrumented.';

/**
 * Returns the DevTools read-tool definitions for registration with the
 * claude-code in-process MCP server.
 *
 * When `sessionId` is provided (the per-query in-process server), the handlers
 * read that session's live preview buffer. Without one — an external MCP surface
 * with no interactive client — both tools return an MCP error rather than
 * fabricating an empty read, exactly as `get_ui_state` does. Codex never reaches
 * this function (see the module doc): it has its own scoped `dorkos_ui` server
 * that exposes only `control_ui`.
 *
 * @param _deps - Shared tool dependencies (unused by the read tools).
 * @param sessionId - The per-query session id whose preview buffer to read.
 * @param store - The capture store to read from (defaults to the process-wide singleton; injectable for tests).
 */
export function getDevtoolsTools(
  _deps: McpToolDeps,
  sessionId?: string,
  store: DevtoolsReadStore = devtoolsCaptureStore
) {
  const readConsoleHandler = sessionId
    ? createReadConsoleHandler(sessionId, store)
    : async () => jsonContent(SESSIONLESS_DEVTOOLS_ERROR, true);

  const readNetworkHandler = sessionId
    ? createReadNetworkHandler(sessionId, store)
    : async () => jsonContent(SESSIONLESS_DEVTOOLS_ERROR, true);

  return [
    tool('browser_read_console', READ_CONSOLE_DESCRIPTION, READ_CONSOLE_INPUT, async (input) =>
      readConsoleHandler(input)
    ),
    tool('browser_read_network', READ_NETWORK_DESCRIPTION, READ_NETWORK_INPUT, async (input) =>
      readNetworkHandler(input)
    ),
  ];
}
