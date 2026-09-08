import { describe, expect, it } from 'vitest';
import { buildEventFilter, readEventFilterFields } from '../lib/event-filter-fields';

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
