import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CANVAS_CHANNEL_ENVELOPE_BYTES,
  CanvasChannelAppAckSchema,
  CanvasChannelCheckboxReceiptSchema,
  CanvasChannelDeclarationSchema,
  CanvasChannelDocEventsContextSchema,
  CanvasChannelEventIdSchema,
  CanvasChannelEventPatternSchema,
  CanvasChannelEventTypeSchema,
  CanvasChannelGrantSchema,
  CanvasChannelPatchStateRequestSchema,
  CanvasChannelPointerSchema,
  CanvasChannelPresenceRequestSchema,
  CanvasChannelSendRequestSchema,
  CanvasChannelSequenceSchema,
  CanvasChannelStateSchema,
  CanvasChannelTokenRequestSchema,
  PageEventSchema,
  StoredPageEventSchema,
  inspectCanvasChannelJson,
  matchesCanvasChannelEvent,
} from '../canvas-channel-schemas.js';
import { CanvasDocumentSchema } from '../canvas-schemas.js';
import { OpenCanvasDocumentRequestSchema, RoomCanvasEventSchema } from '../room-schemas.js';

const id = '019943ce-5853-7000-a000-000000000001';
const base = { v: 1, id, type: 'task.toggled', payload: { done: true } };
const route = {
  id: 'tasks-to-owner',
  on: 'task.*',
  to: 'agent:owner',
  turn: { mode: 'coalesce', windowMs: 120000, maxBatch: 100 },
};

function nested(depth: number): unknown {
  let value: unknown = {};
  for (let index = 0; index < depth; index++) value = { child: value };
  return value;
}

describe('document channel raw envelopes', () => {
  it('accepts UUIDs across versions and preserves the complete envelope', () => {
    expect(
      PageEventSchema.parse({ ...base, coalesceKey: 'task-1', ts: '2026-10-01T10:00:00Z' })
    ).toEqual({ ...base, coalesceKey: 'task-1', ts: '2026-10-01T10:00:00Z' });
    expect(
      CanvasChannelEventIdSchema.safeParse('11111111-1111-1111-1111-111111111111').success
    ).toBe(true);
    expect(CanvasChannelEventIdSchema.safeParse('not-a-uuid').success).toBe(false);
  });
  it.each([
    'cwd',
    'scope',
    'sender',
    'channel',
    'forAgent',
    'permissions',
    'routeId',
    'receivedAt',
    'docSeq',
  ])('rejects page-controlled %s envelope authority', (key) => {
    expect(PageEventSchema.safeParse({ ...base, [key]: 'injected' }).success).toBe(false);
  });
  it.each([
    'doc.opened',
    'doc.saved',
    'selection.ask',
    'md.task.toggled',
    'state.changed',
    'event.status',
    'app.ack',
  ])('reserves %s from public input while permitting trusted storage', (type) => {
    expect(PageEventSchema.safeParse({ ...base, type }).success).toBe(false);
    expect(StoredPageEventSchema.safeParse({ ...base, type }).success).toBe(true);
    if (type !== 'app.ack')
      expect(
        CanvasChannelSendRequestSchema.safeParse({
          documentId: 'document',
          eventId: id,
          type,
          payload: {},
        }).success
      ).toBe(false);
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    -Infinity,
    () => {},
    1n,
    new Date(),
    new Map(),
    Object.create({ inherited: true }),
  ])('rejects non-JSON raw payload %s before parsing can normalize it', (payload) => {
    expect(PageEventSchema.safeParse({ ...base, payload }).success).toBe(false);
  });
  it('rejects recursive unsafe keys at every level', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const payload = JSON.parse(`{"nested":{"${key}":"unsafe"}}`);
      expect(PageEventSchema.safeParse({ ...base, payload }).success).toBe(false);
    }
  });
  it('rejects cycles, getters, symbols and sparse arrays without evaluating getters', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(PageEventSchema.safeParse({ ...base, payload: cycle }).success).toBe(false);
    const getter = Object.defineProperty({}, 'value', {
      get() {
        throw new Error('getter evaluated');
      },
      enumerable: true,
    });
    expect(PageEventSchema.safeParse({ ...base, payload: getter }).success).toBe(false);
    expect(PageEventSchema.safeParse({ ...base, payload: { [Symbol('hidden')]: 1 } }).success).toBe(
      false
    );
    expect(PageEventSchema.safeParse({ ...base, payload: new Array(1) }).success).toBe(false);
    const shared = { ok: 1 };
    expect(PageEventSchema.safeParse({ ...base, payload: [shared, shared] }).success).toBe(true);
  });
  it('bounds raw depth before recursive Zod traversal, even at 10000 levels', () => {
    expect(PageEventSchema.safeParse({ ...base, payload: nested(31) }).success).toBe(true);
    expect(PageEventSchema.safeParse({ ...base, payload: nested(32) }).success).toBe(false);
    expect(PageEventSchema.safeParse({ ...base, payload: nested(10000) }).success).toBe(false);
  });
  it('counts full serialized UTF-8 envelope bytes, including escaping and metadata', () => {
    const empty = { ...base, payload: '' };
    const overhead = Buffer.byteLength(JSON.stringify(empty));
    const exact = { ...empty, payload: 'x'.repeat(CANVAS_CHANNEL_ENVELOPE_BYTES - overhead) };
    expect(PageEventSchema.safeParse(exact).success).toBe(true);
    expect(PageEventSchema.safeParse({ ...exact, coalesceKey: 'x' }).success).toBe(false);
    expect(PageEventSchema.safeParse({ ...empty, payload: '界'.repeat(5500) }).success).toBe(false);
    expect(PageEventSchema.safeParse({ ...empty, payload: '\n'.repeat(8200) }).success).toBe(false);
    const payload = { text: '😃\n"', nested: [null, true, 0] };
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    expect(inspectCanvasChannelJson(payload, bytes)).toBeUndefined();
    expect(inspectCanvasChannelJson(payload, bytes - 1)).toContain('byte');
  });
});

