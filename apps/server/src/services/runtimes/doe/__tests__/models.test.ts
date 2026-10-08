import { describe, expect, it } from 'vitest';
import { Doe, SqliteModelStore, DeferredToolRegistry } from '@dorkos/doe';
import type { DoeInferenceConfig } from '@dorkos/shared/config-schema';
import { listDoeModels } from '../models.js';
import { resolveDoeInference } from '../credentials.js';
import { protocolFixture } from '../../../../../../../packages/doe/src/__tests__/protocol-fixture.js';

const config: DoeInferenceConfig = {
  source: 'local',
  provider: 'ollama',
  protocol: 'openai-chat-completions',
  endpoint: 'http://127.0.0.1:11434/v1',
  model: 'explicit-custom-model',
  contextWindow: 8192,
  maxOutputTokens: 1024,
};

describe('DorkOS model routing', () => {
  it('reports explicit local limits without inventing prices or querying another runtime', () => {
    expect(listDoeModels(null)).toEqual([]);
    const model = listDoeModels(config)[0]!;
    expect(model.contextWindow).toBe(8192);
    expect(model.maxOutputTokens).toBe(1024);
    expect(model.displayName.length).toBeLessThanOrEqual(13);
    expect(model).not.toHaveProperty('costRates');
  });
  it.each(['anthropic-messages', 'openai-chat-completions', 'openai-responses'] as const)(
    'exchanges an actual credential-free loopback request over %s',
    async (protocol) => {
      const fixture = await protocolFixture(
        protocol === 'openai-chat-completions' ? 'openai-completions' : protocol
      );
      const store = new SqliteModelStore(':memory:');
      try {
        const model = await resolveDoeInference({
          ...config,
          protocol,
          endpoint: fixture.endpoint,
        });
        const doe = new Doe({
          sessionId: 'fixture',
          workingDirectory: '/tmp',
          model,
          store,
          registry: new DeferredToolRegistry(),
          resources: {
            load: async () => '',
            beforeFile: async () => '',
            skills: async () => [],
            loadSkill: async () => '',
          },
          pathPolicy: { readRoots: [], writeRoots: [] },
        });
        const result = await doe.run('Hello');
        expect(result.stopReason).toBe('stop');
        expect(fixture.requests()).toBe(1);
        expect(fixture.bodies[0]!.model).toBe(config.model);
        expect(store.archive('fixture').some((record) => record.payload.role === 'assistant')).toBe(
          true
        );
      } finally {
        store.close();
        await fixture.close();
      }
    }
  );
});
