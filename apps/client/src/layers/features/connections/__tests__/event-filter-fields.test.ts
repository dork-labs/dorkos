import { describe, expect, it } from 'vitest';
import {
  buildEventFilter,
  readEventFilterFields,
  initialEventFilterValues,
} from '../lib/event-filter-fields';

import { gmailFilterSchema } from './event-filter-fixtures';

describe('event filter fields', () => {
  it('converts only supported schema controls to validated primitive values', () => {
    const fields = readEventFilterFields({
      type: 'object',
      properties: {
        folder: { type: 'string', enum: ['inbox', 'archive'] },
        unread: { type: 'boolean' },
        minimum: { type: 'integer' },
      },
      required: ['folder', 'minimum'],
    });

    expect(fields).not.toBeNull();
    expect(buildEventFilter(fields ?? [], { folder: 'inbox', unread: true, minimum: '3' })).toEqual(
      { folder: 'inbox', unread: true, minimum: 3 }
    );
    expect(buildEventFilter(fields ?? [], { folder: 'elsewhere', minimum: '3' })).toBeNull();
    expect(buildEventFilter(fields ?? [], { folder: 'inbox', minimum: '3.5' })).toBeNull();
  });

  it('refuses nested or otherwise unsupported schema fields', () => {
    expect(
      readEventFilterFields({
        type: 'object',
        properties: { nested: { type: 'object', properties: {} } },
      })
    ).toBeNull();
    expect(readEventFilterFields({ type: 'array', items: { type: 'string' } })).toBeNull();
  });

  it.each([
    { properties: { folder: { type: 'string', pattern: '^inbox$' } } },
    { properties: { folder: { type: 'string', minLength: 2 } } },
    { properties: { count: { type: 'integer', minimum: 1 } } },
    { properties: { folder: { const: 'inbox', type: 'string' } } },
    { properties: { folder: { anyOf: [{ type: 'string' }], type: 'string' } } },
  ])('refuses scalar constraints the bounded form does not enforce', (schema) => {
    expect(readEventFilterFields({ type: 'object', ...schema })).toBeNull();
  });

  it('accepts annotations and a closed object while rejecting unsatisfiable required fields', () => {
    expect(
      readEventFilterFields({
        type: 'object',
        title: 'Mail filter',
        description: 'Fields supported by this service.',
        additionalProperties: false,
        properties: {
          folder: { type: 'string', title: 'Folder', description: 'Mailbox folder.' },
        },
        required: ['folder'],
      })
    ).toEqual([{ name: 'folder', label: 'Folder', required: true, type: 'string' }]);
    expect(
      readEventFilterFields({
        type: 'object',
        properties: { folder: { type: 'string' } },
        required: ['missing'],
      })
    ).toBeNull();
  });
});

describe('validated event annotations', () => {
  it('initializes only defaults and preserves the exact empty-string scope', () => {
    const fields = readEventFilterFields(gmailFilterSchema);
    expect(fields).not.toBeNull();
    const values = initialEventFilterValues(fields!);
    expect(buildEventFilter(fields!, { ...values, interval: '' })).toBeNull();
    expect(buildEventFilter(fields!, {})).toBeNull();
    expect(values).toEqual({ interval: '1.5', labelIds: 'INBOX', query: '', userId: 'me' });
    expect(buildEventFilter(fields!, values)).toEqual({
      interval: 1.5,
      labelIds: 'INBOX',
      query: '',
      userId: 'me',
    });
    expect(buildEventFilter(fields!, { ...values, labelIds: '', query: '  ' })).toEqual({
      interval: 1.5,
      labelIds: '',
      query: '  ',
      userId: 'me',
    });
  });

  it.each([
    { type: 'string', default: 1 },
    { type: 'number', default: '1' },
    { type: 'number', default: Infinity },
    { type: 'number', examples: [NaN] },
    { type: 'integer', default: 1.5 },
    { type: 'integer', examples: [2, 3.5] },
    { type: 'boolean', default: 'false' },
    { type: 'boolean', examples: [false, 0] },
    { type: 'string', default: null },
    { type: 'string', default: undefined },
    { type: 'string', examples: 'inbox' },
    { type: 'string', examples: [null] },
    { type: 'string', enum: ['inbox'], default: 'sent' },
    { type: 'string', enum: ['inbox'], examples: ['inbox', 'sent'] },
    { type: 'string', default: 'inbox', pattern: '^inbox$' },
  ])('rejects invalid annotations without relaxing unsupported constraints: %j', (field) => {
    expect(readEventFilterFields({ type: 'object', properties: { field } })).toBeNull();
  });

  it('keeps examples unselected, validates enum defaults, and retains false and zero', () => {
    const fields = readEventFilterFields({
      type: 'object',
      properties: {
        exampleOnly: { type: 'string', examples: ['never select me'] },
        folder: { type: 'string', enum: ['', 'inbox'], default: '' },
        enabled: { type: 'boolean', default: false, examples: [true] },
        count: { type: 'integer', default: 0, examples: [1] },
      },
    });
    expect(fields).not.toBeNull();
    expect(initialEventFilterValues(fields!)).toEqual({ folder: '', enabled: false, count: '0' });
    expect(buildEventFilter(fields!, initialEventFilterValues(fields!))).toEqual({
      folder: '',
      enabled: false,
      count: 0,
    });
  });

  it('requires presence rather than inventing a minimum string length', () => {
    const fields = readEventFilterFields({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    })!;
    expect(buildEventFilter(fields, {})).toBeNull();
    expect(buildEventFilter(fields, { query: '' })).toEqual({ query: '' });
  });
});
