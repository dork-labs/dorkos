import { describe, expect, it } from 'vitest';
import {
  CanvasChannelTokenRequestSchema,
  CanvasChannelTokenRecordSchema,
  CanvasChannelTokenResponseSchema,
  PageEventSchema,
} from '../canvas-channel-schemas.js';

const request = {
  documentId: 'doc-token',
  allowedTypes: ['test.event'],
  directions: ['upstream'],
  permissions: ['ingest', 'replay'],
  expiresAt: '2026-10-05T00:00:00.000Z',
};
const record = {
  ...request,
  tokenId: 'token-id',
  tokenHash: 'a'.repeat(64),
  creatorId: 'operator',
  createdAt: '2026-10-04T00:00:00.000Z',
  revokedAt: null,
};
const response = {
  ...request,
  tokenId: 'token-id',
  creatorId: 'operator',
  createdAt: '2026-10-04T00:00:00.000Z',
  token: `dct_${'A'.repeat(43)}`,
};

describe('explicit standalone token restrictions', () => {
  for (const [name, schema, source] of [
    ['request', CanvasChannelTokenRequestSchema, request],
    ['retained record', CanvasChannelTokenRecordSchema, record],
    ['one-time response', CanvasChannelTokenResponseSchema, response],
  ] as const) {
    it(`${name} requires explicit finite unique directions without defaulting`, () => {
      expect(schema.safeParse(source).success).toBe(true);
      for (const directions of [
        undefined,
        [],
        ['upstream', 'upstream'],
        ['unknown'],
        ['upstream', 'downstream', 'system', 'upstream'],
      ]) {
        expect(schema.safeParse({ ...source, directions }).success).toBe(false);
      }
      expect(
        schema.parse({ ...source, directions: ['upstream', 'downstream', 'system'] }).directions
      ).toEqual(['upstream', 'downstream', 'system']);
    });
    it(`${name} refuses duplicate types and permissions and ingest without upstream`, () => {
      expect(
        schema.safeParse({ ...source, allowedTypes: ['test.event', 'test.event'] }).success
      ).toBe(false);
      expect(schema.safeParse({ ...source, permissions: ['replay', 'replay'] }).success).toBe(
        false
      );
      expect(
        schema.safeParse({ ...source, directions: ['downstream'], permissions: ['ingest'] }).success
      ).toBe(false);
      expect(
        schema.safeParse({
          ...source,
          directions: ['downstream'],
          permissions: ['replay', 'stream'],
        }).success
      ).toBe(true);
    });
    it(`${name} permits exact native reserved read types only with their direction and read permission`, () => {
      for (const [type, direction] of [
        ['md.task.toggled', 'upstream'],
        ['app.ack', 'downstream'],
        ['state.changed', 'system'],
        ['event.status', 'system'],
        ['doc.opened', 'system'],
        ['doc.closed', 'system'],
        ['doc.focused', 'system'],
        ['doc.blurred', 'system'],
        ['doc.viewers', 'system'],
      ] as const) {
        for (const permission of ['replay', 'stream']) {
          expect(
            schema.safeParse({
              ...source,
              allowedTypes: [type],
              directions: [direction],
              permissions: [permission],
            }).success
          ).toBe(true);
        }
        expect(
          schema.safeParse({
            ...source,
            allowedTypes: [type],
            directions: ['upstream', 'downstream', 'system'],
            permissions: ['ingest'],
          }).success
        ).toBe(false);
        expect(
          schema.safeParse({
            ...source,
            allowedTypes: [type],
            directions: ['upstream', 'downstream', 'system'].filter(
              (candidate) => candidate !== direction
            ),
            permissions: ['replay'],
          }).success
        ).toBe(false);
      }
    });
    it(`${name} refuses wildcard and unrecognized reserved types without confusing public prototype names`, () => {
      for (const type of [
        'app.*',
        'state.*',
        'state.unknown',
        'doc.unknown',
        'doc.saved',
        'selection.ask',
      ])
        expect(
          schema.safeParse({
            ...source,
            allowedTypes: [type],
            directions: ['system'],
            permissions: ['replay'],
          }).success
        ).toBe(false);
      expect(
        schema.safeParse({
          ...source,
          allowedTypes: ['constructor'],
          directions: ['upstream'],
          permissions: ['ingest'],
        }).success
      ).toBe(true);
    });
    it(`${name} refuses oversized token datetime fields without truncation`, () => {
      const timestamp = `2026-10-04T00:00:00.${'0'.repeat(64)}Z`;
      expect(schema.safeParse({ ...source, expiresAt: timestamp }).success).toBe(false);
      if ('createdAt' in source)
        expect(schema.safeParse({ ...source, createdAt: timestamp }).success).toBe(false);
      if ('revokedAt' in source)
        expect(schema.safeParse({ ...source, revokedAt: timestamp }).success).toBe(false);
    });
  }
  it('read scopes never authorize reserved public page ingestion', () => {
    for (const type of [
      'md.task.toggled',
      'app.ack',
      'state.changed',
      'event.status',
      'doc.opened',
      'doc.closed',
      'doc.focused',
      'doc.blurred',
      'doc.viewers',
    ]) {
      expect(
        CanvasChannelTokenRequestSchema.safeParse({
          ...request,
          allowedTypes: [type],
          directions: ['upstream', 'downstream', 'system'],
          permissions: ['ingest', 'replay'],
        }).success
      ).toBe(true);
      expect(
        PageEventSchema.safeParse({
          v: 1,
          id: '00000000-0000-4000-8000-000000000001',
          type,
          payload: {},
        }).success
      ).toBe(false);
    }
  });
  it('one-time response requires complete scope metadata and canonical 32-byte secret syntax', () => {
    expect(CanvasChannelTokenResponseSchema.safeParse(response).success).toBe(true);
    for (const field of [
      'documentId',
      'allowedTypes',
      'directions',
      'permissions',
      'creatorId',
      'createdAt',
    ]) {
      const missing: Record<string, unknown> = { ...response };
      delete missing[field];
      expect(CanvasChannelTokenResponseSchema.safeParse(missing).success).toBe(false);
    }
    for (const token of [
      `dct_${'A'.repeat(32)}`,
      `dct_${'A'.repeat(44)}`,
      `dct_${'A'.repeat(42)}B`,
      `dct_${'A'.repeat(43)}=`,
    ])
      expect(CanvasChannelTokenResponseSchema.safeParse({ ...response, token }).success).toBe(
        false
      );
    expect(
      CanvasChannelTokenResponseSchema.safeParse({ ...response, tokenHash: 'a'.repeat(64) }).success
    ).toBe(false);
  });
});
