import { compactionFixture as fixture } from './compaction-fixture.js';
import Database from 'better-sqlite3';
import { estimateInput, systemFingerprint } from '../context-estimation.js';
import { businessPrompt } from '../prompt.js';
import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { Doe } from '../doe.js';
import { createCompaction } from '../compaction.js';
import { protocolFixture } from './protocol-fixture.js';
import type { ModelMessage } from '../contracts.js';
import type { EngineFactory } from '../engine.js';
it('manual checkpoint retains complete recent turns, current instructions/schemas, original archive and repeat/reopen state', async () => {
  const f = fixture();
  f.seed();
  f.config.registry.register({
    name: 'current',
    description: 'CURRENT-SCHEMA',
    initialLoad: true,
    schema: { type: 'object', properties: {} },
    execute: async () => ({ content: [] }),
  });
  const archive = f.store.archive('business');
  await new Doe(f.config, f.factory).compact();
  const first = f.store.restore('business');
  expect(first.checkpoint).toBeDefined();
  expect(JSON.stringify(first.messages)).toContain('CURRENT-RESOURCE');
  expect(JSON.stringify(first.messages)).toContain('CURRENT-SCHEMA');
  expect(JSON.stringify(first.messages)).toContain('OTHER-CURRENT');
  expect(JSON.stringify(first.messages)).toContain('KEEP-INSTRUCTION');
  expect(first.messages.some((r) => JSON.stringify(r.payload).includes('turn3'))).toBe(true);
  expect(first.messages.some((r) => JSON.stringify(r.payload).includes('turn1'))).toBe(false);
  expect(f.store.archive('business')).toEqual(archive);
  f.reopen();
  expect(f.store.restore('business')).toEqual(first);
  f.store.appendMessage('business', { role: 'user', content: 'fourth', timestamp: 4 });
  f.store.appendMessage('business', {
    role: 'assistant',
    content: [{ type: 'text', text: 'fourth answer' }],
  });
  await new Doe(f.config, f.factory).compact();
  expect(f.store.restore('business').checkpoint!.seq).toBeGreaterThan(first.checkpoint!.seq);
  expect(JSON.stringify(f.requests.filter((r) => r.purpose === 'summary')[1]!.messages)).toContain(
    'sale completed'
  );
  expect(f.store.archive('business')).toHaveLength(archive.length + 2);
  expect(f.events.filter((e) => e.type === 'compaction-start')).toHaveLength(2);
  expect(
    f.events.filter((e) => e.type === 'compaction-end' && e.outcome === 'completed')
  ).toHaveLength(2);
  expect(f.store.allUsage('business').filter((u) => u.usage.purpose === 'summary')).toHaveLength(2);
});
for (const stop of ['error', 'aborted', 'length'] as const)
  it(`${stop} summary retains usage but never advances checkpoint or emits successful boundary`, async () => {
    const f = fixture();
    f.seed();
    await new Doe(f.config, f.factory).compact();
    const before = f.store.restore('business');
    f.store.appendMessage('business', { role: 'user', content: 'next' });
    f.store.appendMessage('business', {
      role: 'assistant',
      content: [{ type: 'text', text: 'next answer' }],
    });
    const original = f.store.restore('business');
    f.setStop(stop);
    f.events.length = 0;
    await expect(new Doe(f.config, f.factory).compact()).rejects.toThrow('summary');
    expect(f.store.restore('business')).toEqual(original);
    expect(f.store.restore('business').checkpoint).toEqual(before.checkpoint);
    expect(f.store.allUsage('business').filter((u) => u.usage.purpose === 'summary')).toHaveLength(
      2
    );
    expect(f.events.filter((e) => e.type === 'compaction-end')).toHaveLength(1);
    expect(f.events.some((e) => e.type === 'compaction-end' && e.outcome === 'completed')).toBe(
      false
    );
  });
