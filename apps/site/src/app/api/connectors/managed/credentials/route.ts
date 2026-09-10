/** Same-origin signed-in credential completion; field values never enter a local transport. */
import { z } from 'zod';
import { getTransactionDb } from '@/db/transaction-client';
import { getAuth } from '@/lib/auth';
import {
  managedCapabilityAvailability,
  readManagedConnectorConfig,
} from '@/lib/connectors/managed/config';
import { ManagedAuthenticationFlowError } from '@/lib/connectors/managed/authentication-service';
import { createManagedAuthenticationOwnerService } from '@/lib/connectors/managed/authentication-owner-service';
import { MANAGED_AUTHENTICATION_FIELDS_COOKIE } from '@/lib/connectors/managed/authentication-owner-contract';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const MAX_BODY_BYTES = 72 * 1024;
const Body = z
  .object({
    csrfToken: z.string().min(1).max(128),
    descriptorDigest: z.string().regex(/^[a-f0-9]{64}$/),
    fields: z.record(z.string(), z.unknown()),
  })
  .strict();
function reply(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { 'cache-control': 'private, no-store' } });
}
function cookie(request: Request): string | null {
  const values = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${MANAGED_AUTHENTICATION_FIELDS_COOKIE}=`));
  return values.length === 1
    ? values[0].slice(MANAGED_AUTHENTICATION_FIELDS_COOKIE.length + 1)
    : null;
}
async function readBody(request: Request): Promise<unknown> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES))
    throw new Error('Invalid body size.');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing body.');
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]);
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
    rejectAbort(new Error('Body unavailable.'));
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const item = await Promise.race([reader.read(), aborted]);
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error('Body too large.');
      chunks.push(item.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => undefined);
  }
}

/** Authenticate and validate the exact owner flow before one non-retryable credential dispatch. */
export async function POST(request: Request): Promise<Response> {
  const session = await getAuth().api.getSession({ headers: request.headers });
  if (!session) return reply('unauthorized', 401);
  let origin: string;
  try {
    const config = readManagedConnectorConfig();
    if (
      !config.callbackOrigin ||
      managedCapabilityAvailability(config, 'catalog').status !== 'available'
    )
      return reply('account_setup_unavailable', 503);
    origin = new URL(config.callbackOrigin).origin;
  } catch {
    return reply('account_setup_unavailable', 503);
  }
  if (request.headers.get('origin') !== origin) return reply('forbidden', 403);
  if (
    !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') ||
    ![null, 'identity'].includes(request.headers.get('content-encoding'))
  )
    return reply('unsupported_encoding', 415);
  const flowCookie = cookie(request);
  if (!flowCookie) return reply('forbidden', 403);
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await readBody(request));
  } catch {
    return reply('invalid_request', 400);
  }
  try {
    const result = await createManagedAuthenticationOwnerService(getTransactionDb()).completeFields(
      {
        ownerId: session.user.id,
        cookieValue: flowCookie,
        requestOrigin: request.headers.get('origin')!,
        expectedOrigin: origin,
        ...body,
        signal: request.signal,
      }
    );
    return Response.json(result, {
      headers: {
        'cache-control': 'private, no-store',
        'set-cookie': `${MANAGED_AUTHENTICATION_FIELDS_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`,
      },
    });
  } catch (error) {
    // Deliberately do not return or log exception text, upstream envelopes or submitted values.
    return reply(
      'account_setup_unavailable',
      error instanceof ManagedAuthenticationFlowError && error.code === 'forbidden' ? 403 : 503
    );
  }
}
