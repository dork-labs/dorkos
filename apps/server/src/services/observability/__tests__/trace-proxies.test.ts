import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { RelayCore } from '@dorkos/relay';
import { traceRuntime } from '../trace-runtime.js';
import { traceRelay } from '../trace-relay.js';
import { initObservability, shutdownObservability } from '../otel.js';
import { SPAN, ATTR } from '../attributes.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-otel-'));
}

/** A minimal AgentRuntime stand-in exposing `type`, `sendMessage`, and a state method. */
function fakeRuntime(): AgentRuntime & { sendCount: number } {
  const runtime = {
    type: 'test-runtime',
    sendCount: 0,
    async *sendMessage(_sessionId: string, content: string) {
      runtime.sendCount++;
      // Echo the (potentially sensitive) content back as stream items.
      yield { type: 'text', data: content } as never;
      yield { type: 'done', data: {} } as never;
    },
    interruptQuery: async () => true,
  } as unknown as AgentRuntime & { sendCount: number };
  return runtime;
}

afterEach(async () => {
  await shutdownObservability();
});

describe('traceRuntime / traceRelay — off returns the same instance', () => {
  it('returns the identical runtime object when tracing is off', () => {
    const runtime = fakeRuntime();
    expect(traceRuntime(runtime)).toBe(runtime);
  });

  it('returns the identical relay object when tracing is off', () => {
    const relay = {
      publish: async () => ({ messageId: 'm', deliveredTo: 0 }),
    } as unknown as RelayCore;
    expect(traceRelay(relay)).toBe(relay);
  });
});

describe('traceRuntime — wraps sendMessage without leaking content', () => {
  it('proxies non-traced members through to the real runtime', async () => {
    const home = tmpHome();
    await initObservability({ debug: true, dorkHome: home, version: '1.0.0' });
    const runtime = fakeRuntime();
    const traced = traceRuntime(runtime);

    expect(traced.type).toBe('test-runtime');
    await expect(traced.interruptQuery('s1')).resolves.toBe(true);
  });

  it('records a runtime span with type + count, never the message content', async () => {
    const home = tmpHome();
    const file = await initObservability({ debug: true, dorkHome: home, version: '1.0.0' });
    const runtime = fakeRuntime();
    const traced = traceRuntime(runtime);

    const items: unknown[] = [];
    for await (const ev of traced.sendMessage('sess-42', 'leak me: /Users/dorian/.env SECRET')) {
      items.push(ev);
    }
    expect(items).toHaveLength(2); // pass-through intact
    expect(runtime.sendCount).toBe(1); // real runtime was invoked

    await shutdownObservability();

    const raw = fs.readFileSync(file!, 'utf-8');
    expect(raw).not.toContain('/Users/dorian');
    expect(raw).not.toContain('SECRET');
    const span = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((s) => s.name === SPAN.RUNTIME_SEND_MESSAGE);
    expect(span!.attributes).toMatchObject({
      [ATTR.RUNTIME]: 'test-runtime',
      [ATTR.SESSION_ID]: 'sess-42',
      [ATTR.EVENT_COUNT]: 2,
    });
  });
});

describe('traceRelay — records the dispatch shape, never the subject or payload', () => {
  it('records subject_kind + delivered_to only; the raw subject and payload never reach the file', async () => {
    const home = tmpHome();
    const file = await initObservability({ debug: true, dorkHome: home, version: '1.0.0' });

    let publishCalls = 0;
    const relay = {
      // The real publish receives the sensitive subject + payload; the proxy
      // never reads them, so they cannot reach the trace file.
      publish: async (_subject: string, _payload: unknown, _options: unknown) => {
        publishCalls++;
        return { messageId: 'msg-1', deliveredTo: 2 };
      },
    } as unknown as RelayCore;
    const traced = traceRelay(relay);

    // Subject names a sensitive target (a telegram chat id / agent id); payload
    // carries secret-looking content.
    const subject = 'relay.agent.telegram.chat-987654321';
    const payload = {
      text: 'API key sk-ant-0xdeadbeef, path /Users/dorian/.ssh/id_rsa',
      recipient: '@dorian',
    };
    const result = await traced.publish(subject, payload, { from: 'relay.agent.sender' });
    expect(result.deliveredTo).toBe(2); // pass-through intact
    expect(publishCalls).toBe(1); // real relay was invoked

    await shutdownObservability();

    const raw = fs.readFileSync(file!, 'utf-8');
    // The raw subject, the sensitive target id, and every payload secret are absent.
    for (const secret of [
      'chat-987654321',
      'telegram',
      'sk-ant',
      '/Users/dorian',
      'id_rsa',
      '@dorian',
    ]) {
      expect(raw).not.toContain(secret);
    }
    const span = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((s) => s.name === SPAN.RELAY_DISPATCH);
    // Only the coarse bucket + the delivered count survive.
    expect(span!.attributes).toEqual({
      [ATTR.SUBJECT_KIND]: 'agent',
      [ATTR.DELIVERED_TO]: 2,
    });
  });

  it('buckets a system subject as "system"', async () => {
    const home = tmpHome();
    const file = await initObservability({ debug: true, dorkHome: home, version: '1.0.0' });
    const relay = {
      publish: async () => ({ messageId: 'm', deliveredTo: 0 }),
    } as unknown as RelayCore;

    await traceRelay(relay).publish('relay.system.tasks.abc-123', { prompt: 'secret' }, {});
    await shutdownObservability();

    const raw = fs.readFileSync(file!, 'utf-8');
    expect(raw).not.toContain('abc-123');
    expect(raw).not.toContain('secret');
    const span = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((s) => s.name === SPAN.RELAY_DISPATCH);
    expect(span!.attributes).toMatchObject({ [ATTR.SUBJECT_KIND]: 'system' });
  });
});
