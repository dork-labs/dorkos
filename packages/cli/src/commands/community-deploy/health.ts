/**
 * Bounded public health proof for a deployed Community.
 *
 * @module commands/community-deploy/health
 */
import { z } from 'zod';

const HealthSchema = z.object({ status: z.literal('ok') }).passthrough();

async function readHealthBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new CommunityHealthError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) await reader.cancel();
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) {
        await reader.cancel();
        throw new CommunityHealthError();
      }
      chunks.push(value);
    }
    if (signal.aborted) throw new CommunityHealthError();
    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

/** Stable health failure without response content. */
export class CommunityHealthError extends Error {
  /** Create a secret-free health failure. */
  constructor() {
    super('Community health check did not pass');
    this.name = 'CommunityHealthError';
  }
}

/** Verify one HTTPS `/health` response within a fixed deadline. */
export async function verifyCommunityHealth(
  origin: string,
  options: { timeoutMs: number; fetch?: typeof fetch }
): Promise<void> {
  const parsed = new URL(origin);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 120_000
  ) {
    throw new CommunityHealthError();
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await (options.fetch ?? fetch)(new URL('/health', parsed), {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) throw new CommunityHealthError();
    const body = await readHealthBody(response, controller.signal);
    HealthSchema.parse(JSON.parse(body));
  } catch {
    throw new CommunityHealthError();
  } finally {
    clearTimeout(timer);
  }
}
