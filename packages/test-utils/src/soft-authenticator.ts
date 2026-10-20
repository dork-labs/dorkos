/**
 * A software WebAuthn authenticator for tests: it makes passkeys and signs
 * assertions and `none` attestations the way a browser and a platform
 * authenticator would, so a relying party's checks can be driven end to end
 * without a browser.
 *
 * ES256 (P-256, COSE -7) and Ed25519 (COSE -8), both from `node:crypto`. Every
 * field a test may want to break (origin, relying party, flags, counter, user
 * handle, `crossOrigin`, `topOrigin`) is an option. Node-only, so it lives
 * behind its own subpath (`@dorkos/test-utils/soft-authenticator`), never the
 * barrel.
 *
 * @module test-utils/soft-authenticator
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/** The algorithms the soft authenticator can make keys for. */
export type SoftAuthenticatorAlg = 'ES256' | 'Ed25519';

/** The COSE algorithm id of each {@link SoftAuthenticatorAlg}. */
export const SOFT_AUTHENTICATOR_COSE_ALG: Record<SoftAuthenticatorAlg, -7 | -8> = {
  ES256: -7,
  Ed25519: -8,
};

/** `authenticatorData` flag bits. */
export const AUTHENTICATOR_FLAGS = {
  userPresent: 0x01,
  userVerified: 0x04,
  attestedCredentialData: 0x40,
} as const;

/** How to make a soft authenticator. */
export interface SoftAuthenticatorOptions {
  /** The relying party the passkey is for. */
  rpId: string;
  /** The page the passkey is used from, as `clientDataJSON.origin`. */
  origin: string;
  /** The WebAuthn user handle, base64url. */
  userHandle: string;
  /** Key algorithm; defaults to ES256. */
  alg?: SoftAuthenticatorAlg;
  /** The credential id, base64url; random 16 bytes when left out. */
  credentialId?: string;
  /** The signature counter before the first assertion; 0 when left out. */
  signCount?: number;
  /** Whether the counter goes up on each assertion; true when left out. */
  counts?: boolean;
}

/** Overrides for one assertion, each one a field a relying party must check. */
export interface SoftAssertionOptions {
  /** The base64url challenge to sign. */
  challenge: string;
  /** `clientDataJSON.type`; `webauthn.get` by default. */
  type?: string;
  /** `clientDataJSON.origin`; the authenticator's origin by default. */
  origin?: string;
  /** The relying party hashed into `authenticatorData`; the authenticator's by default. */
  rpId?: string;
  /** `clientDataJSON.crossOrigin`; `false` by default, left out when `null`. */
  crossOrigin?: boolean | null;
  /** `clientDataJSON.topOrigin`; left out by default. */
  topOrigin?: string;
  /** The user present flag; set by default. */
  userPresent?: boolean;
  /** The user verified flag; set by default. */
  userVerified?: boolean;
  /** The counter to report, instead of the next one. */
  signCount?: number;
  /** The user handle to return; the authenticator's by default, left out when `null`. */
  userHandle?: string | null;
}

/** An assertion, every binary field base64url, as a relay approval proof carries it. */
export interface SoftAssertion {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
  userHandle?: string;
}

/** A `none` attestation, as `navigator.credentials.create` returns one. */
export interface SoftAttestation {
  credentialId: string;
  clientDataJSON: string;
  attestationObject: string;
}

// === A little CBOR: enough for COSE keys and attestation objects ===

type CborValue = number | string | Uint8Array | Map<CborValue, CborValue>;

/** A CBOR head: major type and argument. */
function cborHead(major: number, argument: number): Buffer {
  if (argument < 24) return Buffer.from([(major << 5) | argument]);
  if (argument < 0x100) return Buffer.from([(major << 5) | 24, argument]);
  if (argument < 0x10000) {
    const head = Buffer.alloc(3);
    head[0] = (major << 5) | 25;
    head.writeUInt16BE(argument, 1);
    return head;
  }
  const head = Buffer.alloc(5);
  head[0] = (major << 5) | 26;
  head.writeUInt32BE(argument, 1);
  return head;
}

/** Encode one CBOR value (integers, text, bytes, maps). */
function cbor(value: CborValue): Buffer {
  if (typeof value === 'number') {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), value]);
  const parts = [cborHead(5, value.size)];
  for (const [key, member] of value) parts.push(cbor(key), cbor(member));
  return Buffer.concat(parts);
}