describe('route and authority contracts', () => {
  it.each(['task.toggled', 'md.task.toggled', 'task-1.done', 'UPPER_case'])(
    'accepts ASCII type %s',
    (type) => expect(CanvasChannelEventTypeSchema.safeParse(type).success).toBe(true)
  );
  it.each([
    'task.*',
    'task..done',
    '.task',
    'task.',
    'tâsk.done',
    'task/done',
    '*',
    'x'.repeat(129),
  ])('rejects malformed type %s', (type) =>
    expect(CanvasChannelEventTypeSchema.safeParse(type).success).toBe(false)
  );
  it.each(['*', 'task*', '*.task', 'task.*.done', 'task.**', 'task..*'])(
    'rejects ambiguous route pattern %s',
    (pattern) => expect(CanvasChannelEventPatternSchema.safeParse(pattern).success).toBe(false)
  );
  it('matches complete segments and never prefixes or the bare parent', () => {
    expect(matchesCanvasChannelEvent('task.*', 'task.done')).toBe(true);
    expect(matchesCanvasChannelEvent('task.*', 'task.sub.done')).toBe(true);
    expect(matchesCanvasChannelEvent('task.*', 'tasking.done')).toBe(false);
    expect(matchesCanvasChannelEvent('task.*', 'task')).toBe(false);
    expect(matchesCanvasChannelEvent('task.done', 'task.done.extra')).toBe(false);
  });
  it('requires explicit schedules and distinct route IDs and refuses approval fields', () => {
    expect(CanvasChannelDeclarationSchema.parse({ routes: [route] })).toEqual({ routes: [route] });
    expect(CanvasChannelDeclarationSchema.safeParse({ routes: [route, route] }).success).toBe(
      false
    );
    expect(
      CanvasChannelDeclarationSchema.safeParse({
        routes: Array.from({ length: 17 }, (_, n) => ({ ...route, id: String(n) })),
      }).success
    ).toBe(false);
    expect(
      CanvasChannelDeclarationSchema.safeParse({ routes: [{ ...route, approvalId: 'fake' }] })
        .success
    ).toBe(false);
    expect(
      CanvasChannelDeclarationSchema.safeParse({ routes: [{ ...route, to: 'room:other' }] }).success
    ).toBe(false);
  });
  it('requires grant evidence rather than accepting a declaration as authority', () => {
    expect(CanvasChannelGrantSchema.safeParse(route).success).toBe(false);
  });
  it('accepts zero baselines but rejects unsafe revisions', () => {
    expect(CanvasChannelSequenceSchema.parse(0)).toBe(0);
    for (const value of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity])
      expect(CanvasChannelSequenceSchema.safeParse(value).success).toBe(false);
  });
});

