import { expect, it } from 'vitest';
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { registerDocChannelOpenApi } from '../openapi.js';

it('exports dedicated document host and bearer contracts without adding a capability surface', () => {
  const registry = new OpenAPIRegistry();
  registerDocChannelOpenApi(registry);
  const doc = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'Original document HTTP', version: 'test' },
  });
  expect(Object.keys(doc.paths ?? {})).toHaveLength(21);
  expect(doc.paths?.['/api/canvas/docs/{id}/events']?.post?.responses).toHaveProperty('201');
  expect(doc.paths?.['/api/canvas/docs/{id}/events/{eventId}']?.get?.parameters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'X-DorkOS-Doc-Generation', in: 'header', required: true }),
    ])
  );
  expect(doc.paths?.['/api/canvas/docs/{id}/manage/approve']?.post?.responses).toHaveProperty(
    '202'
  );
  expect(
    JSON.stringify(doc.paths?.['/api/canvas/docs/{id}/manage/approve']?.post?.responses?.['403'])
  ).toContain('approvable');
  expect(doc.paths?.['/api/canvas/token/docs/{id}/stream']?.get?.responses?.['200']).toHaveProperty(
    'content.text/event-stream'
  );
  const file = JSON.stringify(doc.paths?.['/api/files/content']?.put);
  expect(file).toContain('documentSave');
  expect(file).toContain('documentReceipt');
  expect(file).toContain('no_op');
  expect(doc.paths?.['/api/files/content']?.put?.responses?.['200']).toHaveProperty(
    'content.application/json.schema.required',
    expect.arrayContaining(['ok', 'hash', 'effect'])
  );
  expect(JSON.stringify(doc.components?.schemas)).toContain('CanvasChannelJson');
  expect(JSON.stringify(doc.paths?.['/api/canvas/token/docs/{id}/channel']?.get)).not.toContain(
    'stateRev'
  );
});

it('exports flag-free document patterns that accept the actual header, type and UUID forms', () => {
  const registry = new OpenAPIRegistry();
  registerDocChannelOpenApi(registry);
  const doc = new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: '3.1.0',
    info: { title: 'Original document patterns', version: 'test' },
  });
  const patterns = new Set<string>();
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) inspect(child);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'pattern' && typeof child === 'string') patterns.add(child);
      else inspect(child);
    }
  };
  inspect(doc);
  const cases = [
    {
      pattern: '^[a-f0-9]{64}$',
      native: /^[a-f0-9]{64}$/u,
      good: ['a'.repeat(64)],
      bad: ['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '/u'],
    },
    {
      pattern: '^Bearer dct_[A-Za-z0-9_-]{43}$',
      native: /^Bearer dct_[A-Za-z0-9_-]{43}$/u,
      good: ['Bearer dct_' + 'a'.repeat(43)],
      bad: [
        'Bearer dct_' + 'a'.repeat(42),
        'dct_' + 'a'.repeat(43),
        'Bearer dct_' + 'a'.repeat(43) + '/u',
      ],
    },
    {
      pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
      native: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
      good: ['01234567-89ab-cdef-0123-456789abcdef', '01234567-89AB-CDEF-0123-456789ABCDEF'],
      bad: ['01234567-89ag-cdef-0123-456789abcdef', '01234567-89ab-cdef-0123-456789abcdef/iu'],
    },
    {
      pattern: '^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*$',
      native: /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/u,
      good: ['md.task-toggled', 'App_1.changed'],
      bad: ['md.*', 'md..task', 'md.é'],
    },
    {
      pattern: '^[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*(?:\\.\\*)?$',
      native: /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*(?:\.\*)?$/u,
      good: ['md.task', 'md.*'],
      bad: ['md.*.task', '*', 'md.é'],
    },
    {
      pattern: '^agent:[A-Za-z0-9_-]+$',
      native: /^agent:[A-Za-z0-9_-]+$/u,
      good: ['agent:owner', 'agent:A_1'],
      bad: ['room:self', 'agent:', 'agent:é'],
    },
    {
      pattern: '^dct_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$',
      native: /^dct_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u,
      good: ['dct_' + 'a'.repeat(42) + 'A'],
      bad: ['dct_' + 'a'.repeat(42) + 'B', 'dct_' + 'a'.repeat(41) + 'A'],
    },
  ];
  for (const { pattern, native, good, bad } of cases) {
    expect(patterns.has(pattern), pattern).toBe(true);
    const generated = new RegExp(pattern);
    for (const value of good) {
      expect(native.test(value)).toBe(true);
      expect(generated.test(value)).toBe(true);
    }
    for (const value of bad) {
      expect(native.test(value)).toBe(false);
      expect(generated.test(value)).toBe(false);
    }
  }
  expect([...patterns].filter((pattern) => /\/(?:u|iu)$/.test(pattern))).toEqual([]);
});
