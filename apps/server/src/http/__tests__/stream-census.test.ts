/**
 * Every event stream the server serves is in the API document, with a typed
 * schema for its frames (DOR-4986).
 *
 * A stream is found in the source, not trusted to a list: every production
 * file that writes or names `text/event-stream`, or opens a stream through one
 * of the server's own SSE writers, is in {@link SOURCES} with how many times it
 * does, and says which streams it serves or why it serves none. A new stream,
 * or a new writer in a file already listed, changes a count and fails here.
 *
 * Each `/api` stream must then be:
 *
 * - a `stream` entry on the hand-route allowlist (`../hand-routes/allowlist.ts`);
 * - in the generated API document with a `text/event-stream` answer whose
 *   schema says what a frame holds (not a bare string);
 * - `internal` only while no public docs page sends readers to it, since a
 *   stream public docs point at is at least `preview` (the rule for a group in
 *   `contributing/api-reference.md`).
 *
 * A stream that cannot be described yet waits on {@link NOT_DOCUMENTED_YET},
 * with the reason and what ends the wait.
 *
 * Streams outside `/api` speak another protocol with its own specification
 * ({@link OTHER_PROTOCOL_STREAMS}); they are checked only to be served.
 *
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HAND_ROUTE_ALLOWLIST } from '../hand-routes/allowlist.js';
import { generateOpenAPISpec } from '../../services/core/openapi-registry.js';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = path.resolve(SERVER_SRC, '../../..');
const CENSUS = path.join(SERVER_SRC, 'http/__tests__/route-census.baseline.json');

/**
 * What opens or names a stream in production code: the SSE content type, the
 * server's own SSE writers, Hono's SSE helper, any import from `hono/streaming`,
 * and `streamToNodeResponse`, through which every raw Node response is written.
 */
