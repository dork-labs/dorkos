/**
 * DevTools bridge agent tools (DOR-213) — the agent's eyes on the preview it
 * already opened.
 *
 * `browser_read_console` and `browser_read_network` are data-returning,
 * session-bound in-process MCP tools shaped exactly like `get_ui_state`
 * ({@link ./ui-tools}): each is bound to a session at creation, reads that
 * session's server-side capture buffer synchronously, and returns structured
 * JSON. `browser_screenshot` (Phase 3) adds the rendered pixels via an
 * on-demand round-trip: it pushes a `devtools_capture_request` StreamEvent to
 * the attached client (the `ui_command` seam), the client forwards it into the
 * preview frame, the in-page shim rasterizes its own document, and the PNG
 * returns through the normal ingest path tagged with the `requestId`. Together
 * with `browser_navigate` (which opens the preview), these close the loop that
 * makes an agent trustworthy at frontend work: edit → preview → read its own
 * console errors, failed requests, and rendered layout → fix, without a human
 * relaying "it's throwing a TypeError."
 *
 * The buffer is fed by the Phase 1 capture pipeline: an injected in-page shim
 * posts the preview's `console.*` + `fetch`/XHR activity to `window.parent`, the
 * DorkOS client relays it to `POST /api/sessions/:id/devtools/ingest`, and the
 * per-session {@link DevtoolsCaptureStore} rings retain it. These tools only
 * READ that store; they never touch the page or the injection path.
 *
 * SESSION BINDING resolves at READ time, not registration time: the handlers
 * hold a resolver (the live session's `sdkSessionId`, falling back to the
 * trigger id) because a brand-new session is rekeyed to its canonical SDK id
 * mid-first-turn (`rekeyProjector` → `rekeySession`), and a string captured at
 * query start would miss the moved buffer in exactly the fresh-session
 * build → preview → read-errors flow this feature exists for.
 *
 * RESULT SIZE is bounded three ways so a chatty preview can never blow up the
 * agent's context window: a per-call entry count (`limit`, default 50), a
 * per-entry field cap (long `text`/`stack`/`args` are elided with an explicit
 * marker), and a total serialized budget per result (newest entries win).
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
import { randomUUID } from 'node:crypto';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { DevtoolsConsoleEntry, DevtoolsNetworkEntry } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  devtoolsCaptureStore,
  type CaptureBufferView,
  type DevtoolsCaptureStore,
} from '../../../session/index.js';
import { WORKBENCH } from '../../../../config/constants.js';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/** Default number of entries a read returns when the caller gives no `limit`. */
const DEFAULT_READ_LIMIT = 50;

/**
 * Total serialized budget (JSON chars) for one read result's entry list. The
 * count `limit` alone cannot bound the payload — 50 max-size console entries
 * would serialize to megabytes — so after per-entry elision, entries are kept
 * newest-first until the budget is spent and the rest are dropped (reported via
 * `truncated` + `note`). ~64 KB keeps even a worst-case result a small fraction
 * of a context window.
 */
const RESULT_BUDGET_CHARS = 65_536;

/**
 * Per-field elision cap (chars) for one console entry's rendered `text`,
 * `stack`, and serialized `args`. A single 20 KB logged blob is almost never
 * what the agent needs; the head plus an explicit `… [truncated N chars]`
 * marker is, and it keeps entries small enough that the result budget buys
 * many of them.
 */
const FIELD_ELIDE_CHARS = 2_048;

/**
 * Resolves the session id whose capture buffer a read should hit, evaluated on
 * every call (see the module doc's session-binding note). Returns `undefined`
 * when no session can be resolved — the handler then reports the session-less
 * error instead of fabricating an empty read.
 */
export type DevtoolsSessionResolver = () => string | undefined;

/** The subset of {@link DevtoolsCaptureStore} these tools depend on. */
export type DevtoolsReadStore = Pick<DevtoolsCaptureStore, 'read' | 'awaitScreenshot'>;

/**
 * The subset of the live session `browser_screenshot` needs to reach the
 * attached client: the SSE event queue it pushes its `devtools_capture_request`
 * onto — the exact seam `control_ui` uses for `ui_command`.
 */
export interface DevtoolsEventSession {
  /** The per-turn StreamEvent queue drained into the durable session stream. */
  eventQueue: StreamEvent[];
  /** Wakes the queue drainer after a push. */
  eventQueueNotify?: () => void;
}

/**
 * Error result returned when no session can be resolved. Registering these
 * tools without a bound session (an external MCP surface with no interactive
 * client) must not pretend to succeed — there is no session whose preview
 * buffer could be read or asked for a screenshot.
 */