it('checkpoint failure preserves context and real summary usage, with one failed lifecycle end', async () => {
  const f = fixture();
  f.seed();
  const before = f.store.restore('business');
  const database = new Database(join(f.config.workingDirectory, 'history.sqlite'));
  database.exec(
    "CREATE TRIGGER refuse_checkpoint BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(ABORT, 'checkpoint disk failure'); END"
  );
  database.close();
  await expect(new Doe(f.config, f.factory).compact()).rejects.toThrow('checkpoint disk failure');
  expect(f.store.restore('business')).toEqual(before);
  expect(f.store.allUsage('business').filter((u) => u.usage.purpose === 'summary')).toHaveLength(1);
  expect(f.events.filter((e) => e.type === 'compaction-end')).toHaveLength(1);
  expect(f.events.some((e) => e.type === 'compaction-end' && e.outcome === 'completed')).toBe(
    false
  );
});
it('automatic path uses the same checkpoint and honest provider/trailing estimate labels, invalidating old usage after checkpoint', async () => {
  const f = fixture();
  f.seed();
  f.config.model.contextWindow = 2400;
  await new Doe(f.config, f.factory).run('new current turn');
  const first = f.store.restore('business').checkpoint!;
  expect(first).toBeDefined();
  expect(first.before.source).toBe('estimated');
  expect(first.after.source).toBe('estimated');
  f.config.model.contextWindow = 10000;
  await new Doe(f.config, f.factory).run('small trailing');
  await new Doe(f.config, f.factory).compact();
  const second = f.store.restore('business').checkpoint!;
  expect(second.before.providerTokens).toBe(300);
  expect(second.before.estimatedTokens).toBeGreaterThan(0);
  expect(second.before.source).toBe('estimated');
  f.store.appendMessage('business', { role: 'user', content: 'fresh context' });
  f.store.appendMessage('business', {
    role: 'assistant',
    content: [{ type: 'text', text: 'fresh answer' }],
  });
  await new Doe(f.config, f.factory).compact();
  expect(f.store.restore('business').checkpoint!.before.providerTokens).toBeUndefined();
});
it('cut point moves backward for a tool call/result crossing a user boundary, keeping no orphaned exchange', async () => {
  const f = fixture();
  f.seed();
  f.store.appendMessage('business', {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'call', name: 'echo', arguments: {} }],
  });
  f.store.appendMessage('business', { role: 'user', content: 'steering' });
  f.store.appendMessage('business', {
    role: 'toolResult',
    toolCallId: 'call',
    toolName: 'echo',
    content: [{ type: 'text', text: 'result' }],
    isError: false,
  });
  f.store.appendMessage('business', {
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
  });
  await new Doe(f.config, f.factory).compact();
  const restored = JSON.stringify(f.store.restore('business').messages);
  expect(restored).toContain('toolCall');
  expect(restored).toContain('toolResult');
  expect(restored).toContain('turn3');
});
it('low context refuses impossible compaction without calling a model or advancing a checkpoint', async () => {
  const f = fixture();
  f.config.model.contextWindow = 100;
  f.config.extensions = createCompaction({ reserveTokens: 50, retainTurns: 1 });
  await expect(new Doe(f.config, f.factory).run('only current turn')).rejects.toThrow('context');
  expect(f.requests.filter((r) => r.purpose === 'summary')).toHaveLength(0);
  expect(f.store.restore('business').checkpoint).toBeUndefined();
  expect(f.events.some((e) => e.type === 'compaction-end' && e.outcome === 'completed')).toBe(
    false
  );
});
it('another session remains runnable while summary work is pending, and abort leaves context unchanged', async () => {
  const f = fixture();
  f.seed();
  let entered = false;
  const factory: EngineFactory = () => ({
    run: async (r) => {
      if (r.purpose === 'summary') {
        entered = true;
        await new Promise<void>((_resolve, reject) =>
          r.signal.addEventListener('abort', () => reject(r.signal.reason), { once: true })
        );
      }
      return { messages: [], scope: r.context.scope, stopReason: 'stop' };
    },
    steer: () => 'idle',
    followUp: () => 'idle',
    abort: () => {},
  });
  const doe = new Doe(f.config, factory);
  const before = f.store.restore('business');
  const pending = doe.compact().catch((e) => e);
  await vi.waitFor(() => expect(entered).toBe(true));
  await new Doe({ ...f.config, sessionId: 'other', extensions: undefined }, factory).run('hello');
  doe.abort();
  await pending;
  expect(f.store.restore('business')).toEqual(before);
  expect(f.events.filter((e) => e.type === 'compaction-end')).toHaveLength(1);
  expect(f.events.some((e) => e.type === 'compaction-end' && e.outcome === 'completed')).toBe(
    false
  );
});
it('late retained stale system/schema deltas cannot override current snapshot on real wire after reopen', async () => {
  const f = fixture();
  f.seed();
  f.store.appendMessage('business', {
    role: 'system',
    content: '',
    sections: { doe: 'LATE-STALE' },
    toolsAdded: [
      {
        name: 'stale',
        description: 'STALE-SCHEMA',
        parameters: { type: 'object', properties: {} },
      },
    ],
    timestamp: 4,
  });
  f.config.registry.register({
    name: 'current',
    description: 'CURRENT-SCHEMA',
    initialLoad: true,
    schema: { type: 'object', properties: {} },
    execute: async () => ({ content: [] }),
  });
  await new Doe(f.config, f.factory).compact();
  f.reopen();
  const wire = await protocolFixture('openai-completions');
  try {
    f.config.model.endpoint = wire.endpoint;
    await new Doe(f.config).run('check');
    expect(JSON.stringify(wire.bodies[0])).toContain('CURRENT-RESOURCE');
    expect(JSON.stringify(wire.bodies[0])).not.toContain('LATE-STALE');
    expect(JSON.stringify(wire.bodies[0])).not.toContain('STALE-SCHEMA');
    expect(JSON.stringify(wire.bodies[0])).toContain('CURRENT-SCHEMA');
  } finally {
    await wire.close();
  }
});

