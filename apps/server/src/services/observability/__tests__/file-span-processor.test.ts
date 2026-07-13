import { describe, it, expect } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { sanitizeSpan } from '../file-span-processor.js';
import { ATTR } from '../attributes.js';

/**
 * Build a ReadableSpan-shaped object for sanitizer tests. Only the fields
 * {@link sanitizeSpan} reads are populated.
 */
function fakeSpan(overrides: {
  name?: string;
  attributes?: Record<string, unknown>;
  statusCode?: number;
  statusMessage?: string;
  parentSpanId?: string;
  events?: unknown[];
}): ReadableSpan {
  return {
    name: overrides.name ?? 'session.turn',
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
    parentSpanContext: overrides.parentSpanId ? { spanId: overrides.parentSpanId } : undefined,
    startTime: [1_700_000_000, 0],
    duration: [1, 500_000_000], // 1.5s
    status: { code: overrides.statusCode ?? 0, message: overrides.statusMessage },
    attributes: overrides.attributes ?? {},
    events: overrides.events ?? [],
    links: [],
  } as unknown as ReadableSpan;
}

describe('sanitizeSpan — no-PII allowlist', () => {
  it('keeps only allowlisted attribute keys and drops everything else', () => {
    const span = fakeSpan({
      attributes: {
        // allowlisted — kept
        [ATTR.RUNTIME]: 'claude-code',
        [ATTR.SESSION_ID]: 'sess-123',
        [ATTR.EVENT_COUNT]: 42,
        // allowlisted gen_ai metadata — kept (Phase 7): a token COUNT is not content
        [ATTR.GEN_AI_USAGE_INPUT_TOKENS]: 1234,
        // NOT allowlisted — must be dropped (these represent PII/secrets/content)
        prompt: 'write my AWS key please',
        'file.path': '/Users/dorian/secret/project',
        // A content-shaped gen_ai key (a prompt/completion) has NO allowlist entry
        // and must still be dropped — only the coarse counts/model are permitted.
        'gen_ai.prompt': 'summarize /Users/dorian/secret.txt',
        hostname: 'dorians-macbook.local',
        username: 'dorian',
        apiKey: 'sk-ant-supersecret',
      },
    });

    const out = sanitizeSpan(span);

    expect(out.attributes).toEqual({
      [ATTR.RUNTIME]: 'claude-code',
      [ATTR.SESSION_ID]: 'sess-123',
      [ATTR.EVENT_COUNT]: 42,
      [ATTR.GEN_AI_USAGE_INPUT_TOKENS]: 1234,
    });
    // None of the sensitive values survive anywhere in the serialized span.
    const serialized = JSON.stringify(out);
    for (const secret of [
      'AWS key',
      '/Users/dorian',
      'gen_ai.prompt',
      'secret.txt',
      'macbook',
      'dorian',
      'sk-ant',
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('drops non-primitive allowlisted values', () => {
    const span = fakeSpan({
      attributes: { [ATTR.RUNTIME]: { nested: 'object' } as unknown as string },
    });
    expect(sanitizeSpan(span).attributes).toEqual({});
  });

  it('records the status code only, never the status message (may hold PII)', () => {
    const span = fakeSpan({
      statusCode: 2,
      statusMessage: 'ENOENT: /Users/dorian/.ssh/id_rsa not found',
    });
    const out = sanitizeSpan(span);
    expect(out.status).toBe('error');
    expect(JSON.stringify(out)).not.toContain('id_rsa');
    expect(JSON.stringify(out)).not.toContain('/Users/dorian');
  });

  it('never carries span events (a common PII leak vector)', () => {
    const span = fakeSpan({
      events: [{ name: 'exception', attributes: { 'exception.message': '/secret/path leaked' } }],
    });
    const out = sanitizeSpan(span) as Record<string, unknown>;
    expect(out.events).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('secret/path');
  });

  it('preserves the static name, ids, timing, and parent link', () => {
    const out = sanitizeSpan(fakeSpan({ name: 'task.run', parentSpanId: 'c'.repeat(16) }));
    expect(out.name).toBe('task.run');
    expect(out.traceId).toBe('a'.repeat(32));
    expect(out.spanId).toBe('b'.repeat(16));
    expect(out.parentSpanId).toBe('c'.repeat(16));
    expect(out.durationMs).toBe(1500);
    expect(out.status).toBe('unset');
  });
});
