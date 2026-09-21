/**
 * @vitest-environment node
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FLY_TIGRIS_CREATE_MUTATION,
  FLY_TIGRIS_READ_QUERY,
  FLY_TIGRIS_TERMS_QUERY,
  FlyGraphqlContractError,
  createTigrisVariables,
  parseTigrisCreateResponse,
  parseTigrisReadResponse,
  parseTigrisTermsResponse,
  verifyTigrisBinding,
} from '../fly-graphql-contract.js';

const fixtureDirectory = new URL('./fixtures/fly/', import.meta.url);
const expectedBinding = {
  addOnId: 'addon_fixture_01',
  addOnName: 'community-fixture-bucket',
  organizationSlug: 'fixture-org',
  appId: 'app_fixture_01',
  appName: 'community-fixture-app',
};

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, fixtureDirectory), 'utf8'));
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function objectAt(value: unknown, ...path: string[]): Record<string, unknown> {
  let current = value;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      throw new Error(`Fixture path is not an object: ${path.join('.')}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current !== 'object' || current === null || Array.isArray(current)) {
    throw new Error(`Fixture path is not an object: ${path.join('.')}`);
  }
  return current as Record<string, unknown>;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => [key, ...collectStrings(child)]);
  }
  return [];
}

function hasTerminalControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

describe('Fly Tigris GraphQL contract', () => {
  it('parses only the trusted fields from pinned sanitized fixtures', async () => {
    expect(parseTigrisTermsResponse(await fixture('tigris-terms.json'))).toBe(true);
    const created = parseTigrisCreateResponse(await fixture('tigris-create.json'));
    const read = parseTigrisReadResponse(await fixture('tigris-read.json'));
    expect(created).toEqual({
      ...expectedBinding,
      status: 'ready',
      providerName: 'tigris',
      public: false,
    });
    expect(read).toEqual(created);
    expect(verifyTigrisBinding(read, expectedBinding)).toBe(read);
  });

  it('rejects every missing or renamed trusted creation field', async () => {
    const source = await fixture('tigris-create.json');
    const paths = [
      ['id'],
      ['name'],
      ['status'],
      ['options'],
      ['options', 'public'],
      ['organization'],
      ['organization', 'slug'],
      ['addOnProvider'],
      ['addOnProvider', 'name'],
      ['app'],
      ['app', 'id'],
      ['app', 'name'],
    ];
    for (const path of paths) {
      const changed = copy(source);
      const target = objectAt(changed, 'data', 'createAddOn', 'addOn', ...path.slice(0, -1));
      const key = path.at(-1)!;
      target[`${key}_renamed`] = target[key];
      delete target[key];
      expect(() => parseTigrisCreateResponse(changed), path.join('.')).toThrow(
        FlyGraphqlContractError
      );
    }
  });

  it('rejects changed types, control characters, excluded fields, and GraphQL errors safely', async () => {
    const wrongType = await fixture('tigris-read.json');
    objectAt(wrongType, 'data', 'node', 'options').public = 'false';
    expect(() => parseTigrisReadResponse(wrongType)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );

    const control = await fixture('tigris-read.json');
    objectAt(control, 'data', 'node', 'app').name = 'app\u001b[31m';
    expect(() => parseTigrisReadResponse(control)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );

    const excluded = await fixture('tigris-create.json');
    objectAt(excluded, 'data', 'createAddOn', 'addOn').password = 'CANARY_PROVIDER_SECRET';
    expect(() => parseTigrisCreateResponse(excluded)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_RESPONSE',
        message: expect.not.stringContaining('CANARY_PROVIDER_SECRET'),
      })
    );

    expect(() =>
      parseTigrisReadResponse({ errors: [{ message: 'CANARY_PROVIDER_SECRET' }] })
    ).toThrowError(
      expect.objectContaining({
        code: 'INVALID_RESPONSE',
        message: expect.not.stringContaining('CANARY_PROVIDER_SECRET'),
      })
    );
  });

  it('distinguishes missing terms viewer and exact-ID add-on results', () => {
    expect(() => parseTigrisTermsResponse({ data: { viewer: null } })).toThrowError(
      expect.objectContaining({ code: 'TERMS_VIEWER_MISSING' })
    );
    expect(() => parseTigrisReadResponse({ data: { node: null } })).toThrowError(
      expect.objectContaining({ code: 'ADD_ON_MISSING' })
    );
  });

  it('rejects public access and every wrong provider binding', async () => {
    const source = await fixture('tigris-read.json');
    objectAt(source, 'data', 'node', 'options').public = true;
    expect(() =>
      verifyTigrisBinding(parseTigrisReadResponse(source), expectedBinding)
    ).toThrowError(expect.objectContaining({ code: 'PUBLIC_BUCKET' }));

    const identity = parseTigrisCreateResponse(await fixture('tigris-create.json'));
    for (const key of Object.keys(expectedBinding) as (keyof typeof expectedBinding)[]) {
      expect(
        () => verifyTigrisBinding(identity, { ...expectedBinding, [key]: 'wrong' }),
        key
      ).toThrowError(expect.objectContaining({ code: 'BINDING_MISMATCH' }));
    }
    expect(() =>
      verifyTigrisBinding({ ...identity, providerName: 'other' }, expectedBinding)
    ).toThrowError(expect.objectContaining({ code: 'BINDING_MISMATCH' }));
    expect(() =>
      verifyTigrisBinding(identity, { ...expectedBinding, addOnId: 'unsafe/id' })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_EXPECTED_BINDING' }));
  });

  it('pins minimal operations and creates variables without a public option', () => {
    expect(FLY_TIGRIS_TERMS_QUERY).toContain('agreedToProviderTos');
    expect(FLY_TIGRIS_READ_QUERY).toContain('node(id: $id)');
    expect(FLY_TIGRIS_CREATE_MUTATION).toContain('createAddOn(input: $input)');
    for (const document of [FLY_TIGRIS_CREATE_MUTATION, FLY_TIGRIS_READ_QUERY]) {
      expect(document).not.toMatch(
        /\b(password|environment|ssoLink|errorMessage|metadata|publicUrl)\b/u
      );
    }
    expect(
      createTigrisVariables({
        clientMutationId: 'run_01',
        appId: 'app_fixture_01',
        organizationId: 'org_fixture_01',
        name: 'community-fixture-bucket',
        primaryRegion: 'ord',
      })
    ).toEqual({
      input: {
        clientMutationId: 'run_01',
        appId: 'app_fixture_01',
        organizationId: 'org_fixture_01',
        name: 'community-fixture-bucket',
        primaryRegion: 'ord',
        type: 'tigris',
      },
    });
  });

  it('keeps checked-in provider fixtures free of credential shapes and terminal controls', async () => {
    for (const name of ['tigris-terms.json', 'tigris-create.json', 'tigris-read.json']) {
      const text = await readFile(new URL(name, fixtureDirectory), 'utf8');
      expect(text, fileURLToPath(new URL(name, fixtureDirectory))).not.toMatch(
        /password|secret|access[_-]?key|session[_-]?token|postgres(?:ql)?:\/\/|https?:\/\//iu
      );
      for (const value of collectStrings(JSON.parse(text)))
        expect(hasTerminalControl(value)).toBe(false);
    }
  });
});