it('reused call IDs retain every crossing call/result group', async () => {
  const f = fixture();
  f.seed();
  const append = (message: ModelMessage) => f.store.appendMessage('business', message);
  append({
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'duplicate', name: 'old-call', arguments: {} }],
  });
  append({ role: 'user', content: 'steering' });
  append({
    role: 'toolResult',
    toolCallId: 'duplicate',
    content: [{ type: 'text', text: 'old-result' }],
  });
  append({
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'duplicate', name: 'new-call', arguments: {} }],
  });
  append({
    role: 'toolResult',
    toolCallId: 'duplicate',
    content: [{ type: 'text', text: 'new-result' }],
  });
  append({ role: 'assistant', content: [{ type: 'text', text: 'finished' }] });
  await new Doe(f.config, f.factory).compact();
  expect(JSON.stringify(f.store.restore('business').messages)).toContain('old-call');
  expect(JSON.stringify(f.store.restore('business').messages)).toContain('new-call');
});
it('pure provider baseline is marked provider, while changed instructions/schemas are explicit estimated growth', async () => {
  const f = fixture();
  f.seed();
  const records = f.store.restore('business').messages;
  f.store.recordUsage('business', {
    requestId: 'measured',
    inputTokens: 600,
    contextMessageSeq: records.at(-1)!.seq,
    contextCheckpointSeq: 0,
    contextSystemHash: systemFingerprint(
      businessPrompt(f.config.profile, 'CURRENT-RESOURCE'),
      f.config.registry.selected(),
      records.map((r) => r.payload)
    ),
    contextEstimateTokens: estimateInput(
      businessPrompt(f.config.profile, 'CURRENT-RESOURCE'),
      f.config.registry.selected(),
      records.map((r) => r.payload)
    ).tokens,
  });
  await new Doe(f.config, f.factory).compact();
  expect(f.store.restore('business').checkpoint!.before).toMatchObject({
    source: 'provider',
    tokens: 600,
    providerTokens: 600,
    estimatedTokens: 0,
  });
  f.store.appendMessage('business', { role: 'user', content: 'new' });
  f.store.appendMessage('business', {
    role: 'assistant',
    content: [{ type: 'text', text: 'answer' }],
  });
  const fresh = f.store.restore('business').messages;
  f.store.recordUsage('business', {
    requestId: 'measured-again',
    inputTokens: 600,
    contextMessageSeq: fresh.filter((r) => r.seq > 0).at(-1)!.seq,
    contextCheckpointSeq: f.store.restore('business').checkpoint!.seq,
    contextSystemHash: systemFingerprint(
      businessPrompt(f.config.profile, 'CURRENT-RESOURCE'),
      f.config.registry.selected(),
      fresh.map((r) => r.payload)
    ),
    contextEstimateTokens: estimateInput(
      businessPrompt(f.config.profile, 'CURRENT-RESOURCE'),
      f.config.registry.selected(),
      fresh.map((r) => r.payload)
    ).tokens,
  });
  f.config.resources.load = async () => 'CURRENT-RESOURCE' + ' UPDATED-INSTRUCTION'.repeat(30);
  f.config.registry.register({
    name: 'new_schema',
    description: 'New schema',
    initialLoad: true,
    schema: { type: 'object', properties: { value: { type: 'string' } } },
    execute: async () => ({ content: [] }),
  });
  await new Doe(f.config, f.factory).compact();
  expect(f.store.restore('business').checkpoint!.before.providerTokens).toBe(600);
  expect(f.store.restore('business').checkpoint!.before.estimatedTokens).toBeGreaterThan(0);
  expect(f.store.restore('business').checkpoint!.before.source).toBe('estimated');
});
it('manual and automatic share the same cut point and before/after counts for identical input', async () => {
  const manual = fixture(),
    automatic = fixture();
  manual.seed();
  automatic.seed();
  manual.config.model.contextWindow = 2400;
  automatic.config.model.contextWindow = 2400;
  const input: ModelMessage = { role: 'user', content: 'current', timestamp: 7 };
  manual.store.appendMessage('business', input);
  await new Doe(manual.config, manual.factory).compact();
  await new Doe(automatic.config, automatic.factory).run(input);
  const a = manual.store.restore('business').checkpoint!,
    b = automatic.store.restore('business').checkpoint!;
  expect(a.firstRetainedSeq).toBe(b.firstRetainedSeq);
  expect(a.before).toEqual(b.before);
  expect(a.after).toEqual(b.after);
});

