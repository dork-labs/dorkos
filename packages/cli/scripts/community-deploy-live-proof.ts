/** Real HTTP owner, private-file and second-member proof for a disposable, explicitly armed launch. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CommunityWireAuthOptionsSchema } from '@dorkos/shared/community-wire';

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
const InviteSchema = z.object({ token: z.string().min(1).max(4096) });
const RedeemSchema = z.object({ memberId: z.uuid() });
const ReplySchema = z.object({
  entry: z.object({ id: z.uuid(), parentEntryId: z.uuid().nullable() }),
});
const EntryPageSchema = z.object({
  entries: z.array(z.object({ id: z.uuid(), parentEntryId: z.uuid().nullable().optional() })),
});

/** Non-secret receipt: no account details, session, message, or attachment contents. */
export interface CommunityLiveOwnerReceipt {
  communityId: string;
  channelId: string;
  entryId: string;
  attachmentId: string;
  ownerCreated: true;
  privateFileRoundTrip: true;
  anonymousDownloadDenied: true;
  /** The new Community's sign-in page offers no single sign-on, so no DorkOS sign-in (DOR-2593). */
  singleSignOnOffered: false;
}

/** A stable failure deliberately excluding server bodies and request credentials. */
export class CommunityLiveProofError extends Error {
  /** Identify the failing operation without recording its request or response. */
  constructor(readonly step: string) {
    super(`Community live proof failed (${step})`);
    this.name = 'CommunityLiveProofError';
  }
}

/**
 * Fail unless a Community's `GET /api/v1/auth-options` answer offers no single sign-on. A
 * launcher-made Community signs people in with its own accounts; an `oidc` entry would mean it
 * sends them to some other sign-in, which is how a DorkOS sign-in would arrive. Shared by the
 * offline package proof (against the real route) and the live gate (against the new Community).
 *
 * @param body - The parsed response body.
 * @throws {CommunityLiveProofError} `auth-options` when the body is not the wire shape, and
 *   `single-sign-on` when it offers single sign-on.
 */
export function assertNoSingleSignOn(body: unknown): void {
  const parsed = CommunityWireAuthOptionsSchema.safeParse(body);
  if (!parsed.success) throw new CommunityLiveProofError('auth-options');
  if (parsed.data.oidc !== null) throw new CommunityLiveProofError('single-sign-on');
}

interface ProofOptions {
  appName: string;
  bootstrapSecret: string;
  signal: AbortSignal;
  /** Injected only by unit tests; the release runner uses real fetch. */
  fetch?: typeof globalThis.fetch;
}

/** One account on the proven community. Held in memory only; never part of a receipt. */
export interface CommunityLiveAccount {
  email: string;
  password: string;
}

/**
 * What the owner proof leaves for the second-member proof: the owner's signed-in session and what
 * the owner posted. It carries the owner's password, so it is kept apart from the receipt.
 */
export interface CommunityLiveOwner {
  /** The owner's signed-in session, pinned to the disposable origin. */
  readonly session: ProofSession;
  readonly account: CommunityLiveAccount;
  readonly communityId: string;
  readonly channelId: string;
  readonly entryId: string;
  readonly attachmentId: string;
  /** The sha256 of the private file's bytes; the bytes themselves are wiped. */
  readonly fileSha256: string;
}

/** The owner proof's result: a non-secret receipt, and the owner kept apart from it. */
export interface CommunityLiveOwnerProof {
  receipt: CommunityLiveOwnerReceipt;
  owner: CommunityLiveOwner;
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
export class ProofSession {
  private readonly cookies = new Map<string, string>();
  /** The disposable community's https origin. */
  readonly origin: string;

  /** Pin a session to the disposable app's origin, refusing any other app before a request. */
  constructor(private readonly options: Pick<ProofOptions, 'appName' | 'signal' | 'fetch'>) {
    // The gate never accepts an operator's existing app or an arbitrary URL.
    if (!/^dorkos-gate-[a-f0-9]{12}$/u.test(options.appName)) {
      throw new CommunityLiveProofError('disposable-origin');
    }
    this.origin = `https://${options.appName}.fly.dev`;
  }

  /** Send one request to the pinned origin and return its bounded body. */
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

  /** POST a JSON body and parse the JSON answer. */
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
  return { setup, account: { email, password } };
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
    return {
      attachmentId: attachment.id,
      entryId: entry.id,
      fileSha256: createHash('sha256').update(content).digest('hex'),
    };
  } finally {
    content.fill(0);
  }
}

/**
 * Create an owner through the public setup flow, post a real entry, and prove file privacy.
 * The caller must validate every live-gate arm before calling this network boundary.
 *
 * @returns The non-secret receipt, and the owner's session and account for the second-member
 *   proof, which must never be written into the receipt.
 */
export async function runCommunityLiveOwnerProof(
  options: ProofOptions
): Promise<CommunityLiveOwnerProof> {
  try {
    const session = new ProofSession(options);
    // Read before anyone signs in, as a visitor's sign-in page does.
    const authOptions = await session.request('/api/v1/auth-options', {}, [200], {
      anonymous: true,
    });
    let authOptionsBody: unknown;
    try {
      authOptionsBody = JSON.parse(authOptions.toString('utf8'));
    } catch {
      throw new CommunityLiveProofError('auth-options');
    }
    assertNoSingleSignOn(authOptionsBody);
    const { setup, account } = await createOwner(session, options.bootstrapSecret);
    const { fileSha256, ...proof } = await proveFile(session, setup);
    return {
      receipt: {
        communityId: setup.community.id,
        channelId: setup.channelId,
        ...proof,
        ownerCreated: true,
        privateFileRoundTrip: true,
        anonymousDownloadDenied: true,
        singleSignOnOffered: false,
      },
      owner: {
        session,
        account,
        communityId: setup.community.id,
        channelId: setup.channelId,
        entryId: proof.entryId,
        attachmentId: proof.attachmentId,
        fileSha256,
      },
    };
  } catch (cause) {
    if (cause instanceof CommunityLiveProofError) throw cause;
    // Fetch/Zod/JSON errors can contain URLs, cookies, or server-controlled account data.
    throw new CommunityLiveProofError('owner-or-file');
  }
}