/** Base64url of some bytes, unpadded. */
function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** A soft authenticator holding one passkey. */
export class SoftAuthenticator {
  /** The credential id, base64url. */
  readonly credentialId: string;
  /** The key algorithm. */
  readonly alg: SoftAuthenticatorAlg;
  /** The relying party the passkey is for. */
  readonly rpId: string;
  /** The page the passkey is used from. */
  readonly origin: string;
  /** The WebAuthn user handle, base64url. */
  readonly userHandle: string;
  private counter: number;
  private readonly counts: boolean;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  /**
   * Make a passkey.
   *
   * @param options - See {@link SoftAuthenticatorOptions}.
   */
  constructor(options: SoftAuthenticatorOptions) {
    this.alg = options.alg ?? 'ES256';
    this.rpId = options.rpId;
    this.origin = options.origin;
    this.userHandle = options.userHandle;
    this.credentialId = options.credentialId ?? b64url(randomBytes(16));
    this.counter = options.signCount ?? 0;
    this.counts = options.counts ?? true;
    const pair =
      this.alg === 'ES256'
        ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
        : generateKeyPairSync('ed25519');
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  /** The signature counter the last assertion reported. */
  get signCount(): number {
    return this.counter;
  }

  /** The COSE algorithm id. */
  get coseAlg(): -7 | -8 {
    return SOFT_AUTHENTICATOR_COSE_ALG[this.alg];
  }

  /** The public key as a COSE key, raw bytes. */
  cosePublicKey(): Uint8Array {
    const jwk = this.publicKey.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x!, 'base64url');
    if (this.alg === 'Ed25519') {
      return cbor(
        new Map<CborValue, CborValue>([
          [1, 1],
          [3, -8],
          [-1, 6],
          [-2, x],
        ])
      );
    }
    return cbor(
      new Map<CborValue, CborValue>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ])
    );
  }

  /** The public key as a COSE key, base64url, as a relying party pins it. */
  cosePublicKeyBase64url(): string {
    return b64url(this.cosePublicKey());
  }

  /** `authenticatorData` for a relying party, flags and counter, with optional attested data. */
  private authenticatorData(
    rpId: string,
    flags: number,
    signCount: number,
    attested?: Buffer
  ): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(signCount >>> 0, 0);
    return Buffer.concat([
      createHash('sha256').update(rpId, 'utf8').digest(),
      Buffer.from([flags]),
      count,
      ...(attested ? [attested] : []),
    ]);
  }

  /** Sign `authenticatorData ‖ SHA-256(clientDataJSON)` as WebAuthn does. */
  private signOver(authData: Buffer, clientDataJSON: Buffer): Buffer {
    const data = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]);
    return this.alg === 'ES256'
      ? sign('sha256', data, { key: this.privateKey, dsaEncoding: 'der' })
      : sign(null, data, this.privateKey);
  }

  /** `clientDataJSON` bytes, in the order browsers write the fields. */
  private clientData(
    type: string,
    challenge: string,
    origin: string,
    crossOrigin: boolean | null,
    topOrigin: string | undefined
  ): Buffer {
    return Buffer.from(
      JSON.stringify({
        type,
        challenge,
        origin,
        ...(crossOrigin !== null ? { crossOrigin } : {}),
        ...(topOrigin !== undefined ? { topOrigin } : {}),
      }),
      'utf8'
    );
  }

  /**
   * Sign an assertion over a challenge, as `navigator.credentials.get` would.
   *
   * @param options - The challenge, and anything to break. See {@link SoftAssertionOptions}.
   * @returns The assertion, every binary field base64url.
   */
  assert(options: SoftAssertionOptions): SoftAssertion {
    if (options.signCount === undefined && this.counts) this.counter += 1;
    const signCount = options.signCount ?? (this.counts ? this.counter : 0);
    const flags =
      (options.userPresent === false ? 0 : AUTHENTICATOR_FLAGS.userPresent) |
      (options.userVerified === false ? 0 : AUTHENTICATOR_FLAGS.userVerified);
    const authData = this.authenticatorData(options.rpId ?? this.rpId, flags, signCount);
    const clientDataJSON = this.clientData(
      options.type ?? 'webauthn.get',
      options.challenge,
      options.origin ?? this.origin,
      options.crossOrigin === undefined ? false : options.crossOrigin,
      options.topOrigin
    );
    const userHandle = options.userHandle === undefined ? this.userHandle : options.userHandle;
    return {
      credentialId: this.credentialId,
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authData),
      signature: b64url(this.signOver(authData, clientDataJSON)),
      ...(userHandle !== null ? { userHandle } : {}),
    };
  }

  /**
   * Make a `none` attestation for this passkey, as `navigator.credentials.create` would.
   *
   * @param options - The challenge, and the origin and relying party when not the authenticator's own.
   * @returns The attestation, every binary field base64url.
   */
  attest(options: { challenge: string; origin?: string; rpId?: string }): SoftAttestation {
    const credentialId = Buffer.from(this.credentialId, 'base64url');
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length, 0);
    const attested = Buffer.concat([
      Buffer.alloc(16), // AAGUID: all zeros, as `none` attestation reports it.
      idLength,
      credentialId,
      Buffer.from(this.cosePublicKey()),
    ]);
    const flags =
      AUTHENTICATOR_FLAGS.userPresent |
      AUTHENTICATOR_FLAGS.userVerified |
      AUTHENTICATOR_FLAGS.attestedCredentialData;
    const authData = this.authenticatorData(
      options.rpId ?? this.rpId,
      flags,
      this.counts ? this.counter : 0,
      attested
    );
    const clientDataJSON = this.clientData(
      'webauthn.create',
      options.challenge,
      options.origin ?? this.origin,
      false,
      undefined
    );
    const attestationObject = cbor(
      new Map<CborValue, CborValue>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ])
    );
    return {
      credentialId: this.credentialId,
      clientDataJSON: b64url(clientDataJSON),
      attestationObject: b64url(attestationObject),
    };
  }
}
