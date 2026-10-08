import { expect, it, vi } from 'vitest';
import {
  DeferredToolRegistry,
  INITIAL_SCHEMA_BUDGET_BYTES,
  createToolSearch,
  createDefaultToolRegistry,
  mcpAlias,
} from '../registry.js';
import type { ToolDescriptor, ToolContext } from '../../contracts.js';
const context: ToolContext = {
  sessionId: 'a',
  scope: 'main',
  workingDirectory: '.',
  signal: new AbortController().signal,
  emit: () => {},
};
function tool(name: string, initialLoad = false): ToolDescriptor {
  return {
    name,
    description: 'manage invoices',
    schema: { type: 'object' },
    initialLoad,
    execute: vi.fn(async () => ({ content: [] })),
  };
}
it('keeps initial schemas identical with 1000 large deferred tools and caps activation', async () => {
  const r = new DeferredToolRegistry();
  r.register(createToolSearch(r));
  r.register({ ...tool('read', true), description: 'read files' });
  const initial = JSON.stringify(
    r.selected().map(({ name, description, schema }) => ({ name, description, schema }))
  );
  for (let i = 0; i < 1000; i++)
    r.register({
      ...tool(`deferred_${i}`),
      schema: { type: 'object', description: 'x'.repeat(20000) },
    });
  expect(
    JSON.stringify(
      r.selected().map(({ name, description, schema }) => ({ name, description, schema }))
    )
  ).toBe(initial);
  expect(Buffer.byteLength(initial)).toBeLessThan(INITIAL_SCHEMA_BUDGET_BYTES);
  await expect(r.execute('deferred_1', {}, context)).rejects.toThrow('not loaded');
  expect(r.search('invoices', 2).map((x) => x.name)).toEqual(['deferred_0', 'deferred_1']);
  await r.execute('deferred_1', {}, context);
  expect(r.selected()).toHaveLength(4);
  expect(r.inventory({ limit: 2 }).items).toHaveLength(2);
  expect(r.inventory({ offset: 2, limit: 2 }).items[0]?.name).toBe('deferred_0');
});
it('matches hints without execution, rejects invalid names and limits, and makes stable aliases', async () => {
  const r = new DeferredToolRegistry();
  const t = { ...tool('bill'), description: 'billing', searchHint: 'refund receipt' };
  r.register(t);
  expect(r.search('receipts', 1)[0]?.name).toBe('bill');
  expect(t.execute).not.toHaveBeenCalled();
  for (const name of ['', 'bad.name', '1bad', 'a'.repeat(65), '__proto__'])
    expect(() => r.register(tool(name))).toThrow();
  expect(() => r.register(t)).toThrow('Duplicate');
  expect(() => r.search('refund', 999)).toThrow();
  await expect(r.execute('missing', {}, context)).rejects.toThrow('Unknown');
  expect(mcpAlias('a-b', 'x')).not.toBe(mcpAlias('a_b', 'x'));
  expect(mcpAlias('long'.repeat(100), 'tool')).toHaveLength(64);
});
it('tool_search activates bounded metadata and host slots need no engine edit', async () => {
  const r = new DeferredToolRegistry();
  r.register(createToolSearch(r));
  r.register({ ...tool('host_events'), description: 'calendar events' });
  const result = await r.execute('tool_search', { query: 'calendar', limit: 1 }, context);
  expect(result.structuredContent).toEqual({ loaded: ['host_events'] });
  expect(r.selected().map((x) => x.name)).toEqual(['tool_search', 'host_events']);
  await expect(r.execute('tool_search', { query: '', limit: 1 }, context)).rejects.toThrow();
});
it('caps replaceable activation across searches and protects request snapshots', () => {
  const r = new DeferredToolRegistry({ selectedTools: 2 });
  r.register({ ...tool('first', true), description: 'fixed first capability' });
  r.register(tool('second'));
  r.register(tool('third'));
  const before = r.selected();
  r.search('invoice', 1);
  r.search('invoice', 1);
  expect(r.selected()).toHaveLength(2);
  expect(before).toHaveLength(1);
  const selected = r.selected();
  selected[0]!.schema.type = 'changed';
  expect(r.selected()[0]!.schema.type).toBe('object');
  const b = new DeferredToolRegistry({ initialSchemaBytes: 10 });
  expect(() => b.register(tool('large', true))).toThrow('budget');
  expect(b.selected()).toEqual([]);
});

it('composes business tools and search within the initial budget, retaining deferred host slots', () => {
  const r = createDefaultToolRegistry(
    ['read', 'write', 'web_fetch', 'load_skill', 'builder'].map((n) => tool(n)),
    [tool('host_deferred'), tool('host_initial', true)]
  );
  expect(r.selected().map((t) => t.name)).toEqual([
    'tool_search',
    'read',
    'write',
    'web_fetch',
    'load_skill',
    'builder',
    'host_initial',
  ]);
  expect(() => createDefaultToolRegistry([tool('shell')])).toThrow('business');
  expect(() =>
    createDefaultToolRegistry([{ ...tool('read'), schema: { description: 'x'.repeat(40000) } }])
  ).toThrow('budget');
});
it('replaces deferred working sets while keeping initial tools, repeats discover names, and snapshots stay detached', async () => {
  const r = new DeferredToolRegistry({ selectedTools: 2 });
  r.register(createToolSearch(r));
  const invoices = { ...tool('invoices'), description: 'invoices billing' };
  const calendar = { ...tool('calendar'), description: 'calendar appointments' };
  r.register(invoices);
  r.register(calendar);
  expect(r.search('invoices', 1).map((t) => t.name)).toEqual(['invoices']);
  const previous = r.selected();
  expect(r.search('calendar', 1).map((t) => t.name)).toEqual(['calendar']);
  expect(r.selected().map((t) => t.name)).toEqual(['tool_search', 'calendar']);
  expect(previous.map((t) => t.name)).toEqual(['tool_search', 'invoices']);
  expect(r.search('calendar', 1).map((t) => t.name)).toEqual(['calendar']);
  expect(invoices.execute).not.toHaveBeenCalled();
  expect(calendar.execute).not.toHaveBeenCalled();
  await expect(r.execute('invoices', {}, context)).rejects.toThrow('not loaded');
  r.register({
    ...tool('huge'),
    description: 'oversized reports',
    schema: { description: 'x'.repeat(300000) },
  });
  expect(() => r.search('oversized', 1)).toThrow('budget');
  expect(r.selected().map((t) => t.name)).toEqual(['tool_search', 'calendar']);
});
it('budgets newly registered initial schemas independently from activated deferred schemas', () => {
  const r = new DeferredToolRegistry({ initialSchemaBytes: 300 });
  r.register({ ...tool('base', true), description: 'base' });
  r.register({
    ...tool('large'),
    description: 'large',
    schema: { description: 'x'.repeat(40000) },
  });
  r.search('large', 1);
  expect(() => r.register({ ...tool('tiny', true), description: 'tiny' })).not.toThrow();
  expect(r.selected().map((t) => t.name)).toEqual(['base', 'large', 'tiny']);
  const full = new DeferredToolRegistry({ selectedTools: 1 });
  full.register(tool('first', true));
  expect(() => full.register(tool('other', true))).toThrow('budget');
  expect(full.inventory().items.map((t) => t.name)).toEqual(['first']);
});
