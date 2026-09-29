/**
 * @vitest-environment node
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FLY_TIGRIS_CREATE_MUTATION,
  FLY_TIGRIS_CREDENTIALS_QUERY,
  FLY_TIGRIS_DELETE_MUTATION,
  FLY_TIGRIS_READ_QUERY,
  FLY_TIGRIS_TERMS_QUERY,
  FlyGraphqlContractError,
  createTigrisVariables,
  parseTigrisCreateResponse,
  parseTigrisCredentialsResponse,
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
    const { identity: created, credentials } = parseTigrisCreateResponse(
      await fixture('tigris-create.json')
    );
    const read = parseTigrisReadResponse(await fixture('tigris-read.json'));
    expect(credentials).toBeNull();
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

  // Fly stores no options for a bucket created without them and answers `options: null`
  // (DOR-2559, live gate on dorkos@0.92.0). That is a private bucket; only an explicit
  // `public: true` is public, and a present `options` without a boolean `public` still fails.
  it('reads null options as private and anything else only by an explicit boolean', async () => {
    const read = await fixture('tigris-read.json');
    expect(objectAt(read, 'data', 'node').options).toBeNull();
    expect(verifyTigrisBinding(parseTigrisReadResponse(read), expectedBinding).public).toBe(false);
    for (const [options, outcome] of [
      [{ public: false }, 'private'],
      [{ public: false, accelerate: false }, 'private'],
      [{ public: true }, 'PUBLIC_BUCKET'],
      [{}, 'INVALID_RESPONSE'],
      [{ public: 'false' }, 'INVALID_RESPONSE'],
      ['{"public":false}', 'INVALID_RESPONSE'],
    ] as const) {
      const source = await fixture('tigris-read.json');
      objectAt(source, 'data', 'node').options = options;
      const check = () => verifyTigrisBinding(parseTigrisReadResponse(source), expectedBinding);
      if (outcome === 'private') expect(check().public, JSON.stringify(options)).toBe(false);
      else
        expect(check, JSON.stringify(options)).toThrowError(
          expect.objectContaining({ code: outcome })
        );
    }
    const missing = await fixture('tigris-read.json');
    delete objectAt(missing, 'data', 'node').options;
    expect(() => parseTigrisReadResponse(missing)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );
  });

  // Fly sets no keys on the app; flyctl copies them from the create answer's `environment`
  // (`setSecretsFromExtension`). The launcher keeps them only in a redacting wrapper.
  it('takes the two access keys from the create answer and never exposes them', async () => {
    const source = await fixture('tigris-create.json');
    objectAt(source, 'data', 'createAddOn', 'addOn').environment = {
      AWS_ACCESS_KEY_ID: 'tid_CANARY_ACCESS',
      AWS_SECRET_ACCESS_KEY: 'tsec_CANARY_SECRET',
      AWS_ENDPOINT_URL_S3: 'https://fly.storage.tigris.dev',
      AWS_REGION: 'auto',
      BUCKET_NAME: 'community-fixture-bucket',
    };
    const { identity, credentials } = parseTigrisCreateResponse(source);
    expect(JSON.stringify(identity)).not.toContain('CANARY');
    expect(String(credentials)).not.toContain('CANARY');
    expect(JSON.stringify({ credentials })).not.toContain('CANARY');
    await expect(credentials!.use(async (values) => ({ ...values }))).resolves.toEqual({
      AWS_ACCESS_KEY_ID: 'tid_CANARY_ACCESS',
      AWS_SECRET_ACCESS_KEY: 'tsec_CANARY_SECRET',
    });
    credentials!.dispose();
    await expect(credentials!.use(async () => true)).rejects.toThrow(FlyGraphqlContractError);
  });

  it('keeps a created bucket certain when its environment is missing or malformed', async () => {
    for (const environment of [
      null,
      {},
      { AWS_ACCESS_KEY_ID: 'tid_only' },
      { AWS_ACCESS_KEY_ID: 'tid_x', AWS_SECRET_ACCESS_KEY: 'line\nbreak' },
      'AWS_ACCESS_KEY_ID=tid_x',
    ]) {
      const source = await fixture('tigris-create.json');
      objectAt(source, 'data', 'createAddOn', 'addOn').environment = environment;
      const result = parseTigrisCreateResponse(source);
      expect(result.identity.addOnId, JSON.stringify(environment)).toBe('addon_fixture_01');
      expect(result.credentials, JSON.stringify(environment)).toBeNull();
    }
  });

  it("reads a bucket's keys by exact ID for a resumed launch, or reports none", async () => {
    const found = parseTigrisCredentialsResponse(
      {
        data: {
          node: {
            id: 'addon_fixture_01',
            environment: { AWS_ACCESS_KEY_ID: 'tid_a', AWS_SECRET_ACCESS_KEY: 'tsec_b' },
          },
        },
      },
      'addon_fixture_01'
    );
    await expect(found!.use(async (values) => values.AWS_ACCESS_KEY_ID)).resolves.toBe('tid_a');
    expect(
      parseTigrisCredentialsResponse(
        { data: { node: { id: 'addon_fixture_01', environment: null } } },
        'addon_fixture_01'
      )
    ).toBeNull();
    expect(() =>
      parseTigrisCredentialsResponse({ data: { node: null } }, 'addon_fixture_01')
    ).toThrowError(expect.objectContaining({ code: 'ADD_ON_MISSING' }));
    expect(() =>
      parseTigrisCredentialsResponse(
        { data: { node: { id: 'addon_other', environment: null } } },
        'addon_fixture_01'
      )
    ).toThrowError(expect.objectContaining({ code: 'BINDING_MISMATCH' }));
    expect(FLY_TIGRIS_CREDENTIALS_QUERY).toContain('environment');
    expect(FLY_TIGRIS_READ_QUERY).not.toContain('environment');
  });

  it('rejects changed types, control characters, excluded fields, and GraphQL errors safely', async () => {
    const wrongType = await fixture('tigris-read.json');
    objectAt(wrongType, 'data', 'node').options = { public: 'false' };
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
    objectAt(source, 'data', 'node').options = { public: true };
    expect(() =>
      verifyTigrisBinding(parseTigrisReadResponse(source), expectedBinding)
    ).toThrowError(expect.objectContaining({ code: 'PUBLIC_BUCKET' }));

    const { identity } = parseTigrisCreateResponse(await fixture('tigris-create.json'));
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
    expect(FLY_TIGRIS_READ_QUERY).not.toMatch(
      /\b(password|environment|ssoLink|errorMessage|metadata|publicUrl)\b/u
    );
    // The create answer is the one place Fly hands out the bucket's keys (as flyctl reads them),
    // so `environment` is the only sensitive field it selects.
    expect(FLY_TIGRIS_CREATE_MUTATION).toMatch(/\benvironment\b/u);
    expect(FLY_TIGRIS_CREATE_MUTATION).not.toMatch(
      /\b(password|ssoLink|errorMessage|metadata|publicUrl)\b/u
    );
    expect(FLY_TIGRIS_CREDENTIALS_QUERY.replace(/\s+/gu, ' ')).toContain(
      '... on AddOn { id environment }'
    );
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
