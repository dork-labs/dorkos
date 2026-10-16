import { CanvasDocIncarnationSchema } from '../../canvas-doc-incarnation.js';
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { expect, it } from 'vitest';
import {
  FileSaveRecoverBodySchema,
  FileSaveRecoveryLookupSchema,
  FileSaveDiscoverySchema,
  FileSaveRecoverResultSchema,
} from '../recovery.js';
const incarnation = {
  v: 1,
  documentId: 'doc',
  physicalOpenedAt: '2026-10-15T00:00:00Z',
  channelCreatedAt: '2026-10-15T00:00:00Z',
  generation: 'a'.repeat(64),
};
const eventId = '00000000-0000-4000-8000-000000000001';
const entry = {
  eventId,
  createdAt: '2026-10-15T00:00:00Z',
  updatedAt: '2026-10-15T00:00:00Z',
  state: 'review',
  reason: 'prepared_without_replacement',
};
it('accepts only expected full birth in the public recovery body', () => {
  expect(FileSaveRecoverBodySchema.parse({ expectedIncarnation: incarnation })).toEqual({
    expectedIncarnation: incarnation,
  });
  expect(() =>
    FileSaveRecoverBodySchema.parse({
      expectedIncarnation: incarnation,
      content: 'secret draft',
      path: '/foreign',
      principal: { kind: 'operator' },
    })
  ).toThrow();
  expect(() =>
    FileSaveRecoveryLookupSchema.parse({
      documentId: 'foreign',
      eventId,
      expectedIncarnation: incarnation,
    })
  ).toThrow();
});
it('caps summaries without treating truncation or historical result as write readiness', () => {
  const base = {
    documentId: 'doc',
    incarnation,
    entries: [entry],
    hasMore: true,
    window: 'latest_25_current_owner_birth',
    admission: 'blocked',
  };
  expect(FileSaveDiscoverySchema.parse(base).hasMore).toBe(true);
  expect(() =>
    FileSaveDiscoverySchema.parse({ ...base, entries: Array.from({ length: 26 }, () => entry) })
  ).toThrow();
  expect(() => FileSaveDiscoverySchema.parse({ ...base, admission: 'ready' })).toThrow();
});
it('refuses a historical receipt for any different physical/channel birth', () => {
  const receipt = {
    documentId: 'doc',
    eventId,
    incarnation: { ...incarnation, generation: 'b'.repeat(64) },
    docSeq: 1,
    fileHash: 'c'.repeat(64),
    status: 'duplicate',
  };
  expect(() =>
    FileSaveRecoverResultSchema.parse({
      documentId: 'doc',
      incarnation,
      entry: {
        eventId,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        state: 'receipt',
        receipt,
        historical: true,
        currentFileMatch: 'not_checked',
      },
    })
  ).toThrow();
});

it.each(['a'.repeat(64), 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'é'.repeat(64), ''])(
  'preserves neutral generation runtime validation for %s without decorating the pre-extension field',
  (generation) => {
    expect(
      FileSaveRecoverBodySchema.safeParse({ expectedIncarnation: { ...incarnation, generation } })
        .success
    ).toBe(CanvasDocIncarnationSchema.safeParse({ ...incarnation, generation }).success);
  }
);
it('exports only the owned recovery schema regex metadata without unsupported flags', () => {
  const registry = new OpenAPIRegistry();
  registry.register('OriginalSaveDiscovery', FileSaveDiscoverySchema);
  registry.register('OriginalSaveRecoveryBody', FileSaveRecoverBodySchema);
  registry.register('OriginalSaveRecoveryResult', FileSaveRecoverResultSchema);
  const doc = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'Owned original save recovery', version: '1' },
  });
  const patterns: string[] = [];
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      if (typeof object.pattern === 'string') patterns.push(object.pattern);
      Object.values(object).forEach(visit);
    }
  }
  visit(doc);
  expect(patterns).toContain('^[a-f0-9]{64}$');
  expect(patterns).toContain(
    '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$'
  );
  for (const pattern of patterns) expect(() => new RegExp(pattern)).not.toThrow();
});