const SESSIONLESS_DEVTOOLS_ERROR = {
  error:
    'browser_read_console, browser_read_network, and browser_screenshot require an attached interactive session',
  detail:
    'These tools read the console/network/screenshot the current session captured from its live ' +
    'preview. The current MCP surface has no session attached, so there is no preview to reach.',
};

/** Note shown when the session has never received a capture (no preview opened). */
const NO_PREVIEW_NOTE =
  'No preview is open for this session yet, so nothing has been captured. Open a local ' +
  'preview with browser_navigate first (a local HTML file or a localhost dev server); ' +
  'external sites and pages with a strict Content-Security-Policy are not instrumented.';

/** Build the `limit` input for one tool, capped at that tool's server ring size. */
function limitInput(max: number) {
  return z
    .number()
    .int()
    .positive()
    .max(max)
    .optional()
    .describe(`Max entries to return, newest first (default ${DEFAULT_READ_LIMIT}, max ${max}).`);
}

/** Input shape for `browser_read_console`. */
const READ_CONSOLE_INPUT = {
  level: z
    .enum(['all', 'error', 'warn', 'info', 'log', 'debug'])
    .optional()
    .describe('Filter by console level (default "all"). Uncaught errors are captured at "error".'),
  limit: limitInput(WORKBENCH.DEVTOOLS_CONSOLE_BUFFER),
};

/** Input shape for `browser_read_network`. */
const READ_NETWORK_INPUT = {
  status: z
    .enum(['all', 'failed', '2xx', '3xx', '4xx', '5xx'])
    .optional()
    .describe(
      'Filter by outcome (default "all"). "failed" = network errors (status 0) plus 4xx/5xx ' +
        'responses — redirects (3xx) are not failures; "2xx"/"3xx"/"4xx"/"5xx" filter by status class.'
    ),
  limit: limitInput(WORKBENCH.DEVTOOLS_NETWORK_BUFFER),
};

const ConsoleArgsSchema = z.object(READ_CONSOLE_INPUT);
const NetworkArgsSchema = z.object(READ_NETWORK_INPUT);

/** Elide a string past {@link FIELD_ELIDE_CHARS} with an explicit marker. */
function elideString(value: string): string {
  if (value.length <= FIELD_ELIDE_CHARS) return value;
  const omitted = value.length - FIELD_ELIDE_CHARS;
  return `${value.slice(0, FIELD_ELIDE_CHARS)}… [truncated ${omitted} chars]`;
}

/**
 * Bound one console entry's big fields (`text`, `stack`, serialized `args`) so
 * a single giant logged blob cannot dominate the result budget. Elision is
 * always marked — the agent knows content was cut and by how much.
 */
function elideConsoleEntry(entry: DevtoolsConsoleEntry): DevtoolsConsoleEntry {
  const out: DevtoolsConsoleEntry = { ...entry, text: elideString(entry.text) };
  if (out.stack !== undefined) out.stack = elideString(out.stack);
  if (out.args !== undefined) {
    let argChars = 0;
    try {
      argChars = JSON.stringify(out.args)?.length ?? 0;
    } catch {
      argChars = Infinity; // unserializable — always elide
    }
    if (argChars > FIELD_ELIDE_CHARS) {
      out.args = [`… [args elided: ${argChars} chars; see "text" for the rendered form]`];
    }
  }
  return out;
}

/**
 * Keep the newest entries whose combined serialized size fits the result
 * budget. Returns the kept page (oldest-first, as captured) plus how many
 * candidates were dropped for size. Always keeps at least the newest entry so
 * a single over-budget entry still yields a result.
 *
 * @param entries - Filter- and limit-applied candidates, oldest-first.
 */
function fitBudget<T>(entries: T[]): { page: T[]; droppedForSize: number } {
  let spent = 0;
  const kept: T[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const size = JSON.stringify(entries[i])?.length ?? 0;
    if (kept.length > 0 && spent + size > RESULT_BUDGET_CHARS) break;
    spent += size;
    kept.unshift(entries[i]);
  }
  return { page: kept, droppedForSize: entries.length - kept.length };
}

/** Take the newest `limit` entries; returns `{ page, omitted }`. */
function tail<T>(entries: T[], limit: number): { page: T[]; omitted: number } {
  if (entries.length <= limit) return { page: entries, omitted: 0 };
  return { page: entries.slice(entries.length - limit), omitted: entries.length - limit };
}

