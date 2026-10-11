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
 * @module services/runtimes/test-mode/fake-inference
 */
import { Router, type Request, type Response } from 'express';
import { env } from '../../../env.js';
import { FAKE_CLOUD_MODEL } from './fake-cloud-v1.js';

/** The canned reply every completion streams, in two chunks. */
export const FAKE_INFERENCE_REPLY = ['Hi! I can ', 'build that for you.'] as const;
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
    const body = (req.body ?? {}) as { model?: unknown };
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
    for (const content of FAKE_INFERENCE_REPLY) chunk({ content });
    chunk({}, 'stop', FAKE_USAGE);
    res.end('data: [DONE]\n\n');
  });

  return router;
}
