import { describe, expect, it } from 'vitest';
import {
  FLY_APP_NAME_AVAILABLE_QUERY,
  FLY_APP_PROVENANCE_QUERY,
  FLY_APP_TIGRIS_QUERY,
  FLY_TIGRIS_BY_NAME_QUERY,
  FlyGraphqlContractError,
  parseAppNameAvailableResponse,
  parseTigrisNameHeldResponse,
  parseFlyAppProvenanceResponse,
  parseTigrisOnAppResponse,
} from '../../fly-graphql-contract.js';
import { mutateTrustedProviderFields, objectAt } from '../provider-contract-harness.js';
import { fixture } from './fly-graphql-contract.fixtures.js';

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
    expect(FLY_APP_TIGRIS_QUERY).toContain('query DorkosListAppTigris($appName: String!)');
    expect(FLY_APP_TIGRIS_QUERY).toContain('addOns(type: tigris, first: 50)');
    expect(FLY_APP_NAME_AVAILABLE_QUERY).toContain('appNameAvailable(name: $name)');
    for (const query of [FLY_APP_TIGRIS_QUERY, FLY_APP_NAME_AVAILABLE_QUERY]) {
      expect(query).not.toMatch(/\b(password|environment|ssoLink|metadata|value|digest)\b/u);
    }
  });
});

describe('Fly Tigris name lookup contract', () => {
  // After deleteAddOn Fly renames the bucket, so the old name answers NOT_FOUND (live, 2026-09-30).
  it('reads only the exact not-found answer as free and a clean record as held', () => {
    const notFound = {
      data: { addOn: null },
      errors: [{ message: 'x', path: ['addOn'], extensions: { code: 'NOT_FOUND' } }],
    };
    expect(parseTigrisNameHeldResponse(notFound)).toBe(false);
    expect(parseTigrisNameHeldResponse({ data: { addOn: { id: 'addon_1' } } })).toBe(true);
    for (const bad of [
      { data: { addOn: null } },
      { data: { addOn: null }, errors: [{ path: ['addOn'], extensions: { code: 'INTERNAL' } }] },
      { data: { addOn: { id: 'addon_1' } }, errors: [{ message: 'x' }] },
      { data: null },
    ]) {
      expect(() => parseTigrisNameHeldResponse(bad), JSON.stringify(bad)).toThrow(
        FlyGraphqlContractError
      );
    }
  });

  it('pins a lookup by name that selects only the id', () => {
    expect(FLY_TIGRIS_BY_NAME_QUERY).toContain(
      'query DorkosFindTigrisByName($name: String!, $provider: String!)'
    );
    expect(FLY_TIGRIS_BY_NAME_QUERY).toContain('addOn(name: $name, provider: $provider)');
    expect(FLY_TIGRIS_BY_NAME_QUERY).not.toMatch(/\b(environment|password|options|metadata)\b/u);
  });
});
