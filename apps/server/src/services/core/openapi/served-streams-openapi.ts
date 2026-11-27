/**
 * The event streams the API document did not describe yet (DOR-4986): a
 * remote space room, a mini app's room thread, a folder scan, and the runtime
 * installs that stream their progress. Every one of them is in an `internal`
 * route group, so each lands in the internal part of the document; the census
 * (`http/__tests__/stream-census.test.ts`) holds that every served stream is
 * described somewhere.
 *
 * The chat, room, global and hub streams are described beside their other
 * routes (`openapi-registry.ts`, `events-openapi.ts`, `hub-computers-openapi.ts`).
 *
 * The frames of the install streams and of a thread's replies are plain
 * TypeScript types in `@dorkos/shared` and `@dorkos/extension-api`; the schemas
 * here mirror them, and the type checks at the bottom fail the typecheck when
 * a type gains, loses or changes a field.
 *
 * @module services/core/openapi/served-streams-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import type { RoomThreadEntry } from '@dorkos/extension-api';
import { RemoteCommunityEventSchema } from '@dorkos/shared/community-views';
import {
  AgentRuntimeSchema,
  DiscoveryCandidateSchema,
  ScanProgressSchema,
  type ExistingAgent,
} from '@dorkos/shared/mesh-schemas';
import {
  OLLAMA_TAG_PATTERN,
  type OllamaProvisionResult,
  type OllamaPullProgress,
  type OllamaPullResult,
} from '@dorkos/shared/runtime-connect';
import type { RuntimeProvisionProgress, RuntimeProvisionResult } from '@dorkos/shared/transport';
import { problemResponse } from './problem-openapi.js';

/** The body of `POST /api/discovery/scan`, which the route parses with it. */
export const DiscoveryScanRequestSchema = z.object({
  root: z.string().optional(),
  roots: z.array(z.string()).optional(),
  maxDepth: z.number().int().min(1).max(10).optional(),
  timeout: z.number().int().min(1000).max(120000).optional(),
});

/** The body of `POST /api/runtimes/opencode/ollama/pull`, which the route parses with it. */
export const OllamaPullRequestSchema = z.object({
  // Any syntactically valid Ollama tag: DorkOS pulls what you name, curated or
  // not (spec §3). The regex only rejects malformed input, never uncurated tags.
  model: z.string().min(1).regex(OLLAMA_TAG_PATTERN).optional(),
});

const RoomThreadEntrySchema = z.object({
  id: z.string(),
  seq: z.number().int(),
  author: z.object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(['person', 'agent', 'system']),
    isYou: z.boolean(),
  }),
  createdAt: z.string(),
  text: z.string(),
});

const ExistingAgentSchema = z.object({
  path: z.string(),
  name: z.string(),
  runtime: AgentRuntimeSchema,
  description: z.string(),
});

const RuntimeProvisionProgressSchema = z.object({
  stage: z.enum(['starting', 'installing', 'done', 'error']),
  message: z.string(),
});

const RuntimeProvisionResultSchema = z.object({
  ok: z.boolean(),
  binaryPath: z.string().optional(),
  error: z.string().optional(),
});

const OllamaPullProgressSchema = z.object({
  status: z.string(),
  completed: z.number().optional(),
  total: z.number().optional(),
  percent: z.number().optional(),
});

const OllamaPullResultSchema = z.object({
  ok: z.boolean(),
  model: z.string(),
  error: z.string().optional(),
});

const OllamaProvisionResultSchema = z.object({
  ok: z.boolean(),
  installMethod: z.enum(['brew', 'winget', 'manual']),
  error: z.string().optional(),
  status: z
    .unknown()
    .optional()
    .describe(
      'A fresh check of Ollama after the install, as `GET /api/runtimes/opencode/ollama` answers.'
    ),
});

/** An SSE answer whose frames' `data:` are one of `schema`. */
function eventStream(description: string, schema: z.ZodType) {
  return { description, content: { 'text/event-stream': { schema } } };
}