for (const text of ['', 'oversized '.repeat(800)])
  it(`refuses ${text ? 'oversized' : 'empty'} summaries while retaining real call usage`, async () => {
    const f = fixture();
    f.seed();
    f.config.model.contextWindow = 2000;
    f.setSummaryText(text);
    const before = f.store.restore('business');
    await expect(new Doe(f.config, f.factory).compact()).rejects.toThrow(
      text ? 'context limit' : 'empty'
    );
    expect(f.store.restore('business')).toEqual(before);
    expect(
      f.store.allUsage('business').filter((item) => item.usage.purpose === 'summary')
    ).toHaveLength(1);
    const end = f.events.find((e) => e.type === 'compaction-end');
    expect(end).toMatchObject({ outcome: 'failed' });
    expect(end).not.toHaveProperty('before');
    expect(end).not.toHaveProperty('after');
  });
it('equal-sized changed instructions invalidate a pure-provider label', async () => {
  const f = fixture();
  f.seed();
  const records = f.store.restore('business').messages;
  const prompt = businessPrompt(f.config.profile, 'CURRENT-RESOURCE');
  f.store.recordUsage('business', {
    requestId: 'reported',
    inputTokens: 600,
    contextMessageSeq: records.at(-1)!.seq,
    contextCheckpointSeq: 0,
    contextEstimateTokens: estimateInput(
      prompt,
      f.config.registry.selected(),
      records.map((r) => r.payload)
    ).tokens,
    contextSystemHash: systemFingerprint(
      prompt,
      f.config.registry.selected(),
      records.map((r) => r.payload)
    ),
  });
  f.config.resources.load = async () => 'CHANGED-RESOURCE';
  await new Doe(f.config, f.factory).compact();
  expect(f.store.restore('business').checkpoint!.before.source).toBe('estimated');
  expect(f.store.restore('business').checkpoint!.before.providerTokens).toBe(600);
});

it('preserves all text blocks in the final business summary', async () => {
  const f = fixture();
  f.seed();
  f.setSummaryText('Decision: accept the offer.');
  f.setSummarySuffix('Promise: send the invoice Friday.');
  await new Doe(f.config, f.factory).compact();
  const summary = f.store.restore('business').checkpoint!.summary;
  expect(JSON.stringify(summary)).toContain('Decision: accept the offer.');
  expect(JSON.stringify(summary)).toContain('Promise: send the invoice Friday.');
});

it('refuses before model work when indispensable older system instructions already exceed the context limit', async () => {
  const f = fixture();
  f.store.appendMessage('business', {
    role: 'system',
    content: 'indispensable instruction '.repeat(500),
    timestamp: 4,
  });
  f.seed();
  f.config.model.contextWindow = 2000;
  await expect(new Doe(f.config, f.factory).compact()).rejects.toThrow('context limit');
  expect(f.requests.filter((r) => r.purpose === 'summary')).toHaveLength(0);
  expect(f.store.restore('business').checkpoint).toBeUndefined();
});

