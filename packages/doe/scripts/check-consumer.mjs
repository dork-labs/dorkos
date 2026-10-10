import process from 'node:process';
import console from 'node:console';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { URL, fileURLToPath } from 'node:url';
import { Doe, SqliteModelStore, DeferredToolRegistry } from '@dorkos/doe';
import { protocolFixture } from './protocol-fixture.ts';

const originalFetch = globalThis.fetch;
let allowedOrigin;
globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  );
  assert.equal(url.origin, allowedOrigin, 'Packed model request escaped the explicit fixture');
  return originalFetch(input, init);
};
try {
  for (const protocol of ['anthropic-messages', 'openai-completions', 'openai-responses']) {
    const fixture = await protocolFixture(protocol, { tool: 'approved', thinking: true });
    allowedOrigin = new URL(fixture.endpoint).origin;
    const store = new SqliteModelStore(':memory:');
    const registry = new DeferredToolRegistry();
    registry.register({
      name: 'approved',
      description: 'Explicit fixture tool',
      initialLoad: true,
      schema: { type: 'object', properties: {} },
      execute: async () => ({ content: [{ type: 'text', text: 'fixture result' }] }),
    });
    const events = [];
    try {
      const doe = new Doe({
        sessionId: 'packed',
        workingDirectory: process.cwd(),
        pathPolicy: { readRoots: [], writeRoots: [] },
        store,
        registry,
        resources: {
          load: async () => 'fixture instructions',
          skills: async () => [],
          beforeFile: async () => '',
          loadSkill: async () => '',
        },
        model: {
          protocol,
          endpoint: fixture.endpoint,
          id: 'local',
          payer: 'fixture',
          historyFamily: protocol,
          contextWindow: 32768,
          maxOutputTokens: 1000,
          supportsThinking: true,
          credentials: async () => 'fixture-explicit-key',
        },
        approve: async () => 'allow',
        onEvent: (event) => events.push(event),
      });
      const result = await doe.run('Exercise complete local wire exchange');
      assert.equal(result.stopReason, 'stop');
      assert.equal(fixture.requests(), 2);
      assert.equal(store.allUsage('packed').length, 2);
      const archive = JSON.stringify(store.archive('packed'));
      assert.match(archive, /toolResult/);
      assert.match(archive, /thinking/);
      assert(!archive.includes('fixture-explicit-key'));
      if (protocol === 'anthropic-messages') assert.match(archive, /opaque-signature/);
      if (protocol === 'openai-completions') assert.match(archive, /reasoning_content/);
      if (protocol === 'openai-responses') assert.match(archive, /opaque-encrypted/);
      assert.equal(events.at(-1).type, 'complete');
      console.log(`${protocol}: packed SDK streaming, tools, opaque history and usage pass`);
    } finally {
      store.close();
      await fixture.close();
    }
  }
  const exampleUrl = new URL('./node_modules/@dorkos/doe/examples/local.mjs', import.meta.url);
  allowedOrigin = undefined;
  const example = await import(exampleUrl.href);
  assert.equal(typeof example.main, 'function');
  const fixture = await protocolFixture('openai-completions', {
    textChunks: ['Confirm delivery.'],
  });
  try {
    const execute = promisify(execFile);
    const result = await execute(
      process.execPath,
      [fileURLToPath(exampleUrl), fixture.endpoint, 'explicit-local'],
      {
        timeout: 10000,
        env: { OPENAI_API_KEY: 'ambient-example-secret' },
      }
    );
    assert.equal(fixture.requests(), 1);
    assert.equal(fixture.bodies[0].model, 'explicit-local');
    assert.match(result.stdout, /Confirm delivery\./);
    assert.match(result.stdout, /"inputTokens": 12/);
    assert(!result.stdout.includes('ambient-example-secret'));
    assert.equal(result.stderr, '');
    await assert.rejects(
      execute(process.execPath, [fileURLToPath(exampleUrl)], { timeout: 10000, env: {} }),
      (error) => error.code === 1 && error.stderr.includes('Usage:')
    );
    console.log(
      'Packed example: inert import, explicit local stream/usage and nonzero failure pass'
    );
  } finally {
    await fixture.close();
  }
} finally {
  globalThis.fetch = originalFetch;
}
