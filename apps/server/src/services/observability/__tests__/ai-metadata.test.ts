import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { traceRuntime } from '../trace-runtime.js';
import { initObservability, shutdownObservability } from '../otel.js';
import { SPAN, ATTR, ALLOWED_ATTRIBUTE_KEYS } from '../attributes.js';
import {
  observeRuntimeTurn,
  setAiMetadataBridge,
  isAiBridgeEnabled,
  isAiObservabilityActive,
  type AiTurnMetadata,
} from '../ai-metadata.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-ai-obs-'));
}

/**
 * A turn that streams some text, then a terminal `session_status` carrying the
 * turn metadata — AND, crucially, extra content-shaped fields (`prompt`, `path`)
 * that a hostile or buggy runtime might attach. The harvest must ignore them.
 */
async function* craftedTurn(): AsyncGenerator<StreamEvent> {
  yield { type: 'text', data: 'leak me: /Users/dorian/.env SECRET' } as unknown as StreamEvent;
  yield {
    type: 'session_status',
    data: {
      sessionId: 'sess-1',
      model: 'claude-opus-4-6',
      costUsd: 0.42,
      turnInputTokens: 1500,
      turnOutputTokens: 300,
      // Content-shaped fields that must NEVER be harvested:
      prompt: 'summarize /Users/dorian/secret.txt',
      path: '/Users/dorian/secret.txt',
    },
  } as unknown as StreamEvent;
  yield { type: 'done', data: { sessionId: 'sess-1' } } as unknown as StreamEvent;
}

async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

afterEach(async () => {
  setAiMetadataBridge(null);
  await shutdownObservability();
});

describe('ai-metadata — allowlist discipline', () => {
  it('every gen_ai attribute key is on the exported allowlist', () => {
    for (const key of [
      ATTR.GEN_AI_SYSTEM,
      ATTR.GEN_AI_RESPONSE_MODEL,
      ATTR.GEN_AI_USAGE_INPUT_TOKENS,
      ATTR.GEN_AI_USAGE_OUTPUT_TOKENS,
      ATTR.GEN_AI_COST_USD,
    ]) {
      expect(ALLOWED_ATTRIBUTE_KEYS.has(key)).toBe(true);
    }
  });
});

describe('ai-metadata — span attributes (Plane 2, tracing on)', () => {
  it('sets gen_ai.* from the turn status and never lets content into the file', async () => {
    const home = tmpHome();
    const file = await initObservability({ debug: true, dorkHome: home, version: '1.0.0' });

    await drain(observeRuntimeTurn('claude-code', 'sess-1', craftedTurn()));
    await shutdownObservability();

    const raw = fs.readFileSync(file!, 'utf-8');
    // No content leaked — not the path, not the "SECRET", not the crafted prompt.
    for (const secret of ['/Users/dorian', 'SECRET', 'secret.txt', 'summarize']) {
      expect(raw).not.toContain(secret);
    }

    const span = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((s) => s.name === SPAN.RUNTIME_SEND_MESSAGE)!;
    const attrs = span.attributes as Record<string, unknown>;
    expect(attrs).toMatchObject({
      [ATTR.RUNTIME]: 'claude-code',
      [ATTR.SESSION_ID]: 'sess-1',
      [ATTR.EVENT_COUNT]: 3,
      [ATTR.GEN_AI_SYSTEM]: 'claude-code',
      [ATTR.GEN_AI_RESPONSE_MODEL]: 'claude-opus-4-6',
      [ATTR.GEN_AI_USAGE_INPUT_TOKENS]: 1500,
      [ATTR.GEN_AI_USAGE_OUTPUT_TOKENS]: 300,
      [ATTR.GEN_AI_COST_USD]: 0.42,
    });
    // Every attribute key that reached the span is allowlisted (no content key).
    for (const key of Object.keys(attrs)) {
      expect(ALLOWED_ATTRIBUTE_KEYS.has(key)).toBe(true);
    }
  });
});

describe('ai-metadata — the opt-in bridge (Plane 1 Tier 2)', () => {
  it('is OFF by default: no bridge installed → observability inactive, nothing emitted', async () => {
    expect(isAiBridgeEnabled()).toBe(false);
    expect(isAiObservabilityActive()).toBe(false);

    // With nothing active, traceRuntime returns the identical runtime (zero overhead).
    const runtime = {
      type: 'claude-code',
      async *sendMessage() {
        /* no-op */
      },
    } as unknown as AgentRuntime;
    expect(traceRuntime(runtime)).toBe(runtime);
  });

  it('emits exactly one metadata object per turn, with ONLY allowlisted fields', async () => {
    const seen: AiTurnMetadata[] = [];
    setAiMetadataBridge((m) => seen.push(m));
    expect(isAiBridgeEnabled()).toBe(true);
    expect(isAiObservabilityActive()).toBe(true);

    await drain(observeRuntimeTurn('claude-code', 'sess-1', craftedTurn()));

    expect(seen).toHaveLength(1);
    const meta = seen[0];
    expect(meta.runtime).toBe('claude-code');
    expect(meta.model).toBe('claude-opus-4-6');
    expect(meta.inputTokens).toBe(1500);
    expect(meta.outputTokens).toBe(300);
    expect(meta.costUsd).toBe(0.42);
    expect(typeof meta.latencyMs).toBe('number');
    expect(meta.latencyMs).toBeGreaterThanOrEqual(0);

    // The harvested object carries ONLY the known metadata keys — no content
    // field (prompt/path) from the crafted status event can appear.
    expect(Object.keys(meta).sort()).toEqual(
      ['costUsd', 'inputTokens', 'latencyMs', 'model', 'outputTokens', 'runtime'].sort()
    );
    const serialized = JSON.stringify(meta);
    for (const secret of ['/Users/dorian', 'secret.txt', 'summarize', 'SECRET']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('omits unknown fields when the runtime reports no model/tokens/cost', async () => {
    const seen: AiTurnMetadata[] = [];
    setAiMetadataBridge((m) => seen.push(m));

    async function* sparseTurn(): AsyncGenerator<StreamEvent> {
      yield { type: 'done', data: { sessionId: 's' } } as unknown as StreamEvent;
    }
    await drain(observeRuntimeTurn('codex', 's', sparseTurn()));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ runtime: 'codex', latencyMs: expect.any(Number) });
  });

  it('still fires the bridge on a thrown turn (finally path), then re-throws', async () => {
    const seen: AiTurnMetadata[] = [];
    setAiMetadataBridge((m) => seen.push(m));

    async function* throwingTurn(): AsyncGenerator<StreamEvent> {
      yield {
        type: 'session_status',
        data: { sessionId: 's', model: 'm', turnInputTokens: 10, turnOutputTokens: 2 },
      } as unknown as StreamEvent;
      throw new Error('boom');
    }

    await expect(drain(observeRuntimeTurn('claude-code', 's', throwingTurn()))).rejects.toThrow(
      'boom'
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].inputTokens).toBe(10);
  });
});
