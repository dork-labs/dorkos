/**
 * A `DORKOS_TEST_RUNTIME`-only fake OpenAI-compatible inference endpoint
 * (DOR-2783), mounted in-process at `/api/test/fake-inference/v1`.
 *
 * The fake `/v1` Cloud (`fake-cloud-v1.ts`) mints tokens whose endpoints point
 * here, so a chat that runs on DorkOS credits in test mode streams a short
 * canned reply from this server instead of reaching any model service. It
 * speaks the Chat Completions wire (`GET /v1/models`, streaming
 * `POST /v1/chat/completions` with usage) and nothing more.
 *
 * In a room the reply has to be posted to be heard, so when the request offers
 * `post_to_room` and names the room it was triggered from, the first completion
 * is a call to that tool carrying the canned reply, and the completion after
 * the tool's result ends the turn. The post goes through the real capability,
 * so a browser test sees the same message a person would.
 *
 * @module services/runtimes/test-mode/fake-inference
 */
import { Router, type Request, type Response } from 'express';
import { env } from '../../../env.js';
import { FAKE_CLOUD_MODEL } from './fake-cloud-v1.js';

/** The canned reply every completion streams, in two chunks. */
export const FAKE_INFERENCE_REPLY = ['Hi! I can ', 'build that for you.'] as const;
/** The room-posting tool's name, as DorkOS offers it to the model. */
const POST_TO_ROOM = 'post_to_room';

/** Where a room turn's context names its own room. */
const ROOM_ID_IN_CONTEXT = /this room is ([0-9A-HJKMNP-TV-Z]{26})/;

/** What a completion request carries that the fake reads. */
interface CompletionBody {
  model?: unknown;
  messages?: Array<{ role?: unknown; content?: unknown }>;
  tools?: Array<{ function?: { name?: unknown } }>;
}

/**
 * The room this completion should post its reply in: the request offers
 * `post_to_room`, names its room, and this turn has not had a tool result back
 * yet.
 * `null` everywhere else, which streams the reply as plain text.
 *
 * @param body - The completion request.
 */
export function roomToPostIn(body: CompletionBody): string | null {
  const offersPost = body.tools?.some((tool) => tool.function?.name === POST_TO_ROOM) ?? false;
  const messages = body.messages ?? [];
  // Only this turn counts: a chat that already posted once carries that call
  // and its result in its history.
  const lastAsk = messages.map((message) => message.role).lastIndexOf('user');
  if (!offersPost || messages.slice(lastAsk + 1).some((message) => message.role === 'tool')) {
    return null;
  }
  for (const message of messages) {
    const text =
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    const match = ROOM_ID_IN_CONTEXT.exec(text ?? '');
    if (match) return match[1];
  }
  return null;
}

/** The usage the fake reports for every completion. */
const FAKE_USAGE = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } as const;

/**
 * Build the fake inference router.
 *
 * @throws If called outside `DORKOS_TEST_RUNTIME` — the fake must be
 *   unreachable in production (structural gate + this runtime guard + tests).
 */
export function createFakeInferenceRouter(): Router {
  if (!env.DORKOS_TEST_RUNTIME) {
    throw new Error('createFakeInferenceRouter is test-mode only (DORKOS_TEST_RUNTIME)');
  }
  const router = Router();

  router.get('/v1/models', (_req: Request, res: Response) => {
    res.json({
      object: 'list',
      data: [{ id: FAKE_CLOUD_MODEL.id, object: 'model', created: 0, owned_by: 'dorkos' }],
    });
  });

  router.post('/v1/chat/completions', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as CompletionBody;
    const model = typeof body.model === 'string' ? body.model : FAKE_CLOUD_MODEL.id;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (
      delta: Record<string, unknown>,
      finishReason: string | null = null,
      usage?: typeof FAKE_USAGE
    ) =>
      res.write(
        `data: ${JSON.stringify({
          id: 'fake-completion',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(usage ? { usage } : {}),
        })}\n\n`
      );
    chunk({ role: 'assistant' });
    const roomId = roomToPostIn(body);
    if (roomId !== null) {
      const args = JSON.stringify({ roomId, text: FAKE_INFERENCE_REPLY.join('') });
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'fake-post',
            type: 'function',
            function: { name: POST_TO_ROOM, arguments: args },
          },
        ],
      });
      chunk({}, 'tool_calls', FAKE_USAGE);
    } else {
      for (const content of FAKE_INFERENCE_REPLY) chunk({ content });
      chunk({}, 'stop', FAKE_USAGE);
    }
    res.end('data: [DONE]\n\n');
  });

  return router;
}