/** A stream of `progress` frames, then one `result` frame. */
function progressStream(progress: z.ZodType, result: z.ZodType) {
  return eventStream(
    'An SSE stream: `progress` frames while it runs, then one `result` frame with the outcome.',
    z.union([
      progress.describe('A `progress` frame.'),
      result.describe('The `result` frame, sent once, last.'),
    ])
  );
}

const NOT_HERE = problemResponse(
  '`operator_only`: only the person at this computer can install or download here.'
);

const PROVISION_RESPONSES = {
  200: progressStream(RuntimeProvisionProgressSchema, RuntimeProvisionResultSchema),
  403: NOT_HERE,
};

/**
 * Register the streams described here.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerServedStreamsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/communities/{ref}/rooms/{roomId}/events',
    tags: ['Communities'],
    summary: 'Stream a room in a remote space (SSE)',
    description:
      "The owner's own view of one remote room: a `snapshot` frame, then each new entry, each message changed in place, and the state of the owner's own deliveries, until the room closes or the reader leaves. Each frame's `event:` is its `type`; a `: keepalive` comment keeps a quiet stream open.",
    request: {
      params: z.object({ ref: z.string(), roomId: z.string() }),
      query: z.object({
        redactions: z
          .string()
          .optional()
          .describe(
            'The last `redactionCursor` you were given, so changes made while you were away still reach you.'
          ),
      }),
    },
    responses: {
      200: eventStream(
        "An SSE stream; each frame's `data:` is one event.",
        RemoteCommunityEventSchema
      ),
      403: problemResponse('`forbidden`: your access to this space does not allow reading it.'),
      404: problemResponse('No space connection by that reference.'),
      409: problemResponse('`reconnect_required`: reconnect this space to continue.'),
      502: problemResponse('`upstream_unavailable`: the space cannot be reached right now.'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/extensions/{id}/rooms/{roomId}/threads/{entryId}/events',
    tags: ['Extensions'],
    summary: "Stream new replies in a room thread, for a mini app's page (SSE)",
    description:
      "Each new reply in the thread, as a `reply` frame whose `id:` is the reply's `seq`. Send the last one back as `Last-Event-ID` (or `?after=`) to resume after it. The stream ends when the person takes the room away from the mini app or turns the mini app off.",
    request: {
      params: z.object({ id: z.string(), roomId: z.string(), entryId: z.string() }),
      query: z.object({
        after: z.string().optional().describe('Resume after this `seq`.'),
      }),
    },
    responses: {
      200: eventStream(
        "An SSE stream; each `reply` frame's `data:` is one reply.",
        RoomThreadEntrySchema
      ),
      400: problemResponse('Not a valid mini app id.'),
      403: problemResponse(
        'The mini app may not use that room, or the caller is not the person signed in.'
      ),
      404: problemResponse('No such mini app, room or thread, or the person cannot read it.'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/discovery/scan',
    tags: ['Discovery'],
    summary: 'Scan folders for agents and projects (SSE)',
    description:
      'Walks the folders named (the boundary when none) and streams what it finds: `candidate` frames for projects that could become agents, `existing-agent` frames for agents it registered from their own `.dork/agent.json`, `progress` frames, then `complete`. An `error` frame says the scan stopped early.',
    request: {
      body: { content: { 'application/json': { schema: DiscoveryScanRequestSchema } } },
    },
    responses: {
      200: eventStream(
        "An SSE stream. Each frame's `data:` is, by its `event:`: a `DiscoveryCandidate` (`candidate`), an existing agent (`existing-agent`), a `ScanProgress` (`progress`), the same with `timedOut` (`complete`), or `{ error }` (`error`).",
        z.union([
          DiscoveryCandidateSchema,
          ExistingAgentSchema.describe('An `existing-agent` frame.'),
          ScanProgressSchema,
          z
            .object({ ...ScanProgressSchema.shape, timedOut: z.boolean() })
            .describe('The `complete` frame.'),
          z.object({ error: z.string() }).describe('An `error` frame.'),
        ])
      ),
      400: problemResponse('The body did not pass its checks.'),
      403: problemResponse('`outside_boundary`: a folder is outside the ones DorkOS may use.'),
    },
  });

  // One call per path, each spelled out: the API lint matches a registration to
  // the hand-route allowlist by its literal path.
  registry.registerPath({
    method: 'post',
    path: '/api/runtimes/claude-code/provision',
    tags: ['Runtimes'],
    summary: 'Install Claude Code on this computer (SSE)',
    responses: PROVISION_RESPONSES,
  });
  registry.registerPath({
    method: 'post',
    path: '/api/runtimes/codex/provision',
    tags: ['Runtimes'],
    summary: 'Install Codex on this computer (SSE)',
    responses: PROVISION_RESPONSES,
  });
  registry.registerPath({
    method: 'post',
    path: '/api/runtimes/opencode/provision',
    tags: ['Runtimes'],
    summary: 'Install OpenCode on this computer (SSE)',
    responses: PROVISION_RESPONSES,
  });

  registry.registerPath({
    method: 'post',
    path: '/api/runtimes/opencode/ollama/provision',
    tags: ['Runtimes'],
    summary: 'Install Ollama on this computer (SSE)',
    responses: {
      200: progressStream(RuntimeProvisionProgressSchema, OllamaProvisionResultSchema),
      403: NOT_HERE,
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/runtimes/opencode/ollama/pull',
    tags: ['Runtimes'],
    summary: 'Download an Ollama model (SSE)',
    request: { body: { content: { 'application/json': { schema: OllamaPullRequestSchema } } } },
    responses: {
      200: progressStream(OllamaPullProgressSchema, OllamaPullResultSchema),
      400: problemResponse('That is not a valid Ollama model name.'),
      403: NOT_HERE,
    },
  });
}

/** True when `A` and `B` have exactly the same keys. */
type SameKeys<A, B> = [keyof A] extends [keyof B]
  ? [keyof B] extends [keyof A]
    ? true
    : false
  : false;

