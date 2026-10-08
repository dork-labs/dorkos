import { afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompaction } from '../compaction.js';
import { SqliteModelStore } from '../store.js';
import { DeferredToolRegistry } from '../registry/registry.js';
import type { DoeConfig, DoeEvent, ModelMessage } from '../contracts.js';
import type { EngineFactory, EngineRequest } from '../engine.js';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
export function compactionFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'doe-compact-'));
  let store = new SqliteModelStore(join(dir, 'history.sqlite'));
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.createSession('business');
  const events: DoeEvent[] = [];
  const requests: EngineRequest[] = [];
  let stop: 'stop' | 'error' | 'aborted' | 'length' = 'stop';
  let serial = 0;
  let summaryText = 'Business outcome: sale completed. Open promise: follow up Friday.';
  let summarySuffix = '';
  const config: DoeConfig = {
    sessionId: 'business',
    workingDirectory: dir,
    model: {
      protocol: 'openai-completions',
      endpoint: 'http://localhost:1/v1',
      id: 'local',
      contextWindow: 10000,
      maxOutputTokens: 100,
      payer: 'host',
      historyFamily: 'chat',
      requiresCredentials: false,
      credentials: async () => undefined,
    },
    store,
    registry: new DeferredToolRegistry(),
    resources: {
      load: async () => 'CURRENT-RESOURCE',
      beforeFile: async () => '',
      skills: async () => [],
      loadSkill: async () => '',
    },
    pathPolicy: { readRoots: [], writeRoots: [] },
    onEvent: (e) => events.push(e),
    extensions: createCompaction({ reserveTokens: 500, retainTurns: 1 }),
  };
  const factory: EngineFactory = () => ({
    run: async (r) => {
      requests.push(r);
      const prepared = await r.prepareRequest?.(r.messages, r.signal);
      if (r.purpose === 'summary') {
        await r.onUsage({ requestId: `summary-${++serial}`, inputTokens: 30, outputTokens: 4 });
        const m: ModelMessage = {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: summaryText,
            },
            ...(summarySuffix ? [{ type: 'text', text: summarySuffix }] : []),
          ],
          timestamp: 1,
        };
        await r.onMessage(m);
        return { messages: [m], scope: r.context.scope, stopReason: stop };
      }
      await r.onUsage({ requestId: `run-${++serial}`, inputTokens: 300, outputTokens: 4 });
      const m: ModelMessage = { role: 'assistant', content: [{ type: 'text', text: 'finished' }] };
      await r.onMessage(m);
      return {
        messages: [m, ...(prepared?.messages ?? [])],
        scope: r.context.scope,
        stopReason: 'stop',
      };
    },
    steer: () => 'idle',
    followUp: () => 'idle',
    abort: () => {},
  });
  function seed() {
    store.appendMessage('business', {
      role: 'system',
      content: 'KEEP-INSTRUCTION',
      sections: { doe: 'OLD-RESOURCE', other: 'OTHER-CURRENT' },
      timestamp: 1,
    });
    for (let n = 1; n <= 3; n++) {
      store.appendMessage('business', {
        role: 'user',
        content: `turn${n} ` + 'x'.repeat(4000),
        timestamp: n,
      });
      store.appendMessage('business', {
        role: 'assistant',
        content: [{ type: 'text', text: `answer${n}` }],
        timestamp: n,
      });
    }
  }
  return {
    config,
    events,
    requests,
    factory,
    seed,
    get store() {
      return store;
    },
    setSummarySuffix: (value: string) => {
      summarySuffix = value;
    },
    setSummaryText: (value: string) => {
      summaryText = value;
    },
    setStop: (value: typeof stop) => {
      stop = value;
    },
    reopen: () => {
      store.close();
      store = new SqliteModelStore(join(dir, 'history.sqlite'));
      config.store = store;
    },
  };
}