it('invalid orphan results fail within one start/end lifecycle and never write a checkpoint', async () => {
  const f = fixture();
  f.seed();
  f.store.appendMessage('business', {
    role: 'toolResult',
    toolCallId: 'missing-call',
    content: [{ type: 'text', text: 'orphan' }],
  });
  await expect(new Doe(f.config, f.factory).compact()).rejects.toThrow('orphan');
  expect(f.events.filter((e) => e.type === 'compaction-start')).toHaveLength(1);
  expect(f.events.filter((e) => e.type === 'compaction-end')).toHaveLength(1);
  expect(f.store.restore('business').checkpoint).toBeUndefined();
});

it('snapshot replay preserves one copy of plain instructions across repeated compaction and later system updates', async () => {
  const f = fixture();
  f.seed();
  const append = (message: ModelMessage) => f.store.appendMessage('business', message);
  append({
    role: 'system',
    content: 'RETAINED-BODY',
    sections: { other: 'original' },
    timestamp: 4,
  });
  const originals = f.store.archive('business');
  await new Doe(f.config, f.factory).compact();
  f.reopen();
  for (let n = 0; n < 3; n++) {
    append({ role: 'user', content: `recent-${n}`, timestamp: n });
    append({ role: 'assistant', content: [{ type: 'text', text: 'finished' }] });
    await new Doe(f.config, f.factory).compact();
    f.reopen();
  }
  append({
    role: 'system',
    content: 'NEW-AFTER-CHECKPOINT',
    sections: { other: 'updated' },
    timestamp: 9,
  });
  const wire = await protocolFixture('openai-completions');
  try {
    f.config.model.endpoint = wire.endpoint;
    await new Doe(f.config).run('check');
    const messages = wire.bodies[0]!.messages as Array<{ role: string; content: string }>;
    const system = messages.find(
      (message) => message.role === 'developer' || message.role === 'system'
    )!.content;
    expect(system.match(/KEEP-INSTRUCTION/g)).toHaveLength(1);
    expect(system.match(/RETAINED-BODY/g)).toHaveLength(1);
    expect(system.match(/NEW-AFTER-CHECKPOINT/g)).toHaveLength(1);
    expect(system).toContain('updated');
    expect(system).not.toContain('original');
    expect(f.store.archive('business').slice(0, originals.length)).toEqual(originals);
  } finally {
    await wire.close();
  }
});

it('retains valid array text system instructions through checkpoint and real model request', async () => {
  const f = fixture();
  f.store.appendMessage('business', {
    role: 'system',
    content: [
      { type: 'text', text: 'KEEP-ARRAY-RULE' },
      { type: 'text', text: 'SECOND-ARRAY-RULE' },
    ],
    timestamp: 0,
  });
  f.seed();
  const originals = f.store.archive('business');
  await new Doe(f.config, f.factory).compact();
  f.reopen();
  const wire = await protocolFixture('openai-completions');
  try {
    f.config.model.endpoint = wire.endpoint;
    await new Doe(f.config).run('check');
    expect(JSON.stringify(wire.bodies[0])).toContain('KEEP-ARRAY-RULE');
    expect(JSON.stringify(wire.bodies[0])).toContain('SECOND-ARRAY-RULE');
    expect(f.store.archive('business').slice(0, originals.length)).toEqual(originals);
  } finally {
    await wire.close();
  }
});

it('actual offline summary request records provider usage in its isolated scope without polluting main archive', async () => {
  const f = fixture();
  f.seed();
  const original = f.store.archive('business');
  const wire = await protocolFixture('openai-completions');
  try {
    f.config.model.endpoint = wire.endpoint;
    await new Doe(f.config).compact();
    expect(wire.requests()).toBe(1);
    const usage = f.store.allUsage('business');
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      scope: expect.stringMatching(/^summary:/),
      usage: { inputTokens: 12, outputTokens: 3, purpose: 'summary' },
    });
    expect(usage[0]!.usage.costUsd).toBeUndefined();
    expect(f.store.restore('business').checkpoint!.usage).toEqual(usage[0]!.usage);
    expect(f.store.archive('business')).toEqual(original);
    expect(JSON.stringify(wire.bodies[0])).toContain('business context as outcomes');
  } finally {
    await wire.close();
  }
});
