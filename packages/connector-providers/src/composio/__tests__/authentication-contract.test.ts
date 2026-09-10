import { describe, expect, it } from 'vitest';
import {
  ComposioAuthenticationDescriptorSchema,
  validateComposioAuthenticationFields,
} from '../authentication-contract.js';

const field = {
  name: 'api_key',
  label: 'API key',
  description: '',
  type: 'password',
  required: true,
  secret: true,
} as const;
const descriptor = {
  toolkit: 'synthetic',
  scheme: 'API_KEY',
  kind: 'fields',
  source: 'account-fields',
  fields: [field],
} as const;
const parsed = () => ComposioAuthenticationDescriptorSchema.parse(descriptor);

describe('hosted-only authentication field contract', () => {
  it('allows only declared primitive values without persisting or returning a provider envelope', () => {
    const result = validateComposioAuthenticationFields(parsed(), { api_key: 'SYNTHETIC_SECRET' });
    expect({ ...result }).toEqual({ api_key: 'SYNTHETIC_SECRET' });
    expect(Object.getPrototypeOf(result)).toBeNull();
  });
  it.each(['__proto__', 'constructor', 'prototype', 'status'])(
    'refuses reserved field %s',
    (name) => {
      expect(
        ComposioAuthenticationDescriptorSchema.safeParse({
          ...descriptor,
          fields: [{ ...field, name }],
        }).success
      ).toBe(false);
    }
  );
  it('refuses defaults, duplicates, excessive descriptors and unsupported OAuth modes', () => {
    for (const invalid of [
      { ...descriptor, fields: [{ ...field, default: 'SECRET_DEFAULT' }] },
      { ...descriptor, fields: [field, field] },
      {
        ...descriptor,
        fields: Array.from({ length: 65 }, (_, i) => ({ ...field, name: `key${i}` })),
      },
      { ...descriptor, scheme: 'OAUTH1', kind: 'oauth' },
      { ...descriptor, scheme: 'OAUTH2', kind: 'fields' },
    ])
      expect(ComposioAuthenticationDescriptorSchema.safeParse(invalid).success).toBe(false);
  });
  it('closes missing, unknown, wrong-type, oversized and prototype inputs without echoing values', () => {
    for (const raw of [
      {},
      { api_key: 'SENTINEL', foreign: 'SENTINEL' },
      { api_key: 3 },
      { api_key: 'SENTINEL'.repeat(2000) },
      JSON.parse('{"__proto__":"SENTINEL","api_key":"SENTINEL"}'),
    ]) {
      expect(() => validateComposioAuthenticationFields(parsed(), raw)).toThrow(
        'Account details do not match the required fields.'
      );
    }
  });
  it('enforces encoded byte budget and requires empty no-auth confirmation', () => {
    const fields = Array.from({ length: 10 }, (_, i) => ({ ...field, name: `key${i}` }));
    const many = ComposioAuthenticationDescriptorSchema.parse({ ...descriptor, fields });
    expect(() =>
      validateComposioAuthenticationFields(
        many,
        Object.fromEntries(fields.map((f) => [f.name, 'x'.repeat(7000)]))
      )
    ).toThrow();
    const none = ComposioAuthenticationDescriptorSchema.parse({
      ...descriptor,
      scheme: 'NO_AUTH',
      kind: 'none',
      fields: [],
    });
    expect({ ...validateComposioAuthenticationFields(none, {}) }).toEqual({});
    expect(() => validateComposioAuthenticationFields(none, { token: 'SENTINEL' })).toThrow();
    const oauth = ComposioAuthenticationDescriptorSchema.parse({
      ...descriptor,
      scheme: 'OAUTH2',
      kind: 'oauth',
    });
    expect(() => validateComposioAuthenticationFields(oauth, { api_key: 'SENTINEL' })).toThrow();
  });
});