const MARKER =
  /text\/event-stream|new SseStreamSink\(|streamSseAction\(|initSSEStream\(|streamSSE\(|streamToNodeResponse\(|from 'hono\/streaming'/g;

/** Hono's other streaming helpers, counted in a file that imports `hono/streaming`. */
const HONO_HELPER = /\b(?:stream|streamText)\(/g;

/** How many markers a file's source holds. */
function markerCount(source: string): number {
  const helpers = source.includes("from 'hono/streaming'")
    ? (source.match(HONO_HELPER)?.length ?? 0)
    : 0;
  return (source.match(MARKER)?.length ?? 0) + helpers;
}

/** One file with markers: how many, and what it serves or why it serves nothing. */
type Source =
  | { readonly markers: number; readonly serves: readonly string[] }
  | { readonly markers: number; readonly why: string };

const API_DOCUMENT = 'the API document';
const CLIENT = "a client reading another server's stream";
const BYTES = "writes a file's bytes, not an event stream";

/** Every production file under `apps/server/src` with a marker, by path. */
const SOURCES: Readonly<Record<string, Source>> = {
  'routes/discovery.ts': { markers: 2, serves: ['POST /api/discovery/scan'] },
  'routes/events.ts': { markers: 2, serves: ['GET /api/events'] },
  'routes/extensions-rooms.ts': {
    markers: 2,
    serves: ['GET /api/extensions/:id/rooms/:roomId/threads/:entryId/events'],
  },
  'routes/hub-computer-stream.ts': {
    markers: 2,
    serves: ['GET /api/hub/computers/:computerId/sessions/:sessionId/events'],
  },
  'routes/hub-computers.ts': {
    markers: 2,
    why: 'refuses a request to the hub stream that does not accept one',
  },
  'routes/remote-community-events.ts': {
    markers: 2,
    serves: ['GET /api/communities/:ref/rooms/:roomId/events'],
  },
  'routes/room-events-handler.ts': { markers: 2, serves: ['GET /api/rooms/:id/events'] },
  'routes/mock-mcp-oauth-server.ts': {
    markers: 1,
    why: 'a test MCP server under /api/test that only a test server mounts',
  },
  'routes/remote-communities.ts': { markers: 1, why: BYTES },
  'routes/room-attachments.ts': { markers: 1, why: BYTES },
  'routes/rooms.ts': { markers: 1, why: 'writes a room export as a file download' },
  'routes/runtimes-http.ts': { markers: 2, why: 'defines streamSseAction' },
  'routes/runtimes.ts': {
    markers: 3,
    serves: [
      'POST /api/runtimes/claude-code/provision',
      'POST /api/runtimes/codex/provision',
      'POST /api/runtimes/opencode/provision',
      'POST /api/runtimes/opencode/ollama/provision',
      'POST /api/runtimes/opencode/ollama/pull',
    ],
  },
  'routes/session-attachments-handler.ts': { markers: 1, why: BYTES },
  'routes/session-events-handler.ts': { markers: 2, serves: ['GET /api/sessions/:id/events'] },
  'services/communities/remote/pinned-origin.ts': { markers: 1, why: CLIENT },
  'services/core/cloud/v1-client.ts': { markers: 1, why: CLIENT },
  'services/core/hub-relay/hub-computers-openapi.ts': { markers: 2, why: API_DOCUMENT },
  'services/core/hub/hub-serving.ts': {
    markers: 1,
    why: 'treats a request for a stream as one that must come from the hub page',
  },
  'services/core/openapi-registry.ts': { markers: 2, why: API_DOCUMENT },
  'services/core/openapi/events-openapi.ts': { markers: 1, why: API_DOCUMENT },
  'services/core/openapi/served-streams-openapi.ts': { markers: 1, why: API_DOCUMENT },
  'services/core/remote/command-stream.ts': { markers: 2, why: CLIENT },
  'services/core/remote/managed-activity.ts': {
    markers: 2,
    why: 'keeps a managed computer awake while a stream is open',
  },
  'services/extensions/http/oversized-body-response.ts': {
    markers: 1,
    why: 'answers an oversized upload with a problem document',
  },
  'services/core/streams/durable-stream-sink.ts': { markers: 1, why: 'defines SseStreamSink' },
  'services/core/streams/stream-adapter.ts': { markers: 2, why: 'defines initSSEStream' },
  'services/runtimes/opencode/computer/provider.ts': { markers: 1, why: CLIENT },
  'services/runtimes/test-mode/fake-inference.ts': {
    markers: 2,
    why: 'a fake model under /api/test that only a test server mounts',
  },
  'services/spaces/routes/community/events.ts': {
    markers: 1,
    why: "the space server's own channel stream, a separate server with its own protocol",
  },
};

/**
 * `/api` streams kept out of the API document for now, each with why and what
 * ends the wait. Documenting one before its path is fixed would raise the API
 * lint's `verb-path` count.
 */
const NOT_DOCUMENTED_YET: Readonly<Record<string, string>> = {
  'POST /api/discovery/scan': 'verb path; renamed in A5 (DOR-4982), then documented',
};

/** Streams outside `/api`, each with the specification that describes it. */
const OTHER_PROTOCOL_STREAMS: Readonly<Record<string, string>> = {
  'GET /mcp': 'MCP Streamable HTTP (the MCP specification)',
  'POST /mcp': 'MCP Streamable HTTP (the MCP specification)',
  'POST /a2a': 'A2A `message/stream` (the A2A specification; the agent card describes it)',
  'POST /a2a/agents/:id': 'A2A `message/stream`, for one agent',
};

/** Every production `.ts` file under a directory, relative to `apps/server/src`. */
function productionSources(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') {
        files.push(...productionSources(full));
      }
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !/\.(test|spec)\.ts$/.test(entry.name)
    ) {
      files.push(path.relative(SERVER_SRC, full));
    }
  }
  return files;
}

/** Every public docs page, outside the generated API reference. */
function publicDocsPages(dir: string): string[] {
  const pages: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full !== path.join(REPO_ROOT, 'docs/api')) pages.push(...publicDocsPages(full));
    } else if (/\.mdx?$/.test(entry.name)) {
      pages.push(full);
    }
  }
  return pages;
}

/** `GET /api/rooms/:id/events` as the document writes it: `GET /api/rooms/{id}/events`. */
function documentKey(route: string): string {
  return route.replace(/:(\w+)/g, '{$1}');
}

