/**
 * Which image digest Fly will report for the attested Community release.
 *
 * The signed release manifest pins the Community image by its multi-platform OCI index digest,
 * and that is the digest the image attestation covers. `fly deploy --image repo@<index>` accepts
 * the index, but the Machine runs, and Fly reports in both the Machine's `image_ref.digest` and the
 * release's `ImageRef`, the one linux/amd64 manifest inside it, never the index (live gate on
 * 0.92.0, DOR-2586). So a deploy is proven against that manifest's digest.
 *
 * Newer release manifests carry each platform's digest themselves, covered by the manifest's own
 * attestation. For manifests without them (0.92.0 and earlier) the index is read anonymously from
 * ghcr.io, and trusted only because it is content-addressed: its bytes must hash to exactly the
 * attested index digest, so the manifest list read is the one the attestation covers.
 *
 * @module commands/community-deploy/runtime/image-platform
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ProviderMutationError } from '../provider-mutation.js';

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const INDEX_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const MANIFEST_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
/** Registries the index may be read from. Anything else is refused before any request. */
const REGISTRY_ALLOW_LIST: ReadonlySet<string> = new Set(['ghcr.io']);
/** The real 0.92.0 index is 1.6 KB; an index anywhere near this is not ours. */
const MAX_INDEX_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;

const IndexDocumentSchema = z
  .object({
    mediaType: z.string().optional(),
    manifests: z
      .array(
        z
          .object({
            mediaType: z.string().optional(),
            digest: Sha256DigestSchema,
            platform: z
              .object({ os: z.string(), architecture: z.string() })
              .passthrough()
              .optional(),
            annotations: z.record(z.string(), z.string()).optional(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

/** The platform Fly Machines run. */
export const FLY_MACHINE_PLATFORM = { os: 'linux', architecture: 'amd64' } as const;

function invalid(): ProviderMutationError {
  return new ProviderMutationError('INVALID_RESPONSE');
}

/**
 * Pick the platform manifest out of attested index (or manifest) bytes.
 *
 * @param bytes - The exact bytes the registry served for `attestedDigest`.
 * @param headerMediaType - The response's content type, without parameters, or null.
 * @param attestedDigest - The digest the release attestation covers.
 * @param platform - The platform to select; defaults to {@link FLY_MACHINE_PLATFORM}.
 * @returns The one matching manifest's digest; a single-platform manifest returns itself.
 * @throws ProviderMutationError(INVALID_RESPONSE) unless the bytes hash to `attestedDigest` and
 *   hold exactly one non-attestation manifest for the platform.
 */
export function selectPlatformDigest(
  bytes: Uint8Array,
  headerMediaType: string | null,
  attestedDigest: string,
  platform: { os: string; architecture: string } = FLY_MACHINE_PLATFORM
): string {
  if (!Sha256DigestSchema.safeParse(attestedDigest).success) throw invalid();
  if (bytes.byteLength > MAX_INDEX_BYTES) throw invalid();
  if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== attestedDigest) {
    throw invalid();
  }
  let document: z.infer<typeof IndexDocumentSchema>;
  try {
    document = IndexDocumentSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch {
    throw invalid();
  }
  // The body's own media type is covered by the digest; the header is not. When both exist they
  // must agree, and the body wins.
  if (headerMediaType && document.mediaType && headerMediaType !== document.mediaType) {
    throw invalid();
  }
  const mediaType = document.mediaType ?? headerMediaType ?? '';
  if (MANIFEST_MEDIA_TYPES.has(mediaType)) return attestedDigest;
  if (!INDEX_MEDIA_TYPES.has(mediaType)) throw invalid();
  const candidates = (document.manifests ?? []).filter(
    (entry) =>
      entry.platform?.os === platform.os &&
      entry.platform.architecture === platform.architecture &&
      // Buildx adds one attestation manifest per image, marked `unknown/unknown`; never pick one.
      entry.annotations?.['vnd.docker.reference.type'] === undefined &&
      // A nested index would need a second hop the attestation does not cover.
      (entry.mediaType === undefined || MANIFEST_MEDIA_TYPES.has(entry.mediaType))
  );
  if (candidates.length !== 1 || candidates[0]!.digest === attestedDigest) throw invalid();
  return candidates[0]!.digest;
}

async function readBounded(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > max) throw invalid();
  if (!response.body) throw invalid();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) {
        void reader.cancel().catch(() => undefined);
        throw invalid();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

/** Inputs for one exact index-to-platform resolution. */
export interface ResolvePlatformImageInput {
  /** Image repository including registry host, such as `ghcr.io/dork-labs/dorkos-community`. */
  repository: string;
  /** Attested digest from the signed release manifest. */
  digest: string;
  /** Platform to select; defaults to {@link FLY_MACHINE_PLATFORM}. */
  platform?: { os: string; architecture: string };
  /** Deadline for the whole resolution. */
  timeoutMs: number;
  /** Operator cancellation. */
  signal?: AbortSignal;
  /** Injected fetch for tests and the offline package proof. */
  fetch?: typeof fetch;
}

/**
 * Read the attested index from the registry and return the platform digest Fly will report.
 *
 * @param input - Repository, attested digest, and bounds.
 * @returns The platform manifest digest.
 * @throws ProviderMutationError: PROVIDER_UNAVAILABLE when the registry cannot be reached in time,
 *   INVALID_RESPONSE for anything the registry says that does not prove the mapping.
 */
export async function resolvePlatformImageDigest(
  input: ResolvePlatformImageInput
): Promise<string> {
  const match = /^([a-z0-9.-]+)\/([a-z0-9._-]+\/[a-z0-9._/-]+)$/u.exec(input.repository);
  if (
    !match ||
    !REGISTRY_ALLOW_LIST.has(match[1]!) ||
    !Sha256DigestSchema.safeParse(input.digest).success
  ) {
    throw invalid();
  }
  const [, host, path] = match as unknown as [string, string, string];
  const request = input.fetch ?? fetch;
  const signal = AbortSignal.any([
    AbortSignal.timeout(input.timeoutMs),
    ...(input.signal ? [input.signal] : []),
  ]);
  let bytes: Uint8Array;
  let mediaType: string | null;
  try {
    // Anonymous pull token: the Community image is public, so no credential is read or sent.
    const tokenResponse = await request(
      `https://${host}/token?scope=${encodeURIComponent(`repository:${path}:pull`)}&service=${host}`,
      { signal, redirect: 'error' }
    );
    if (!tokenResponse.ok) throw invalid();
    const token = z
      .object({ token: z.string().min(1).max(8192) })
      .passthrough()
      .parse(
        JSON.parse(Buffer.from(await readBounded(tokenResponse, MAX_TOKEN_BYTES)).toString('utf8'))
      ).token;
    const response = await request(`https://${host}/v2/${path}/manifests/${input.digest}`, {
      signal,
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        accept: [...INDEX_MEDIA_TYPES, ...MANIFEST_MEDIA_TYPES].join(', '),
      },
    });
    if (!response.ok) throw invalid();
    bytes = await readBounded(response, MAX_INDEX_BYTES);
    mediaType = response.headers.get('content-type')?.split(';')[0]?.trim() || null;
  } catch (error) {
    if (error instanceof ProviderMutationError) throw error;
    // A malformed answer is not a reachability problem; only transport failures are transient.
    if (error instanceof z.ZodError || error instanceof SyntaxError) throw invalid();
    throw new ProviderMutationError('PROVIDER_UNAVAILABLE');
  }
  return selectPlatformDigest(bytes, mediaType, input.digest, input.platform);
}