/** Non-secret receipt fields the second-member proof adds: ids and a flag only. */
export interface CommunityLiveSecondMemberReceipt {
  secondMemberId: string;
  secondMemberReplyEntryId: string;
  secondMemberProof: true;
}

/** Everything a person needs to use the proven community as its owner or its second member. */
export interface CommunityLiveAccess {
  /** The community's https origin. */
  origin: string;
  communityId: string;
  /** The channel both people are in. */
  channelId: string;
  owner: CommunityLiveAccount;
  member: CommunityLiveAccount;
  /** The one-time invitation the member joined with; already used up. */
  inviteLink: string;
}

/** The second-member proof's result: a non-secret receipt, and the access kept apart from it. */
export interface CommunityLiveSecondMemberProof {
  receipt: CommunityLiveSecondMemberReceipt;
  access: CommunityLiveAccess;
}

/**
 * Prove a second person can join and use the community through its public HTTP contract only.
 *
 * As the owner, issue a one-seat invitation to the proven channel. As a new, anonymous browser,
 * open it and sign up a fresh account; that signed-in account must be refused the owner's private
 * file until it has joined. Then it binds and redeems. As that member: read the channel and
 * find the owner's post, reply to it in a thread, and download the owner's private file with the
 * same sha256 the owner uploaded. Last, an anonymous download of that file must still be refused,
 * so admitting a member did not open the file to everyone.
 *
 * @param owner - The owner proof's session and what it posted.
 * @param options - The disposable app, an abort signal (Control-C aborts it), and a test fetch.
 * @returns The non-secret receipt, and the owner's and member's access for an attended hold.
 * @throws CommunityLiveProofError naming only the failing step; never a server body or credential.
 */
export async function runCommunityLiveSecondMemberProof(
  owner: CommunityLiveOwner,
  options: Pick<ProofOptions, 'appName' | 'signal' | 'fetch'>
): Promise<CommunityLiveSecondMemberProof> {
  const path = `/api/v1/communities/${owner.communityId}`;
  let step = 'member-invite';
  try {
    const invite = InviteSchema.parse(
      await owner.session.json(
        `${path}/invites`,
        { channelId: owner.channelId, seats: 1, expiresInDays: 1 },
        201
      )
    );
    // The link a person would be sent; the member below uses its token exactly as the join page does.
    const inviteLink = `${owner.session.origin}/c/${owner.communityId}/join#invite=${encodeURIComponent(invite.token)}`;
    const member = new ProofSession(options);
    step = 'member-join';
    await member.json(`${path}/invites/preflight`, { token: invite.token }, 200);
    const account = {
      email: `gate-member-${randomUUID()}@community-gate.invalid`,
      password: randomBytes(32).toString('base64url'),
    };
    await member.json(
      '/api/auth/sign-up/email',
      { name: 'Second acceptance member', ...account },
      200
    );
    // Signed in but not yet a member: an account alone must not open the private file.
    step = 'non-member-download';
    await member.request(`${path}/attachments/${owner.attachmentId}`, {}, [401, 403]);
    step = 'member-join';
    await member.json(`${path}/invites/bind`, {}, 200);
    const { memberId } = RedeemSchema.parse(await member.json(`${path}/invites/redeem`, {}, 200));
    step = 'member-read';
    const page = await member.request(`${path}/channels/${owner.channelId}/entries`, {}, [200]);
    const { entries } = EntryPageSchema.parse(JSON.parse(page.toString('utf8')));
    page.fill(0);
    if (!entries.some((entry) => entry.id === owner.entryId))
      throw new CommunityLiveProofError('member-read');
    step = 'member-reply';
    const reply = ReplySchema.parse(
      await member.json(
        `${path}/channels/${owner.channelId}/entries`,
        {
          text: 'A second person joined with an invitation and can reply.',
          idempotencyKey: randomUUID(),
          parentEntryId: owner.entryId,
        },
        201
      )
    ).entry;
    // The reply must land in the owner's thread, not as a new top-level post.
    if (reply.parentEntryId !== owner.entryId) throw new CommunityLiveProofError('member-reply');
    step = 'member-file';
    const downloaded = await member.request(`${path}/attachments/${owner.attachmentId}`, {}, [200]);
    try {
      if (createHash('sha256').update(downloaded).digest('hex') !== owner.fileSha256)
        throw new CommunityLiveProofError('member-file-integrity');
    } finally {
      downloaded.fill(0);
    }
    step = 'member-anonymous-download';
    await member.request(`${path}/attachments/${owner.attachmentId}`, {}, [401, 403], {
      anonymous: true,
    });
    return {
      receipt: {
        secondMemberId: memberId,
        secondMemberReplyEntryId: reply.id,
        secondMemberProof: true,
      },
      access: {
        origin: owner.session.origin,
        communityId: owner.communityId,
        channelId: owner.channelId,
        owner: owner.account,
        member: account,
        inviteLink,
      },
    };
  } catch (cause) {
    if (cause instanceof CommunityLiveProofError && cause.step !== 'http-status') throw cause;
    // Name the step, never the cause: fetch, Zod and JSON errors can carry URLs, cookies, the
    // invitation or server-controlled account data.
    throw new CommunityLiveProofError(step);
  }
}