/** A pattern that finds a route's path in prose, whatever its parameters are called. */
function pathPattern(route: string): RegExp {
  const routePath = route.slice(route.indexOf(' ') + 1);
  const parts = routePath
    .split('/')
    .map((part) =>
      part.startsWith(':') ? '[^/\\s`)]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    );
  return new RegExp(`${parts.join('/')}(?![\\w/-])`);
}

const API_STREAMS = HAND_ROUTE_ALLOWLIST.filter((entry) => entry.category === 'stream').map(
  (entry) => `${entry.method} ${entry.path}`
);
/** The `/api` streams the document describes: all but those waiting. */
const DOCUMENTED_STREAMS = API_STREAMS.filter((route) => !(route in NOT_DOCUMENTED_YET));

describe('stream census', () => {
  const doc = generateOpenAPISpec();

  it('lists every production file that opens or names an event stream', () => {
    const found: Record<string, number> = {};
    for (const file of productionSources(SERVER_SRC)) {
      const count = markerCount(readFileSync(path.join(SERVER_SRC, file), 'utf8'));
      if (count > 0) found[file] = count;
    }
    const listed = Object.fromEntries(
      Object.entries(SOURCES).map(([file, source]) => [file, source.markers])
    );
    expect(found).toEqual(listed);
  });

  it('names every served /api stream on the hand-route allowlist', () => {
    const served = Object.values(SOURCES).flatMap((source) =>
      'serves' in source ? source.serves : []
    );
    expect([...served].sort()).toEqual([...API_STREAMS].sort());
  });

  it('describes every /api stream in the API document, with typed frames', () => {
    const undescribed: string[] = [];
    for (const route of DOCUMENTED_STREAMS) {
      const [method = '', routePath = ''] = documentKey(route).split(' ');
      const operation = doc.paths?.[routePath]?.[method.toLowerCase() as 'get'] as
        | { responses?: Record<string, { content?: Record<string, { schema?: object }> }> }
        | undefined;
      const schema = operation?.responses?.['200']?.content?.['text/event-stream']?.schema;
      if (!schema || JSON.stringify(schema) === '{"type":"string"}') undescribed.push(route);
    }
    expect(undescribed).toEqual([]);
  });

  it('documents no event stream that is not a served /api stream', () => {
    const documented = Object.entries(doc.paths ?? {}).flatMap(([routePath, item]) =>
      Object.entries(item as Record<string, unknown>).flatMap(([method, operation]) =>
        JSON.stringify(
          (operation as { responses?: unknown } | undefined)?.responses ?? {}
        ).includes('"text/event-stream"')
          ? [`${method.toUpperCase()} ${routePath}`]
          : []
      )
    );
    expect(documented.sort()).toEqual(DOCUMENTED_STREAMS.map(documentKey).sort());
  });

  it('keeps internal only the streams no public docs page sends readers to', () => {
    const pages = publicDocsPages(path.join(REPO_ROOT, 'docs')).map((page) => ({
      page: path.relative(REPO_ROOT, page),
      text: readFileSync(page, 'utf8'),
    }));
    const misfiled: string[] = [];
    for (const route of DOCUMENTED_STREAMS) {
      const [method = '', routePath = ''] = documentKey(route).split(' ');
      const operation = doc.paths?.[routePath]?.[method.toLowerCase() as 'get'] as
        { 'x-stability'?: string } | undefined;
      if (operation?.['x-stability'] !== 'internal') continue;
      const pattern = pathPattern(route);
      for (const { page, text } of pages) {
        if (pattern.test(text)) misfiled.push(`${route} is internal but ${page} names it`);
      }
    }
    expect(misfiled).toEqual([]);
  });

  it('keeps waiting only served /api streams, each with its ticket', () => {
    for (const [route, reason] of Object.entries(NOT_DOCUMENTED_YET)) {
      expect(API_STREAMS).toContain(route);
      expect(reason, route).toMatch(/DOR-\d+/);
    }
  });

  it('serves every stream outside /api that it names', () => {
    const census = JSON.parse(readFileSync(CENSUS, 'utf8')) as { routes: string[] };
    for (const route of Object.keys(OTHER_PROTOCOL_STREAMS)) {
      expect(census.routes, route).toContain(route);
    }
  });

  it('counts every way to open a stream, and Hono helpers only where Hono streaming is imported', () => {
    const hono = "import { stream, streamSSE, streamText } from 'hono/streaming';";
    expect(markerCount(`${hono}\nstreamSSE(c, f); stream(c, f); streamText(c, f);`)).toBe(4);
    expect(markerCount('return streamToNodeResponse(c, write);')).toBe(1);
    expect(markerCount('export async function* streamText(body: string) {}')).toBe(0);
  });

  it('finds a path in prose by its shape, whatever its parameters are called', () => {
    const pattern = pathPattern('GET /api/rooms/:id/events');
    expect(pattern.test('Subscribe to `/api/rooms/:roomId/events` for that.')).toBe(true);
    expect(pattern.test('GET /api/rooms/{id}/events')).toBe(true);
    expect(pattern.test('GET /api/rooms/{id}/events-old')).toBe(false);
    expect(pattern.test('GET /api/rooms/{id}')).toBe(false);
  });
});