/**
 * Keep only network entries matching a status filter. `failed` is deliberately
 * status-based (a network error, i.e. status 0, or a 4xx/5xx response) rather
 * than `!ok`, so classification is identical for fetch and XHR captures and
 * redirects never count as failures.
 */
function matchesNetworkStatus(
  entry: DevtoolsNetworkEntry,
  status: z.infer<typeof NetworkArgsSchema>['status']
): boolean {
  switch (status) {
    case undefined:
    case 'all':
      return true;
    case 'failed':
      return entry.status === 0 || entry.status >= 400;
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
 * Build the `note` for an empty result. Distinguishes three cases the agent
 * must react to differently: no preview open at all (open one), preview
 * connected but silent (a clean signal), and entries present but none matching
 * the filter (loosen the filter — do NOT conclude the page is silent).
 */
function emptyNote(
  buffer: CaptureBufferView | undefined,
  signal: 'console' | 'network',
  ringTotal: number,
  filterLabel?: string
): string {
  if (!buffer) return NO_PREVIEW_NOTE;
  if (ringTotal > 0 && filterLabel) {
    return signal === 'console'
      ? `No console entries at level "${filterLabel}" (${ringTotal} ${ringTotal === 1 ? 'entry' : 'entries'} at other levels — read with level "all" to see them).`
      : `No requests matching status "${filterLabel}" (${ringTotal} captured ${ringTotal === 1 ? 'request' : 'requests'} in total — read with status "all" to see them).`;
  }
  const where = buffer.logicalUrl ? ` (${buffer.logicalUrl})` : '';
  return signal === 'console'
    ? `The preview${where} is connected but has logged nothing yet — a clean console, or the page hasn't run the code that logs.`
    : `The preview${where} is connected but has made no captured requests yet.`;
}

/** Compose the truncation note from the three independent drop causes. */
function truncationNote(
  shown: number,
  matched: number,
  omittedByLimit: number,
  droppedForSize: number,
  ringEvicted: boolean,
  noun: string
): string | undefined {
  if (omittedByLimit === 0 && droppedForSize === 0 && !ringEvicted) return undefined;
  const parts: string[] = [];
  if (omittedByLimit > 0 || droppedForSize > 0) {
    parts.push(
      `showing the ${shown} most recent of ${matched} matching ${noun}` +
        (droppedForSize > 0
          ? ` (${droppedForSize} dropped to keep this result under its size budget)`
          : ' (raise `limit` to see more)')
    );
  }
  if (ringEvicted) {
    parts.push(`the server buffer overflowed earlier, so the oldest ${noun} were already dropped`);
  }
  const joined = parts.join('; ');
  return joined.charAt(0).toUpperCase() + joined.slice(1) + '.';
}

/**
 * Create the `browser_read_console` handler.
 *
 * Resolves the session id per call (see the module doc), reads its capture
 * buffer, filters by `level`, keeps the newest `limit` entries, elides oversized
 * fields, and fits the result to the serialized budget. `truncated` is true
 * whenever anything the filter matched is not in the result — by `limit`, by the
 * size budget, or because the server ring already evicted entries (count cap OR
 * byte budget).
 *
 * @param resolveSessionId - Read-time session-id resolver.
 * @param store - The capture store to read from (injectable for tests).
 */
export function createReadConsoleHandler(
  resolveSessionId: DevtoolsSessionResolver,
  store: DevtoolsReadStore
) {
  return async (input: Record<string, unknown>) => {
    const parsed = ConsoleArgsSchema.safeParse(input ?? {});
    if (!parsed.success) {
      return jsonContent({ error: 'Invalid input', details: parsed.error.issues }, true);
    }
    const { level, limit } = parsed.data;
    const sessionId = resolveSessionId();
    if (!sessionId) return jsonContent(SESSIONLESS_DEVTOOLS_ERROR, true);

    const buffer = store.read(sessionId);
    const all = buffer?.console ?? [];
    const filtered = level && level !== 'all' ? all.filter((e) => e.level === level) : all;

    if (filtered.length === 0) {
      return jsonContent({
        ...bufferHeader(buffer),
        entries: [] as DevtoolsConsoleEntry[],
        truncated: false,
        note: emptyNote(buffer, 'console', all.length, level !== 'all' ? level : undefined),
      });
    }

    const { page: limited, omitted } = tail(filtered, limit ?? DEFAULT_READ_LIMIT);
    const { page, droppedForSize } = fitBudget(limited.map(elideConsoleEntry));
    const ringEvicted = buffer?.consoleEvicted ?? false;
    const truncated = omitted > 0 || droppedForSize > 0 || ringEvicted;
    return jsonContent({
      ...bufferHeader(buffer),
      entries: page,
      truncated,
      ...(truncated && {
        note: truncationNote(
          page.length,
          filtered.length,
          omitted,
          droppedForSize,
          ringEvicted,
          'console entries'
        ),
      }),
    });
  };
}

/**
 * Create the `browser_read_network` handler.
 *
 * Resolves the session id per call (see the module doc), reads its capture
 * buffer, filters by `status` class, keeps the newest `limit` requests, and fits
 * the result to the serialized budget. `truncated` semantics mirror
 * {@link createReadConsoleHandler}.
 *
 * @param resolveSessionId - Read-time session-id resolver.
 * @param store - The capture store to read from (injectable for tests).
 */
export function createReadNetworkHandler(
  resolveSessionId: DevtoolsSessionResolver,
  store: DevtoolsReadStore
) {
  return async (input: Record<string, unknown>) => {
    const parsed = NetworkArgsSchema.safeParse(input ?? {});
    if (!parsed.success) {
      return jsonContent({ error: 'Invalid input', details: parsed.error.issues }, true);
    }
    const { status, limit } = parsed.data;
    const sessionId = resolveSessionId();
    if (!sessionId) return jsonContent(SESSIONLESS_DEVTOOLS_ERROR, true);

    const buffer = store.read(sessionId);
    const all = buffer?.network ?? [];
    const filtered = all.filter((e) => matchesNetworkStatus(e, status));

    if (filtered.length === 0) {
      return jsonContent({
        ...bufferHeader(buffer),
        requests: [] as DevtoolsNetworkEntry[],
        truncated: false,
        note: emptyNote(buffer, 'network', all.length, status !== 'all' ? status : undefined),
      });
    }

    const { page: limited, omitted } = tail(filtered, limit ?? DEFAULT_READ_LIMIT);
    const { page, droppedForSize } = fitBudget(limited);
    const ringEvicted = buffer?.networkEvicted ?? false;
    const truncated = omitted > 0 || droppedForSize > 0 || ringEvicted;
    return jsonContent({
      ...bufferHeader(buffer),
      requests: page,
      truncated,
      ...(truncated && {
        note: truncationNote(
          page.length,
          filtered.length,
          omitted,
          droppedForSize,
          ringEvicted,
          'requests'
        ),
      }),
    });
  };
}

/**
 * Create the `browser_screenshot` handler.
 *
 * Resolves the session id per call, then drives the on-demand round-trip: push
 * a `devtools_capture_request` StreamEvent (with a fresh `requestId`) onto the
 * session's event queue — the same seam `control_ui` uses — and await the
 * matching ingest in the capture store. The attached client forwards the
 * request into the preview frame, the in-page shim rasterizes its own document
 * (the parent cannot canvas-read an opaque-origin frame), and the PNG data URL
 * returns through the normal postMessage → ingest path tagged with the
 * `requestId`. Times out with a structured note — never a hang.
 *
 * @param resolveSessionId - Read-time session-id resolver.
 * @param store - The capture store to await the round-trip on (injectable for tests).
 * @param session - The live session whose event queue reaches the attached client.
 * @param timeoutMs - Round-trip timeout (injectable for tests).
 */
export function createBrowserScreenshotHandler(
  resolveSessionId: DevtoolsSessionResolver,
  store: DevtoolsReadStore,
  session: DevtoolsEventSession,
  timeoutMs: number = WORKBENCH.DEVTOOLS_SCREENSHOT_TIMEOUT_MS
) {
  return async () => {
    const sessionId = resolveSessionId();
    if (!sessionId) return jsonContent(SESSIONLESS_DEVTOOLS_ERROR, true);

    // No capture buffer means no instrumented preview has ever connected —
    // waiting the full timeout would be pointless; tell the agent what to do.
    const buffer = store.read(sessionId);
    if (!buffer) {
      return jsonContent({ captured: false, note: NO_PREVIEW_NOTE });
    }

    const requestId = randomUUID();
    session.eventQueue.push({
      type: 'devtools_capture_request',
      data: { requestId },
    } as StreamEvent);
    session.eventQueueNotify?.();

    const outcome = await store.awaitScreenshot(requestId, timeoutMs);
    if (outcome === undefined) {
      return jsonContent({
        ...bufferHeader(buffer),
        captured: false,
        note:
          `The preview didn't return a screenshot within ${Math.round(timeoutMs / 1000)}s. ` +
          'The preview tab may be closed or not visible, the client may be disconnected, or ' +
          "the page's Content-Security-Policy may block the rasterizer. Confirm the preview " +
          'is open (browser_navigate) and visible, then try again.',
      });
    }
    if (!outcome.ok) {
      return jsonContent({
        ...bufferHeader(buffer),
        captured: false,
        note: `The preview could not be rasterized: ${outcome.error}`,
      });
    }

    // Split the data URL into MCP image content. The shim always produces
    // image/png; parse defensively so a malformed relay degrades to a note.
    const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(outcome.screenshot.dataUrl);
    if (!match) {
      return jsonContent({
        ...bufferHeader(buffer),
        captured: false,
        note: 'The preview returned malformed screenshot data. Try again.',
      });
    }
    return {
      content: [
        { type: 'image' as const, data: match[2], mimeType: match[1] },
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              documentUrl: buffer.logicalUrl,
              capturedAt: outcome.screenshot.capturedAt,
            },
            null,
            2
          ),
        },
      ],
    };
  };
}

