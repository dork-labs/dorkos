/** @vitest-environment node */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { resolvePlatformImageDigest, selectPlatformDigest } from '../runtime/image-platform.js';
import { resolveCommunityPlatformDigest } from '../runtime/default-deploy.js';
import { createLaunchPlan } from '../plan.js';

// The real, unmodified 0.92.0 index served by ghcr.io. It is kept as `.oci` (and `-text` in
// .gitattributes) so no formatter or checkout rewrites a byte: its sha256 IS the attested digest.
const INDEX_DIGEST = 'sha256:b6d5f2b93365c88200bd7b6cd310d2e6c6ea02f7933009e218984a00f1de9b14';
const AMD64_DIGEST = 'sha256:6f4f88ac5042746b6976c51270405a327fe863d12027db44099d8b44738359f3';
const REPOSITORY = 'ghcr.io/dork-labs/dorkos-community';
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';

async function realIndex(): Promise<Buffer> {
  return readFile(new URL('./fixtures/ghcr/community-0.92.0-index.oci', import.meta.url));
}

const digestOf = (bytes: Uint8Array) =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function registry(body: Uint8Array, contentType: string | null = OCI_INDEX) {
  return vi.fn(async (url: string | URL) =>
    String(url).includes('/token?')
      ? new Response(JSON.stringify({ token: 'anonymous-pull' }), { status: 200 })
      : new Response(new Uint8Array(body), {
          status: 200,
          headers: contentType ? { 'content-type': contentType } : {},
        })
  );
}

function index(manifests: unknown[]): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests }));
}

describe('selectPlatformDigest', () => {
  it('maps the real attested 0.92.0 index to the linux/amd64 manifest Fly reports', async () => {
    const bytes = await realIndex();
    expect(digestOf(bytes)).toBe(INDEX_DIGEST);
    expect(selectPlatformDigest(bytes, OCI_INDEX, INDEX_DIGEST)).toBe(AMD64_DIGEST);
    // The body says what it is, and the body is what the digest covers.
    expect(selectPlatformDigest(bytes, null, INDEX_DIGEST)).toBe(AMD64_DIGEST);
  });

  it('refuses bytes that do not hash to the attested digest, even by one byte', async () => {
    const tampered = Buffer.from((await realIndex()).toString('utf8').replace('amd64', 'arm64'));
    expect(() => selectPlatformDigest(tampered, OCI_INDEX, INDEX_DIGEST)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );
    const appended = Buffer.concat([await realIndex(), Buffer.from(' ')]);
    expect(() => selectPlatformDigest(appended, OCI_INDEX, INDEX_DIGEST)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );
  });

  it('returns a single-platform manifest unchanged', () => {
    const body = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: OCI_MANIFEST }));
    expect(selectPlatformDigest(body, OCI_MANIFEST, digestOf(body))).toBe(digestOf(body));
  });

  it.each([
    [
      'no linux/amd64 entry',
      [{ digest: AMD64_DIGEST, platform: { os: 'linux', architecture: 'arm64' } }],
    ],
    [
      'two linux/amd64 entries',
      [
        { digest: AMD64_DIGEST, platform: { os: 'linux', architecture: 'amd64' } },
        { digest: `sha256:${'e'.repeat(64)}`, platform: { os: 'linux', architecture: 'amd64' } },
      ],
    ],
    [
      'only an attestation entry for linux/amd64',
      [
        {
          digest: AMD64_DIGEST,
          platform: { os: 'linux', architecture: 'amd64' },
          annotations: { 'vnd.docker.reference.type': 'attestation-manifest' },
        },
      ],
    ],
    [
      'a nested index for linux/amd64',
      [
        {
          digest: AMD64_DIGEST,
          mediaType: OCI_INDEX,
          platform: { os: 'linux', architecture: 'amd64' },
        },
      ],
    ],
  ])('refuses an index with %s', (_label, manifests) => {
    const body = index(manifests);
    expect(() => selectPlatformDigest(body, OCI_INDEX, digestOf(body))).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );
  });

  it('refuses a header that contradicts the body, and an unknown media type', async () => {
    const bytes = await realIndex();
    expect(() => selectPlatformDigest(bytes, OCI_MANIFEST, INDEX_DIGEST)).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );
    const body = Buffer.from(JSON.stringify({ schemaVersion: 2 }));
    expect(() => selectPlatformDigest(body, 'text/plain', digestOf(body))).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' })
    );
  });
});

