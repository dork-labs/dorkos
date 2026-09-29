import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { checkConnectorArguments, connectorValidationSchema } from '../connector-arguments.js';

/**
 * Composio's `GMAIL_FETCH_EMAILS` input schema, byte for byte as a live install
 * stored it. Real provider schemas carry a `default` on most optional fields,
 * plus `title`, `examples` (strings on an integer field among them) and
 * vendor keywords; the hand-written `{ properties, additionalProperties: false }`
 * fixtures that came before carried none of that, which is how a check that
 * refused every real Gmail call passed every test.
 */
const GMAIL_FETCH_EMAILS = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures', 'composio-gmail-fetch-emails.schema.json'),
    'utf8'
  )
) as Record<string, unknown>;

describe('checkConnectorArguments', () => {
  it('is checking a schema whose parse would fill defaults in', () => {
    // Pins the fixture's premise: were it to lose its defaults, the tests below
    // could pass against the old, broken check too.
    expect(z.fromJSONSchema(GMAIL_FETCH_EMAILS).parse({})).toMatchObject({
      max_results: 1,
      verbose: true,
    });
  });

  it.each([
    ['nothing at all', {}],
    ['only a query', { query: 'is:unread' }],
    ['a defaulted field set explicitly', { max_results: 15 }],
    ['several fields', { query: 'from:me', max_results: 15, verbose: false }],
    ['an array field', { label_ids: ['INBOX', 'UNREAD'] }],
  ])('accepts %s without changing it', (_label, value) => {
    const sent = structuredClone(value);
    expect(checkConnectorArguments(GMAIL_FETCH_EMAILS, value)).toEqual({ ok: true });
    expect(value).toEqual(sent);
  });

  it('refuses a key the operation does not declare, naming it', () => {
    expect(checkConnectorArguments(GMAIL_FETCH_EMAILS, { maxResults: 15 })).toEqual({
      ok: false,
      reason: 'mismatch',
      problem: expect.stringContaining('maxResults'),
    });
  });

  it.each([
    ['a number sent as a string', { max_results: '15' }, 'max_results'],
    ['a number over the limit', { max_results: 900 }, 'max_results'],
    ['a string where an array belongs', { label_ids: 'INBOX' }, 'label_ids'],
    ['a wrong type inside an array', { label_ids: [42] }, 'label_ids.0'],
  ])('refuses %s, naming the field but not the value', (_label, value, path) => {
    const check = checkConnectorArguments(GMAIL_FETCH_EMAILS, value);
    expect(check).toMatchObject({ ok: false, reason: 'mismatch' });
    const problem = check.ok ? '' : (check as { problem?: string }).problem;
    expect(problem?.startsWith(`${path}: `)).toBe(true);
    const sent = Object.values(value)[0];
    const raw = Array.isArray(sent) ? sent.map(String) : [String(sent)];
    for (const fragment of raw) expect(problem).not.toContain(fragment);
  });

  it('refuses a missing required field', () => {
    const schema = {
      type: 'object',
      properties: { message_id: { type: 'string' }, format: { type: 'string', default: 'full' } },
      required: ['message_id'],
    };
    expect(checkConnectorArguments(schema, { message_id: 'm-1' })).toEqual({ ok: true });
    expect(checkConnectorArguments(schema, { format: 'raw' })).toMatchObject({
      ok: false,
      problem: expect.stringContaining('message_id'),
    });
  });

  it('never fills a nested default either', () => {
    const schema = {
      type: 'object',
      properties: {
        attachment: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            mimetype: { type: 'string', default: 'text/plain' },
          },
        },
        recipients: {
          type: 'array',
          items: { type: 'object', properties: { cc: { type: 'boolean', default: false } } },
        },
        body: { anyOf: [{ type: 'string', default: '' }, { type: 'null' }], default: null },
      },
    };
    expect(
      checkConnectorArguments(schema, { attachment: { name: 'a.txt' }, recipients: [{}] })
    ).toEqual({ ok: true });
  });

  it('treats a property literally named `default` as a property, not an annotation', () => {
    const schema = {
      type: 'object',
      properties: { default: { type: 'boolean' } },
      required: ['default'],
    };
    expect(checkConnectorArguments(schema, { default: true })).toEqual({ ok: true });
    expect(checkConnectorArguments(schema, {})).toMatchObject({ ok: false });
  });

  it('leaves a root that says what other keys may do as the provider wrote it', () => {
    const open = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: true,
    };
    expect(checkConnectorArguments(open, { a: 'x', b: 1 })).toEqual({ ok: true });
    const composed = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'object', properties: { b: { type: 'number' } } },
      ],
    };
    expect(checkConnectorArguments(composed, { a: 'x', b: 1 })).toEqual({ ok: true });
  });

  it.each([
    [
      'allOf',
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        allOf: [{ type: 'object', properties: { b: { type: 'number' } } }],
      },
    ],
    [
      '$ref',
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        $ref: '#/$defs/Extra',
        $defs: { Extra: { type: 'object', properties: { b: { type: 'number' } } } },
      },
    ],
  ])(
    'does not close a root that also has %s, whose parts may declare more keys',
    (_label, schema) => {
      expect(checkConnectorArguments(schema, { a: 'x', b: 1 })).toEqual({ ok: true });
    }
  );

  it.each([
    'additionalProperties',
    'patternProperties',
    'unevaluatedProperties',
    '$ref',
    'allOf',
    'anyOf',
    'oneOf',
  ])('leaves the root open when it carries %s', (keyword) => {
    // zod 4.6 lets these keys through even beside a closed root, so the
    // behaviour tests above cannot see a dropped opener; the schema itself can.
    const schema = { type: 'object', properties: { a: { type: 'string' } }, [keyword]: {} };
    expect(connectorValidationSchema(schema)).toEqual(schema);
  });

  it('closes a plain root that says nothing about other keys', () => {
    expect(
      connectorValidationSchema({ type: 'object', properties: { a: { type: 'string' } } })
    ).toMatchObject({ additionalProperties: false });
  });

  it('reports a schema it cannot turn into a validator separately from a bad value', () => {
    expect(checkConnectorArguments({ type: 'no-such-type' }, {})).toEqual({
      ok: false,
      reason: 'schema_unreadable',
    });
  });

  it('bounds the problem it reports, so a hostile key cannot flood the refusal', () => {
    const check = checkConnectorArguments(GMAIL_FETCH_EMAILS, { ['k'.repeat(5_000)]: 1 });
    expect(check.ok).toBe(false);
    expect(check.ok ? '' : ((check as { problem?: string }).problem ?? '')).toHaveLength(200);
  });
});