const READ_CONSOLE_DESCRIPTION =
  "Read the console output your session's live preview captured — `console.*` lines plus " +
  'uncaught errors and unhandled promise rejections, with stack traces. Use it after ' +
  'browser_navigate opens a local preview to check your own work: read the errors, fix them, ' +
  're-read to confirm a clean console. Filter by `level` and cap with `limit`; oversized ' +
  'entries are elided with an explicit marker. Returns a note when no preview is open or the ' +
  'page cannot be instrumented.';

const READ_NETWORK_DESCRIPTION =
  "Read the network requests your session's live preview captured — each `fetch`/XHR call's " +
  'method, URL, status, timing, and response size. Use it after browser_navigate to catch a ' +
  '404 on a missing asset or a failing API call. Filter by `status` — "failed" means network ' +
  'errors (status 0) plus 4xx/5xx responses; redirects are not failures — and cap with ' +
  '`limit`. Returns a note when no preview is open or the page cannot be instrumented.';

const SCREENSHOT_DESCRIPTION =
  "Capture a screenshot of your session's live preview as it is rendered right now. Use it " +
  'after browser_navigate to eyeball layout, styling, or a blank-screen failure your console ' +
  'read cannot explain. The image is scaled to at most 1568px on its long edge. Works on ' +
  'local previews the workbench serves or proxies; returns a note when no preview is open, ' +
  'the page cannot be instrumented, or the capture times out.';