/**
 * Each mirror has the type's keys, and every value of the type fits it. A
 * failing line here means a type changed: change its schema above to match.
 */
const mirrors = {
  entry: true satisfies SameKeys<z.infer<typeof RoomThreadEntrySchema>, RoomThreadEntry>,
  existingAgent: true satisfies SameKeys<z.infer<typeof ExistingAgentSchema>, ExistingAgent>,
  provisionProgress: true satisfies SameKeys<
    z.infer<typeof RuntimeProvisionProgressSchema>,
    RuntimeProvisionProgress
  >,
  provisionResult: true satisfies SameKeys<
    z.infer<typeof RuntimeProvisionResultSchema>,
    RuntimeProvisionResult
  >,
  pullProgress: true satisfies SameKeys<
    z.infer<typeof OllamaPullProgressSchema>,
    OllamaPullProgress
  >,
  pullResult: true satisfies SameKeys<z.infer<typeof OllamaPullResultSchema>, OllamaPullResult>,
  ollamaProvision: true satisfies SameKeys<
    z.infer<typeof OllamaProvisionResultSchema>,
    OllamaProvisionResult
  >,
};

/** Every value of each type fits its mirror. */
type Fits<T, S extends z.ZodType> = T extends z.infer<S> ? true : false;
const fits = {
  entry: true satisfies Fits<RoomThreadEntry, typeof RoomThreadEntrySchema>,
  existingAgent: true satisfies Fits<ExistingAgent, typeof ExistingAgentSchema>,
  provisionProgress: true satisfies Fits<
    RuntimeProvisionProgress,
    typeof RuntimeProvisionProgressSchema
  >,
  provisionResult: true satisfies Fits<RuntimeProvisionResult, typeof RuntimeProvisionResultSchema>,
  pullProgress: true satisfies Fits<OllamaPullProgress, typeof OllamaPullProgressSchema>,
  pullResult: true satisfies Fits<OllamaPullResult, typeof OllamaPullResultSchema>,
  ollamaProvision: true satisfies Fits<OllamaProvisionResult, typeof OllamaProvisionResultSchema>,
};
void mirrors;
void fits;
