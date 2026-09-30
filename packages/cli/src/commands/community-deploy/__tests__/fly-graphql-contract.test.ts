/**
 * @vitest-environment node
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  FLY_APP_PROVENANCE_QUERY,
  FLY_TIGRIS_CREATE_MUTATION,
  FLY_TIGRIS_CREDENTIALS_QUERY,
  FLY_TIGRIS_DELETE_MUTATION,
  FLY_TIGRIS_READ_QUERY,
  FLY_TIGRIS_TERMS_QUERY,
  FlyGraphqlContractError,
  createTigrisVariables,
  parseAppTigrisResponse,
  parseFlyAppProvenanceResponse,
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
    expect(objectAt(read, 'data', 'addOn').options).toBeNull();
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
      objectAt(source, 'data', 'addOn').options = options;
      const check = () => verifyTigrisBinding(parseTigrisReadResponse(source), expectedBinding);
      if (outcome === 'private') expect(check().public, JSON.stringify(options)).toBe(false);
      else
        expect(check, JSON.stringify(options)).toThrowError(
          expect.objectContaining({ code: outcome })
        );
    }
    const missing = await fixture('tigris-read.json');
    delete objectAt(missing, 'data', 'addOn').options;
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
          addOn: {
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
        { data: { addOn: { id: 'addon_fixture_01', environment: null } } },
        'addon_fixture_01'
      )
    ).toBeNull();
    // Only Fly's exact NOT_FOUND answer means missing; a bare null proves nothing.
    expect(() =>
      parseTigrisCredentialsResponse({ data: { addOn: null } }, 'addon_fixture_01')
    ).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(() =>
      parseTigrisCredentialsResponse(
        { data: { addOn: { id: 'addon_other', environment: null } } },
        'addon_fixture_01'
      )
    ).toThrowError(expect.objectContaining({ code: 'BINDING_MISMATCH' }));
    expect(FLY_TIGRIS_CREDENTIALS_QUERY).toContain('environment');
    expect(FLY_TIGRIS_READ_QUERY).not.toContain('environment');
  });

  // Fly soft-deletes: right after cleanup the exact-ID read still returns the bucket, renamed, with
  // status "deleted" and no app (live gate, 2026-09-30, captured and sanitized). Reading that as
  // invalid failed a run whose cleanup had in fact removed everything.
  it("reads Fly's soft-deleted add-on as missing, and nothing looser", async () => {
    const deleted = await fixture('tigris-read-deleted.json');
    expect(() => parseTigrisReadResponse(deleted)).toThrowError(
      expect.objectContaining({ code: 'ADD_ON_MISSING' })
    );
    const variants: Array<[string, (addOn: Record<string, unknown>) => void]> = [
      ['still attached to an app', (addOn) => (addOn.app = { id: 'app_fixture_01', name: 'x' })],
      ['another status', (addOn) => (addOn.status = 'deleting')],
      ['another provider', (addOn) => (addOn.addOnProvider = { name: 'upstash' })],
      ['no status', (addOn) => delete addOn.status],
    ];
    for (const [label, change] of variants) {
      const source = await fixture('tigris-read-deleted.json');
      change(objectAt(source, 'data', 'addOn'));
      // Never "missing": it is either an ordinary add-on (whose renamed identity cleanup then
      // refuses) or an invalid response.
      let code: unknown = null;
      try {
        parseTigrisReadResponse(source);
      } catch (error) {
        code = (error as { code?: unknown }).code;
      }
      expect(code, label).not.toBe('ADD_ON_MISSING');
    }
    // A deleted-looking answer that also carries an error is not the clean answer Fly gives.
    const withError = (await fixture('tigris-read-deleted.json')) as Record<string, unknown>;
    withError.errors = [{ message: 'x', extensions: { code: 'INTERNAL' } }];
    expect(() => parseTigrisReadResponse(withError)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );
  });

  // Fly's real answer for an add-on id it does not know (DOR-2584, captured live and sanitized).
  // Cleanup of a bucket that is already gone depends on reading this as "missing", not "invalid".
  it("reads Fly's exact not-found answer as a missing add-on, and nothing looser", async () => {
    const notFound = await fixture('tigris-read-not-found.json');
    expect(() => parseTigrisReadResponse(notFound)).toThrowError(
      expect.objectContaining({ code: 'ADD_ON_MISSING' })
    );
    expect(() => parseTigrisCredentialsResponse(notFound, 'addon_fixture_missing')).toThrowError(
      expect.objectContaining({ code: 'ADD_ON_MISSING' })
    );
    const variants: Array<[string, (value: Record<string, unknown>) => void]> = [
      [
        'another error beside it',
        (value) => {
          (value.errors as unknown[]).push({ message: 'x', extensions: { code: 'INTERNAL' } });
        },
      ],
      [
        'a different error code',
        (value) => {
          objectAt(value, 'errors', '0', 'extensions').code = 'UNAUTHORIZED';
        },
      ],
      [
        'a different path',
        (value) => {
          objectAt(value, 'errors', '0').path = ['app'];
        },
      ],
      [
        'an add-on beside the error',
        (value) => {
          objectAt(value, 'data').addOn = { id: 'addon_fixture_01' };
        },
      ],
      [
        'no errors at all',
        (value) => {
          value.errors = [];
        },
      ],
    ];
    for (const [label, change] of variants) {
      const source = (await fixture('tigris-read-not-found.json')) as Record<string, unknown>;
      change(source);
      expect(() => parseTigrisReadResponse(source), label).toThrowError(
        expect.objectContaining({ code: 'INVALID_RESPONSE' })
      );
    }
  });

  it('rejects changed types, control characters, excluded fields, and GraphQL errors safely', async () => {
    const wrongType = await fixture('tigris-read.json');
    objectAt(wrongType, 'data', 'addOn').options = { public: 'false' };
    expect(() => parseTigrisReadResponse(wrongType)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );

    const control = await fixture('tigris-read.json');
    objectAt(control, 'data', 'addOn', 'app').name = 'app\u001b[31m';
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
    // A bare `addOn: null` without Fly's NOT_FOUND error once let the gate's cleanup skip a bucket
    // that was still billing (DOR-2584 review); it is an invalid answer, not a missing add-on.
    expect(() => parseTigrisReadResponse({ data: { addOn: null } })).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );
  });

  it("lists an app's buckets only from a complete answer about that app", () => {
    const answer = (name: string, totalCount: number, nodes: unknown[]) => ({
      data: { app: { name, addOns: { totalCount, nodes } } },
    });
    const bucket = { id: 'addon_fixture_01', name: 'community-fixture-bucket' };
    expect(parseAppTigrisResponse(answer('app-a', 1, [bucket]), 'app-a')).toEqual([bucket]);
    expect(parseAppTigrisResponse(answer('app-a', 0, []), 'app-a')).toEqual([]);
    expect(() => parseAppTigrisResponse(answer('app-b', 0, []), 'app-a')).toThrowError(
      expect.objectContaining({ code: 'BINDING_MISMATCH' })
    );
    // A partial page could hide the very bucket cleanup is looking for.
    expect(() => parseAppTigrisResponse(answer('app-a', 2, [bucket]), 'app-a')).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );
    expect(() => parseAppTigrisResponse({ data: { app: null } }, 'app-a')).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
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
    objectAt(source, 'data', 'addOn').options = { public: true };
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
    // Fly has no Relay `node` root field; the live API rejects `node(id:)` outright (DOR-2169).
    expect(FLY_TIGRIS_READ_QUERY).toContain('addOn(id: $id)');
    expect(FLY_TIGRIS_CREDENTIALS_QUERY).toContain('addOn(id: $id)');
    for (const query of [FLY_TIGRIS_READ_QUERY, FLY_TIGRIS_CREDENTIALS_QUERY])
      expect(query).not.toMatch(/\bnode\s*\(/u);
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
      'addOn(id: $id) { id environment }'
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
      'app-provenance.json',
      'app-provenance-missing.json',
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