/**
 * Returns the DevTools tool definitions for registration with the claude-code
 * in-process MCP server: the two buffer reads plus the on-demand
 * `browser_screenshot` round-trip.
 *
 * When `resolveSessionId` is provided (the per-query in-process server), the
 * handlers resolve the session id on every call and reach that session's live
 * preview. Without one — an external MCP surface with no interactive client —
 * all three tools return an MCP error rather than fabricating an empty result,
 * exactly as `get_ui_state` does. `browser_screenshot` additionally needs the
 * live `session` (its event queue reaches the attached client); without it the
 * screenshot tool registers session-less too. Codex never reaches this function
 * (see the module doc): it has its own scoped `dorkos_ui` server that exposes
 * only `control_ui`.
 *
 * @param _deps - Shared tool dependencies (unused by the DevTools tools).
 * @param resolveSessionId - Read-time resolver for the bound session's id.
 * @param store - The capture store (defaults to the process-wide singleton; injectable for tests).
 * @param session - The live session whose event queue carries the capture request.
 */
export function getDevtoolsTools(
  _deps: McpToolDeps,
  resolveSessionId?: DevtoolsSessionResolver,
  store: DevtoolsReadStore = devtoolsCaptureStore,
  session?: DevtoolsEventSession
) {
  const sessionlessHandler = async () => jsonContent(SESSIONLESS_DEVTOOLS_ERROR, true);

  const readConsoleHandler = resolveSessionId
    ? createReadConsoleHandler(resolveSessionId, store)
    : sessionlessHandler;

  const readNetworkHandler = resolveSessionId
    ? createReadNetworkHandler(resolveSessionId, store)
    : sessionlessHandler;

  const screenshotHandler =
    resolveSessionId && session
      ? createBrowserScreenshotHandler(resolveSessionId, store, session)
      : sessionlessHandler;

  return [
    tool('browser_read_console', READ_CONSOLE_DESCRIPTION, READ_CONSOLE_INPUT, async (input) =>
      readConsoleHandler(input)
    ),
    tool('browser_read_network', READ_NETWORK_DESCRIPTION, READ_NETWORK_INPUT, async (input) =>
      readNetworkHandler(input)
    ),
    tool('browser_screenshot', SCREENSHOT_DESCRIPTION, {}, async () => screenshotHandler()),
  ];
}
