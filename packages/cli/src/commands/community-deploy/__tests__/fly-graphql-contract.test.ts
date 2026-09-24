/**
 * @vitest-environment node
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FLY_APP_NAME_AVAILABLE_QUERY,
  FLY_APP_PROVENANCE_QUERY,
  FLY_TIGRIS_ON_APP_QUERY,
  FLY_TIGRIS_CREATE_MUTATION,
  FLY_TIGRIS_DELETE_MUTATION,
  FLY_TIGRIS_READ_QUERY,
  FLY_TIGRIS_TERMS_QUERY,
  FlyGraphqlContractError,
  createTigrisVariables,
  parseAppNameAvailableResponse,
  parseFlyAppProvenanceResponse,
  parseTigrisOnAppResponse,
  parseTigrisCreateResponse,
  parseTigrisDeleteResponse,
  parseTigrisReadResponse,
  parseTigrisTermsResponse,
  verifyTigrisBinding,
} from '../fly-graphql-contract.js';
import {
  expectSanitizedProviderFixture,
  mutateTrustedProviderFields,
  objectAt,
} from './provider-contract-harness.js';

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
    for (const mutation of mutateTrustedProviderFields(
      source,
      paths.map((path) => ['data', 'createAddOn', 'addOn', ...path])
    )) {
      expect(() => parseTigrisCreateResponse(mutation.value), mutation.label).toThrow(
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

  it('rejects every mutation of the trusted deletion identity', async () => {
    const source = await fixture('tigris-delete.json');
    for (const mutation of mutateTrustedProviderFields(source, [
      ['data', 'deleteAddOn', 'deletedAddOnName'],
    ])) {
      expect(
        () => parseTigrisDeleteResponse(mutation.value, 'community-fixture-bucket'),
        mutation.label
      ).toThrow(FlyGraphqlContractError);
    }
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

  it('pins minimal operations and creates variables without a public option', async () => {
    expect(FLY_TIGRIS_TERMS_QUERY).toContain('agreedToProviderTos');
    expect(FLY_TIGRIS_READ_QUERY).toContain('node(id: $id)');
    expect(FLY_TIGRIS_CREATE_MUTATION).toContain('createAddOn(input: $input)');
    expect(FLY_TIGRIS_DELETE_MUTATION).toContain('deletedAddOnName');
    expect(
      parseTigrisDeleteResponse(await fixture('tigris-delete.json'), 'community-fixture-bucket')
    ).toBe('community-fixture-bucket');
    expect(() =>
      parseTigrisDeleteResponse(
        { data: { deleteAddOn: { deletedAddOnName: 'foreign-bucket' } } },
        'community-fixture-bucket'
      )
    ).toThrowError(expect.objectContaining({ code: 'BINDING_MISMATCH' }));
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
    for (const name of [
      'app-provenance.json',
      'app-provenance-missing.json',
      'tigris-on-app.json',
      'app-name-available.json',
      'tigris-terms.json',
      'tigris-create.json',
      'tigris-read.json',
      'tigris-delete.json',
    ]) {
      const text = await readFile(new URL(name, fixtureDirectory), 'utf8');
      expectSanitizedProviderFixture(
        JSON.parse(text),
        fileURLToPath(new URL(name, fixtureDirectory))
      );
    }
  });
});

describe('Fly app provenance GraphQL contract', () => {
  it('parses the app, its private network and what it holds from the pinned fixture', async () => {
    expect(parseFlyAppProvenanceResponse(await fixture('app-provenance.json'))).toEqual({
      id: 'community-fixture-app',
      internalNumericId: '4817203',
      name: 'community-fixture-app',
      network: 'dorkos-7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a',
      createdAt: '2026-09-23T10:31:07Z',
      organizationSlug: 'fixture-org',
      machineCount: 0,
      volumeCount: 0,
      ipAddressCount: 0,
      certificateCount: 0,
      secretNames: [],
    });
  });

  it('reports an unknown app name as null without reading the error text', async () => {
    expect(parseFlyAppProvenanceResponse(await fixture('app-provenance-missing.json'))).toBeNull();
  });

  // A malformed success must never read as provenance: dropping or renaming any field the proof
  // or the "nothing was added" check depends on fails the whole read.
  it('rejects every missing or renamed trusted provenance field', async () => {
    const source = await fixture('app-provenance.json');
    const paths = [
      ['id'],
      ['internalNumericId'],
      ['name'],
      ['network'],
      ['createdAt'],
      ['organization'],
      ['organization', 'slug'],
      ['machines', 'totalCount'],
      ['volumes', 'totalCount'],
      ['ipAddresses', 'totalCount'],
      ['certificates', 'totalCount'],
      ['secrets'],
    ];
    for (const mutation of mutateTrustedProviderFields(
      source,
      paths.map((path) => ['data', 'app', ...path])
    )) {
      expect(() => parseFlyAppProvenanceResponse(mutation.value), mutation.label).toThrow(
        FlyGraphqlContractError
      );
    }
  });

  it('rejects secret values, unreadable times and a found app that carries errors', async () => {
    const withValue = await fixture('app-provenance.json');
    objectAt(withValue, 'data', 'app').secrets = [
      { name: 'AWS_SECRET_ACCESS_KEY', value: 'CANARY' },
    ];
    expect(() => parseFlyAppProvenanceResponse(withValue)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_RESPONSE',
        message: expect.not.stringContaining('CANARY'),
      })
    );

    const badTime = await fixture('app-provenance.json');
    objectAt(badTime, 'data', 'app').createdAt = 'yesterday';
    expect(() => parseFlyAppProvenanceResponse(badTime)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );

    const partial = (await fixture('app-provenance.json')) as Record<string, unknown>;
    partial.errors = [{ message: 'CANARY_PARTIAL' }];
    expect(() => parseFlyAppProvenanceResponse(partial)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );

    expect(() => parseFlyAppProvenanceResponse({ errors: [{ message: 'x' }] })).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );
  });

  it('keeps an empty or missing network as reported, so it can never match a marker', async () => {
    for (const network of ['', null]) {
      const source = await fixture('app-provenance.json');
      objectAt(source, 'data', 'app').network = network;
      expect(parseFlyAppProvenanceResponse(source)?.network).toBe(network);
    }
  });

  it('pins a minimal read that selects secret names only', () => {
    expect(FLY_APP_PROVENANCE_QUERY).toContain('query DorkosReadAppProvenance($name: String!)');
    expect(FLY_APP_PROVENANCE_QUERY).toContain('app(name: $name)');
    expect(FLY_APP_PROVENANCE_QUERY).toContain('secrets { name }');
    expect(FLY_APP_PROVENANCE_QUERY).not.toMatch(
      /\b(password|environment|ssoLink|metadata|value|digest)\b/u
    );
  });
});

describe('Fly Tigris-on-app and name GraphQL contracts', () => {
  it('parses the app, its network and its Tigris add-ons from the pinned fixture', async () => {
    expect(parseTigrisOnAppResponse(await fixture('tigris-on-app.json'))).toEqual({
      internalNumericId: '4817203',
      name: 'community-fixture-app',
      network: 'dorkos-7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a',
      organizationSlug: 'fixture-org',
      totalCount: 1,
      addOns: [
        {
          id: 'addon_fixture_01',
          name: 'community-fixture-bucket',
          createdAt: '2026-09-23T10:33:12Z',
          organizationSlug: 'fixture-org',
        },
      ],
    });
    expect(parseTigrisOnAppResponse({ data: { app: null }, errors: [{ message: 'x' }] })).toBe(
      null
    );
  });

  // A removal trusts these fields to re-prove the app and to see a cut-short list.
  it('rejects every missing or renamed field the Tigris binding proof reads', async () => {
    const source = await fixture('tigris-on-app.json');
    const paths = [
      ['internalNumericId'],
      ['name'],
      ['network'],
      ['organization', 'slug'],
      ['addOns', 'totalCount'],
      ['addOns', 'nodes'],
      ['addOns', 'nodes', 0, 'id'],
      ['addOns', 'nodes', 0, 'createdAt'],
      ['addOns', 'nodes', 0, 'organization', 'slug'],
    ];
    for (const mutation of mutateTrustedProviderFields(
      source,
      paths.map((path) => ['data', 'app', ...path])
    )) {
      expect(() => parseTigrisOnAppResponse(mutation.value), mutation.label).toThrow(
        FlyGraphqlContractError
      );
    }
    const partial = (await fixture('tigris-on-app.json')) as Record<string, unknown>;
    partial.errors = [{ message: 'CANARY_PARTIAL' }];
    expect(() => parseTigrisOnAppResponse(partial)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );
  });

  it('reads name availability and treats any error entry as a failed read', async () => {
    expect(parseAppNameAvailableResponse(await fixture('app-name-available.json'))).toBe(false);
    expect(parseAppNameAvailableResponse({ data: { appNameAvailable: true } })).toBe(true);
    for (const bad of [
      { data: { appNameAvailable: true }, errors: [{ message: 'x' }] },
      { data: null },
      { data: { appNameAvailable: 'yes' } },
    ]) {
      expect(() => parseAppNameAvailableResponse(bad)).toThrow(FlyGraphqlContractError);
    }
  });

  it('pins minimal reads that never select secret material', () => {
    expect(FLY_TIGRIS_ON_APP_QUERY).toContain('query DorkosFindTigrisOnApp($name: String!)');
    expect(FLY_TIGRIS_ON_APP_QUERY).toContain('addOns(type: tigris)');
    expect(FLY_APP_NAME_AVAILABLE_QUERY).toContain('appNameAvailable(name: $name)');
    for (const query of [FLY_TIGRIS_ON_APP_QUERY, FLY_APP_NAME_AVAILABLE_QUERY]) {
      expect(query).not.toMatch(/\b(password|environment|ssoLink|metadata|value|digest)\b/u);
    }
  });
});
