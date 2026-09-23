/** Real HTTP owner and private-file proof for a disposable, explicitly armed launch. */
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const ResourceSchema = z.object({ id: z.uuid() });
const SetupSchema = z.object({
  community: ResourceSchema,
  memberId: z.uuid(),
  channelId: z.uuid(),
});
const UploadSchema = z.object({ attachment: ResourceSchema });
const EntrySchema = z.object({ entry: ResourceSchema });

/** Non-secret receipt: no account details, session, message, or attachment contents. */
export interface CommunityLiveOwnerReceipt {
  communityId: string;
  channelId: string;
  entryId: string;
  attachmentId: string;
  ownerCreated: true;
  privateFileRoundTrip: true;
  anonymousDownloadDenied: true;
}

/** A stable failure deliberately excluding server bodies and request credentials. */
export class CommunityLiveProofError extends Error {
  /** Identify the failing operation without recording its request or response. */
  constructor(readonly step: string) {
    super(`Community live proof failed (${step})`);
    this.name = 'CommunityLiveProofError';
  }
}

interface ProofOptions {
  appName: string;
  bootstrapSecret: string;
  signal: AbortSignal;
  /** Injected only by unit tests; the release runner uses real fetch. */
  fetch?: typeof globalThis.fetch;
}

async function boundedBytes(response: Response): Promise<Buffer> {
  if (!response.body) throw new CommunityLiveProofError('response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new CommunityLiveProofError('response-limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/** One pinned origin and an in-memory cookie jar; neither can escape into the receipt. */
class ProofSession {
  private readonly cookies = new Map<string, string>();
  private readonly origin: string;

  constructor(private readonly options: ProofOptions) {
    // The gate never accepts an operator's existing app or an arbitrary URL.
    if (!/^dorkos-gate-[a-f0-9]{12}$/u.test(options.appName)) {
      throw new CommunityLiveProofError('disposable-origin');
    }
    this.origin = `https://${options.appName}.fly.dev`;
  }

  async request(
    path: string,
    init: RequestInit,
    expected: readonly number[],
    options: { anonymous?: boolean } = {}
  ): Promise<Buffer> {
    if (!path.startsWith('/api/') || path.includes('..') || path.includes('?')) {
      throw new CommunityLiveProofError('request-path');
    }
    const headers = new Headers(init.headers);
    headers.set('origin', this.origin);
    if (!options.anonymous && this.cookies.size) {
      headers.set('cookie', [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; '));
    }
    const response = await (this.options.fetch ?? globalThis.fetch)(this.origin + path, {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.any([this.options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    });
    if (!expected.includes(response.status)) {
      await response.body?.cancel();
      throw new CommunityLiveProofError('http-status');
    }
    if (!options.anonymous) this.acceptCookies(response.headers.getSetCookie());
    return boundedBytes(response);
  }

  async json(path: string, body: unknown, status: number): Promise<unknown> {
    const bytes = await this.request(
      path,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      [status]
    );
    try {
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } finally {
      bytes.fill(0);
    }
  }

  private acceptCookies(values: string[]): void {
    if (values.length > 16 || values.join('').length > 16_384) {
      throw new CommunityLiveProofError('cookie-limit');
    }
    for (const value of values) {
      const pair = value.split(';', 1)[0]!;
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator);
      if (separator < 1 || !/^[A-Za-z0-9_.-]+$/u.test(name)) {
        throw new CommunityLiveProofError('cookie-format');
      }
      const content = pair.slice(separator + 1);
      if (!content || /;\s*max-age=0(?:;|$)/iu.test(value)) this.cookies.delete(name);
      else this.cookies.set(name, content);
    }
    if (this.cookies.size > 16) throw new CommunityLiveProofError('cookie-limit');
  }
}

async function createOwner(session: ProofSession, secret: string) {
  await session.json('/api/v1/bootstrap/preflight', { secret }, 200);
  const email = `gate-${randomUUID()}@community-gate.invalid`;
  const password = randomBytes(32).toString('base64url');
  const setup = SetupSchema.parse(
    await session.json(
      '/api/v1/bootstrap/complete',
      {
        secret,
        accountName: 'Release acceptance test',
        email,
        password,
        communityName: 'Disposable release acceptance',
        channelName: 'general',
      },
      201
    )
  );
  await session.json('/api/auth/sign-in/email', { email, password }, 200);
  return setup;
}

async function proveFile(session: ProofSession, setup: z.infer<typeof SetupSchema>) {
  const path = `/api/v1/communities/${setup.community.id}`;
  const content = Buffer.from(`Release acceptance file ${randomUUID()}\n`, 'utf8');
  try {
    const uploaded = await session.request(
      `${path}/channels/${setup.channelId}/attachments`,
      {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          'idempotency-key': randomUUID(),
          'x-file-name': 'acceptance.txt',
          'x-file-size': String(content.byteLength),
        },
        body: new Uint8Array(content),
      },
      [201]
    );
    const attachment = UploadSchema.parse(JSON.parse(uploaded.toString('utf8'))).attachment;
    const entry = EntrySchema.parse(
      await session.json(
        `${path}/channels/${setup.channelId}/entries`,
        {
          text: 'The independently deployed Community server can exchange a message and a private file.',
          idempotencyKey: randomUUID(),
          attachmentIds: [attachment.id],
        },
        201
      )
    ).entry;
    const downloaded = await session.request(`${path}/attachments/${attachment.id}`, {}, [200]);
    try {
      if (!downloaded.equals(content)) throw new CommunityLiveProofError('file-integrity');
    } finally {
      downloaded.fill(0);
    }
    await session.request(`${path}/attachments/${attachment.id}`, {}, [401, 403], {
      anonymous: true,
    });
    return { attachmentId: attachment.id, entryId: entry.id };
  } finally {
    content.fill(0);
  }
}

/**
 * Create an owner through the public setup flow, post a real entry, and prove file privacy.
 * The caller must validate every live-gate arm before calling this network boundary.
 */
export async function runCommunityLiveOwnerProof(
  options: ProofOptions
): Promise<CommunityLiveOwnerReceipt> {
  try {
    const session = new ProofSession(options);
    const setup = await createOwner(session, options.bootstrapSecret);
    const proof = await proveFile(session, setup);
    return {
      communityId: setup.community.id,
      channelId: setup.channelId,
      ...proof,
      ownerCreated: true,
      privateFileRoundTrip: true,
      anonymousDownloadDenied: true,
    };
  } catch (cause) {
    if (cause instanceof CommunityLiveProofError) throw cause;
    // Fetch/Zod/JSON errors can contain URLs, cookies, or server-controlled account data.
    throw new CommunityLiveProofError('owner-or-file');
  }
}
