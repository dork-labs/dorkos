/**
 * Signed-token minting/verification for the workbench embedded browser
 * (DOR-216, DOR-1260; ADRs 260708-185519 and 260817-152705).
 *
 * Neither kind of preview can use the API's cookie/header auth, for two
 * different reasons, and one short-lived signed token covers both:
 *
 * - **`serve`** renders local HTML in an opaque-origin sandbox (no
 *   `allow-same-origin`) — a frame that carries no credentials at all. The token
 *   travels in the URL path and authorizes each request on its own.
 * - **`proxy`** renders a dev server on a preview listener of its own
 *   (`preview-listener.ts`), a separate port that is not the API and shares none
 *   of its middleware. The token arrives once in the bootstrap URL's query, is
 *   moved straight into an `HttpOnly` cookie, and authorizes that listener —
 *   that listener only, because the scope names the target port and the cookie
 *   is named for the listen port.
 *
 * Tokens are an HMAC over a compact, scope-bound payload (a cwd for `serve`, a
 * port for `proxy`) plus an expiry. Verification is constant-time and rejects
 * tampered or expired tokens.
 *
 * The signing secret is process-random by default (a server restart invalidates
 * outstanding tokens — acceptable for a short-lived, re-mintable URL). Tests pass
 * a fixed secret for determinism.
 *
 * @module services/workbench-serve/token
 */
import crypto from 'crypto';
import { WORKBENCH } from '../../config/constants.js';

/** The scope a signed token authorizes. Discriminated on `kind`. */
export type WorkbenchTokenScope = { kind: 'serve'; cwd: string } | { kind: 'proxy'; port: number };

/** A verified token payload: its scope plus the absolute expiry (epoch ms). */
export interface WorkbenchTokenPayload {
  scope: WorkbenchTokenScope;
  /** Absolute expiry, epoch milliseconds. */
  exp: number;
}

/** Why {@link WorkbenchTokenSigner.verify} rejected a token. */
export type WorkbenchTokenErrorCode = 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED';

/** Thrown by {@link WorkbenchTokenSigner.verify} when a token is invalid. */
export class WorkbenchTokenError extends Error {
  readonly code: WorkbenchTokenErrorCode;

  constructor(code: WorkbenchTokenErrorCode, message: string) {
    super(message);
    this.name = 'WorkbenchTokenError';
    this.code = code;
  }
}

/** Base64url-encode a buffer (no padding), for compact URL-safe tokens. */
function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/**
 * Mints and verifies HMAC-signed, short-lived tokens for the workbench
 * serve/proxy routes. A single instance is shared per process (see the exported
 * singleton); construct a fresh one with a fixed secret in tests.
 */
export class WorkbenchTokenSigner {
  readonly #secret: Buffer;
  readonly #ttlMs: number;

  /**
   * Create a signer with an optional fixed secret and TTL.
   *
   * @param options - `secret` overrides the process-random signing key (tests
   *   pass a fixed one); `ttlMs` overrides the default token lifetime.
   */
  constructor(options?: { secret?: string | Buffer; ttlMs?: number }) {
    this.#secret =
      options?.secret !== undefined ? Buffer.from(options.secret) : crypto.randomBytes(32);
    this.#ttlMs = options?.ttlMs ?? WORKBENCH.SIGNED_URL_TTL_MS;
  }

  /** HMAC-SHA256 of the encoded payload, as a raw buffer. */
  #sign(encodedPayload: string): Buffer {
    return crypto.createHmac('sha256', this.#secret).update(encodedPayload).digest();
  }

  /**
   * Mint a signed token for `scope`, expiring `ttlMs` from now.
   *
   * @param scope - The serve/proxy scope the token authorizes.
   * @param now - Current epoch ms (injectable for tests); defaults to `Date.now()`.
   * @returns A URL-safe `payload.signature` token string.
   */
  mint(scope: WorkbenchTokenScope, now: number = Date.now()): string {
    const payload: WorkbenchTokenPayload = { scope, exp: now + this.#ttlMs };
    const encoded = base64url(Buffer.from(JSON.stringify(payload)));
    const sig = base64url(this.#sign(encoded));
    return `${encoded}.${sig}`;
  }

  /**
   * Verify a token and return its payload, or throw {@link WorkbenchTokenError}.
   * Checks the signature in constant time before the expiry, so a tampered token
   * never reveals timing about the secret.
   *
   * @param token - The `payload.signature` token from the URL path.
   * @param now - Current epoch ms (injectable for tests); defaults to `Date.now()`.
   * @throws WorkbenchTokenError `MALFORMED` (shape), `BAD_SIGNATURE` (forged), or `EXPIRED`.
   */
  verify(token: string, now: number = Date.now()): WorkbenchTokenPayload {
    const dot = token.indexOf('.');
    if (dot <= 0 || dot === token.length - 1) {
      throw new WorkbenchTokenError('MALFORMED', 'Token is not well-formed');
    }
    const encoded = token.slice(0, dot);
    const providedSig = token.slice(dot + 1);

    const expectedSig = this.#sign(encoded);
    let providedSigBuf: Buffer;
    try {
      providedSigBuf = Buffer.from(providedSig, 'base64url');
    } catch {
      throw new WorkbenchTokenError('BAD_SIGNATURE', 'Signature is not decodable');
    }
    if (
      providedSigBuf.length !== expectedSig.length ||
      !crypto.timingSafeEqual(providedSigBuf, expectedSig)
    ) {
      throw new WorkbenchTokenError('BAD_SIGNATURE', 'Signature does not match');
    }

    let payload: WorkbenchTokenPayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    } catch {
      throw new WorkbenchTokenError('MALFORMED', 'Payload is not valid JSON');
    }
    if (!payload || typeof payload.exp !== 'number' || !payload.scope) {
      throw new WorkbenchTokenError('MALFORMED', 'Payload is missing fields');
    }
    if (now >= payload.exp) {
      throw new WorkbenchTokenError('EXPIRED', 'Token has expired');
    }
    return payload;
  }
}

/**
 * The process-wide signer for workbench serve/proxy tokens. Random per process,
 * so tokens do not survive a restart (fine: they are short-lived and re-minted
 * on demand).
 */
export const workbenchTokenSigner = new WorkbenchTokenSigner();