describe('resolvePlatformImageDigest', () => {
  it('reads the index anonymously from ghcr.io by the attested digest', async () => {
    const fetch = registry(await realIndex());
    await expect(
      resolvePlatformImageDigest({
        repository: REPOSITORY,
        digest: INDEX_DIGEST,
        timeoutMs: 1_000,
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
    ).resolves.toBe(AMD64_DIGEST);
    expect(String(fetch.mock.calls[0]![0])).toBe(
      'https://ghcr.io/token?scope=repository%3Adork-labs%2Fdorkos-community%3Apull&service=ghcr.io'
    );
    expect(String(fetch.mock.calls[1]![0])).toBe(
      `https://ghcr.io/v2/dork-labs/dorkos-community/manifests/${INDEX_DIGEST}`
    );
  });

  it('refuses any registry but ghcr.io before sending a request', async () => {
    const fetch = registry(await realIndex());
    for (const repository of [
      'docker.io/dork-labs/dorkos-community',
      'ghcr.io.evil.test/x/y',
      'ghcr.io',
    ]) {
      await expect(
        resolvePlatformImageDigest({
          repository,
          digest: INDEX_DIGEST,
          timeoutMs: 1_000,
          fetch: fetch as unknown as typeof globalThis.fetch,
        })
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses an oversized answer without reading all of it', async () => {
    const huge = Buffer.alloc(70 * 1024, 32);
    await expect(
      resolvePlatformImageDigest({
        repository: REPOSITORY,
        digest: INDEX_DIGEST,
        timeoutMs: 1_000,
        fetch: registry(huge) as unknown as typeof globalThis.fetch,
      })
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('reports an unreachable or slow registry as unavailable, not invalid', async () => {
    const unreachable = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      resolvePlatformImageDigest({
        repository: REPOSITORY,
        digest: INDEX_DIGEST,
        timeoutMs: 1_000,
        fetch: unreachable as unknown as typeof globalThis.fetch,
      })
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    const slow = vi.fn(
      (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))
        )
    );
    await expect(
      resolvePlatformImageDigest({
        repository: REPOSITORY,
        digest: INDEX_DIGEST,
        timeoutMs: 20,
        fetch: slow as unknown as typeof globalThis.fetch,
      })
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  });
});

describe('resolveCommunityPlatformDigest', () => {
  const plan = createLaunchPlan({
    dorkosVersion: '0.92.0',
    imageDigest: INDEX_DIGEST,
    fly: {
      organizationId: 'dork-labs',
      organizationName: 'Dork Labs',
      appName: 'dorkos-community-test',
      region: 'ord',
      machineSize: 'shared-cpu-1x',
    },
    neon: {
      organizationId: 'org-dorian',
      organizationName: 'Dorian',
      projectName: 'dorkos-community-test',
      region: 'aws-us-east-2',
    },
    tigris: { bucketName: 'dorkos-community-test', private: true },
  });
  const options = {
    fly: { executable: 'fly', env: {}, timeoutMs: 1_000 },
    neon: { executable: 'neonctl', env: {}, timeoutMs: 1_000 },
    graphqlTimeoutMs: 1_000,
  };
  const release = (platforms: Array<{ os: string; architecture: string; digest?: string }>) => ({
    dorkosVersion: '0.92.0',
    image: { repository: REPOSITORY, digest: INDEX_DIGEST, platforms },
    provenance: { repository: 'dork-labs/dorkos', workflowRef: 'x' },
    configSchemaVersion: 1,
    migrationCompatibilityId: `sha256:${'b'.repeat(64)}`,
    minimumFlyctlVersion: '0.4.104',
    minimumNeonCliVersion: '5.0.0',
  });

  it('uses the digest a newer attested manifest carries, without reading the registry', async () => {
    const fetch = vi.fn();
    await expect(
      resolveCommunityPlatformDigest({
        release: release([
          { os: 'linux', architecture: 'amd64', digest: AMD64_DIGEST },
          { os: 'linux', architecture: 'arm64', digest: `sha256:${'d'.repeat(64)}` },
        ]),
        plan,
        options,
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
    ).resolves.toBe(AMD64_DIGEST);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads the registry for a 0.92.0 manifest, which carries no platform digests', async () => {
    const fetch = registry(await realIndex());
    await expect(
      resolveCommunityPlatformDigest({
        release: release([
          { os: 'linux', architecture: 'amd64' },
          { os: 'linux', architecture: 'arm64' },
        ]),
        plan,
        options,
        fetch: fetch as unknown as typeof globalThis.fetch,
      })
    ).resolves.toBe(AMD64_DIGEST);
  });

  it('refuses a release whose index is not the one the plan deploys', async () => {
    await expect(
      resolveCommunityPlatformDigest({
        release: {
          ...release([]),
          image: { repository: REPOSITORY, digest: `sha256:${'0'.repeat(64)}`, platforms: [] },
        },
        plan,
        options,
        fetch: vi.fn() as unknown as typeof globalThis.fetch,
      })
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