describe('state, acknowledgements and future host-only contracts', () => {
  it('agent sends allow app acknowledgements but refuse host and system events', () => {
    const request = { documentId: 'doc', eventId: id, type: 'app.ack', payload: {} };
    expect(CanvasChannelSendRequestSchema.safeParse(request).success).toBe(true);
    for (const type of ['doc.opened', 'state.changed', 'event.status']) {
      expect(CanvasChannelSendRequestSchema.safeParse({ ...request, type }).success).toBe(false);
    }
  });
  it('refuses malformed pointer escapes and decoded unsafe segments', () => {
    for (const path of ['/safe/~2', '/constructor', '/x/__proto__', '/prototype', 'not/a/pointer'])
      expect(CanvasChannelPointerSchema.safeParse(path).success).toBe(false);
    for (const path of ['', '/a~1b/~0', '/safe/0'])
      expect(CanvasChannelPointerSchema.safeParse(path).success).toBe(true);
  });
  it('bounds the entire patch and requires an optimistic revision', () => {
    const patch = {
      documentId: 'doc',
      eventId: id,
      expectedStateRev: 0,
      operations: [{ op: 'set', path: '/done', value: true }],
    };
    expect(CanvasChannelPatchStateRequestSchema.parse(patch)).toEqual(patch);
    expect(
      CanvasChannelPatchStateRequestSchema.safeParse({
        ...patch,
        operations: Array.from({ length: 101 }, () => patch.operations[0]),
      }).success
    ).toBe(false);
    expect(
      CanvasChannelPatchStateRequestSchema.safeParse({
        ...patch,
        operations: [{ op: 'set', path: '/text', value: '界'.repeat(5500) }],
      }).success
    ).toBe(false);
    expect(CanvasChannelStateSchema.safeParse({ text: 'x'.repeat(256 * 1024) }).success).toBe(
      false
    );
    expect(CanvasChannelStateSchema.safeParse([]).success).toBe(false);
  });
  it('requires nonempty unique app acknowledgement IDs', () => {
    const ack = { batchId: 'batch', routeId: 'route', eventIds: [id], outcome: 'handled' };
    expect(CanvasChannelAppAckSchema.parse(ack)).toEqual(ack);
    expect(CanvasChannelAppAckSchema.safeParse({ ...ack, eventIds: [] }).success).toBe(false);
    expect(CanvasChannelAppAckSchema.safeParse({ ...ack, eventIds: [id, id] }).success).toBe(false);
  });
  it('does not allow mount callers to choose viewer identities', () => {
    expect(
      CanvasChannelPresenceRequestSchema.safeParse({ action: 'mount', viewerId: 'chosen' }).success
    ).toBe(false);
    expect(CanvasChannelPresenceRequestSchema.safeParse({ action: 'heartbeat' }).success).toBe(
      false
    );
  });
  it('does not allow token minting to grant routes or system event types', () => {
    const request = {
      documentId: 'doc',
      allowedTypes: ['task.done'],
      permissions: ['ingest'],
      expiresAt: '2026-10-02T00:00:00Z',
    };
    expect(CanvasChannelTokenRequestSchema.parse(request)).toEqual(request);
    expect(CanvasChannelTokenRequestSchema.safeParse({ ...request, routes: [route] }).success).toBe(
      false
    );
    expect(
      CanvasChannelTokenRequestSchema.safeParse({ ...request, allowedTypes: ['app.ack'] }).success
    ).toBe(false);
  });
  it('conflicts and no-ops cannot carry a routable checkbox success receipt', () => {
    expect(
      CanvasChannelCheckboxReceiptSchema.safeParse({
        status: 'conflict',
        eventId: id,
        action: 'reload',
        receipt: { id, status: 'recorded', docSeq: 1 },
      }).success
    ).toBe(false);
  });
});

describe('leaf and tool-schema compatibility', () => {
  it('converts tool contracts to JSON Schema without record nodes or propertyNames', () => {
    for (const schema of [
      PageEventSchema,
      CanvasChannelPatchStateRequestSchema,
      CanvasChannelSendRequestSchema,
      CanvasChannelDeclarationSchema,
      CanvasChannelDocEventsContextSchema,
    ]) {
      const converted = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
      expect(converted).toHaveProperty('type', 'object');
      expect(JSON.stringify(converted)).not.toContain('propertyNames');
      expect(JSON.stringify(converted)).toContain('additionalProperties');
    }
  });
  it('keeps channel options common and room/canvas schemas initialized without a cycle', () => {
    expect(OpenCanvasDocumentRequestSchema.shape.channel).toBeDefined();
    expect(CanvasDocumentSchema.shape.channel).toBeDefined();
    expect(
      RoomCanvasEventSchema.safeParse({ type: 'canvas', action: 'removed', documentId: 'doc' })
        .success
    ).toBe(true);
  });
  it('keeps the leaf imports acyclic and publishes its subpath', async () => {
    const source = await readFile(new URL('../canvas-channel-schemas.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(
      /from ['"]\.\/(?:canvas-schemas|room-schemas|session-stream|schemas)\.js/u
    );
    const helper = await readFile(new URL('../canvas-channel-json.ts', import.meta.url), 'utf8');
    expect(helper.match(/^import .*$/gmu)).toEqual([
      "import { z } from 'zod';",
      "import { extendZodWithOpenApiOnce } from './zod-openapi.js';",
    ]);
    const openApiHelper = await readFile(new URL('../zod-openapi.ts', import.meta.url), 'utf8');
    expect(openApiHelper.match(/^import .*$/gmu)).toEqual([
      "import { z } from 'zod';",
      "import { extendZodWithOpenApi, zodToOpenAPIRegistry } from '@asteasolutions/zod-to-openapi';",
    ]);
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
    expect(pkg.exports['./canvas-channel-schemas']).toEqual({
      types: './src/canvas-channel-schemas.ts',
      default: './dist/canvas-channel-schemas.js',
    });
  });
});
