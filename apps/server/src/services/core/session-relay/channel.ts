/**
 * The session relay's secure channel, used by both ends: the computer that
 * dials (B2, DOR-2945) and the hub it dials (B1, DOR-2944). The shapes and the
 * exact signed bytes are the protocol's (`@dorkos/shared/session-relay`); this
 * module is the cryptography that gives them meaning.
 *
 * ## The handshake
 *
 * 1. The computer sends `hello`: its id, a fresh 32-byte nonce and a fresh
 *    X25519 key ({@link startComputerHandshake}).
 * 2. The hub, having checked the dial's relay credential belongs to that
 *    computer id, answers `welcome` with its own fresh X25519 key and an
 *    Ed25519 signature, by the hub's long-lived key, over the whole transcript:
 *    the `hello` exactly as sent, the hub's origin, the agreed version and its
 *    X25519 key ({@link answerHello}). With no common version it sends a signed
 *    `refuse` instead.
 * 3. The computer verifies that signature with the hub key it pinned from the
 *    hub itself, never from DorkOS Cloud, derives the channel and sends
 *    `finish` as its first sealed frame: its own Ed25519 signature, by the
 *    long-lived key the hub pinned for this computer, over the same exchange
 *    ({@link finishComputerHandshake}).
 * 4. The hub verifies `finish` with the computer's pinned key before it serves
 *    anything ({@link PendingHubChannel.acceptFinish}).
 *
 * Both ends derive two keys, one per direction, from the X25519 secret with
 * HKDF-SHA256, salted with a hash of the signed transcript. Every later frame
 * is sealed with ChaCha20-Poly1305 under its direction's key, with the frame's
 * sequence number in the nonce and the associated data ({@link RelayChannel}).
 * A frame out of order, replayed, from the other direction or altered fails
 * to open, and the channel is then closed for good.
 *
 * So neither someone who can terminate TLS at the hub's address, nor someone
 * holding a stolen relay credential, can read, inject or stand in for either
 * end: the keys exist only where the two pinned private keys are.
 *
 * Every function here fails closed and never throws on what a peer sent: a bad
 * key, a bad signature or a bad frame is a failure value.
 *
 * @module services/core/session-relay/channel
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  RelayFinishFrameSchema,
  RelayHandshakeAnswerSchema,
  RelayHelloFrameSchema,
  SESSION_RELAY_MAX_FRAME_LENGTH,
  SESSION_RELAY_TRANSCRIPT_LABEL,
  SESSION_RELAY_VERSIONS,
  encodeRelayFrame,
  isAgreedRelayVersion,
  negotiateRelayVersion,
  relayFinishTranscript,
  relayRefuseTranscript,
  relayWelcomeTranscript,
  type RelayHandshakeAnswer,
  type RelayHelloFrame,
  type RelaySealedFrame,
  type RelayVersionRange,
} from '@dorkos/shared/session-relay';

/** DER prefixes that wrap a raw 32-byte key as SPKI, so `node:crypto` takes it. */
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Poly1305 tag length. */
const TAG_BYTES = 16;

/** Which way a frame travels; each direction has its own key and sequence. */
export type RelayDirection = 'computer-to-web' | 'web-to-computer';

/** The computer's half of a handshake in progress. Keep it in memory only. */
export interface ComputerHandshake {
  /** The `hello` to send. */
  hello: RelayHelloFrame;
  /** The `hello` as text: send exactly this, and sign over exactly this. */
  helloText: string;
  /** The private half of the computer's X25519 key; cleared once used. */
  ephemeral: KeyObject | null;
}

/** Why a handshake did not complete. */
export type RelayHandshakeFailure =
  /** The answer did not parse, verify or yield a usable key. */
  | { ok: false; reason: 'unverified' }
  /** The hub's own signed refusal: the versions have no overlap. */
  | { ok: false; reason: 'refused'; versions: RelayVersionRange }
  /** The hub named a version this build does not speak. */
  | { ok: false; reason: 'bad-version' };

/**
 * Start a handshake: a fresh nonce and X25519 key, in a `hello`.
 *
 * @param computerId - This computer's id as its hub knows it.
 * @param features - The features this computer can serve.
 * @param appVersion - This build's DorkOS version.
 * @param versions - Override for tests; defaults to this build's versions.
 */
export function startComputerHandshake(
  computerId: string,
  features: readonly string[],
  appVersion: string,
  versions: RelayVersionRange = SESSION_RELAY_VERSIONS
): ComputerHandshake {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const hello: RelayHelloFrame = {
    type: 'hello',
    computerId,
    versions: { min: versions.min, max: versions.max },
    features: [...features],
    appVersion,
    nonce: randomBytes(32).toString('base64url'),
    ephemeralKey: rawPublicKey(publicKey).toString('base64url'),
  };
  return { hello, helloText: encodeRelayFrame(hello)!, ephemeral: privateKey };
}

/**
 * Finish a handshake on the computer: verify the hub's answer with the pinned
 * key, derive the channel and seal the `finish` to send first. Single use: a
 * handshake finished once cannot be finished again, so no two channels ever
 * share keys.
 *
 * @param handshake - What {@link startComputerHandshake} returned.
 * @param answerText - The hub's answer exactly as received.
 * @param pins - The hub's origin and Ed25519 public key as pinned, and this
 *   computer's own long-lived Ed25519 private key.
 * @param versions - Override for tests; defaults to this build's versions.
 */
export function finishComputerHandshake(
  handshake: ComputerHandshake,
  answerText: string,
  pins: { hubOrigin: string; hubKey: string; computerKey: KeyObject },
  versions: RelayVersionRange = SESSION_RELAY_VERSIONS
):
  | { ok: true; version: number; channel: RelayChannel; finish: RelaySealedFrame }
  | RelayHandshakeFailure {
  const ephemeral = handshake.ephemeral;
  handshake.ephemeral = null;
  if (!ephemeral) return { ok: false, reason: 'unverified' };
  const answer = parseJson(answerText, RelayHandshakeAnswerSchema);
  const hubKey = publicKeyFromRaw(ED25519_SPKI_PREFIX, pins.hubKey);
  if (!answer || !hubKey) return { ok: false, reason: 'unverified' };
  const input = { helloText: handshake.helloText, hubOrigin: pins.hubOrigin };
  const signature = Buffer.from(answer.signature, 'base64url');

  if (answer.type === 'refuse') {
    const signed = safeVerify(relayRefuseTranscript(input, answer.versions), hubKey, signature);
    return signed
      ? { ok: false, reason: 'refused', versions: answer.versions }
      : { ok: false, reason: 'unverified' };
  }

  const transcript = relayWelcomeTranscript(input, answer.version, answer.ephemeralKey);
  if (!safeVerify(transcript, hubKey, signature)) return { ok: false, reason: 'unverified' };
  // Signed, but a version this build never offered is still not one to serve.
  if (!isAgreedRelayVersion(versions, answer.version)) return { ok: false, reason: 'bad-version' };
  const channel = deriveChannel(ephemeral, answer.ephemeralKey, transcript, 'computer-to-web');
  if (!channel) return { ok: false, reason: 'unverified' };
  const finishSignature = sign(
    null,
    relayFinishTranscript(input, answer.version, answer.ephemeralKey),
    pins.computerKey
  );
  const finishText = JSON.stringify({
    type: 'finish',
    signature: finishSignature.toString('base64url'),
  });
  const finish = channel.seal(finishText);
  if (!finish) return { ok: false, reason: 'unverified' };
  return { ok: true, version: answer.version, channel, finish };
}

/** What the hub needs to answer a `hello`. */
export interface HubIdentity {
  /**
   * Sign bytes with the hub's long-lived Ed25519 key (lane A's
   * `signWithHubKey`). The key signs relay transcripts and nothing else, so a
   * signature can never stand in for anything outside this handshake.
   */
  sign: (data: Uint8Array) => Buffer;
  /** The hub's origin as computers pin it (`https://…`, no path). */
  origin: string;
}

/**
 * The hub's side of a handshake that has sent `welcome` and waits for the
 * computer's `finish`. Nothing is served until {@link acceptFinish} returns
 * the channel.
 */
export class PendingHubChannel {
  private used = false;

  /**
   * Hold the channel and what `finish` must sign; built by {@link answerHello}.
   *
   * @param channel - The derived channel, not yet trusted.
   * @param finishTranscript - The bytes the computer must have signed.
   */
  constructor(
    private readonly channel: RelayChannel,
    private readonly finishTranscript: Uint8Array
  ) {}

  /**
   * Check the computer's first sealed frame. Returns the channel only when it
   * is a `finish` signed by the computer's pinned key; otherwise `null`, and
   * the connection must close. Single use.
   *
   * @param frame - The computer's first sealed frame.
   * @param computerKey - The computer's Ed25519 public key as the hub pinned
   *   it, raw 32 bytes base64url.
   */
  acceptFinish(frame: RelaySealedFrame, computerKey: string): RelayChannel | null {
    if (this.used) return null;
    this.used = true;
    const text = this.channel.open(frame);
    const finish = text === null ? null : parseJson(text, RelayFinishFrameSchema);
    const key = publicKeyFromRaw(ED25519_SPKI_PREFIX, computerKey);
    if (!finish || !key) return null;
    const signature = Buffer.from(finish.signature, 'base64url');
    return safeVerify(this.finishTranscript, key, signature) ? this.channel : null;
  }
}

/** What {@link answerHello} decided. */
export type HubAnswer =
  /** Send `answer`; when it is a `welcome`, wait for the computer's `finish` on `pending`. */
  | { ok: true; answer: RelayHandshakeAnswer; pending: PendingHubChannel | null }
  /** The `hello` did not parse, named another computer, or carried an unusable key. Close. */
  | { ok: false };

/**
 * Answer a computer's `hello` on the hub: a signed `welcome` and the pending
 * channel, or a signed `refuse` when no version is common.
 *
 * @param helloText - The `hello` exactly as received; parsed here, so what is
 *   signed and what keys are derived from can never be two different texts.
 * @param computerId - The computer the dial's relay credential belongs to.
 * @param hub - The hub's signing key and origin.
 * @param versions - Override for tests; defaults to this build's versions.
 */
export function answerHello(
  helloText: string,
  computerId: string,
  hub: HubIdentity,
  versions: RelayVersionRange = SESSION_RELAY_VERSIONS
): HubAnswer {
  if (helloText.length > SESSION_RELAY_MAX_FRAME_LENGTH) return { ok: false };
  const hello = parseJson(helloText, RelayHelloFrameSchema);
  // A hello naming another computer than the credential's is a hello passed
  // on from elsewhere: never answer it.
  if (!hello || hello.computerId !== computerId) return { ok: false };
  const input = { helloText, hubOrigin: hub.origin };
  const outcome = negotiateRelayVersion(versions, hello.versions);
  if (!outcome.ok) {
    const signature = hub.sign(relayRefuseTranscript(input, versions));
    return {
      ok: true,
      answer: {
        type: 'refuse',
        versions: { min: versions.min, max: versions.max },
        signature: signature.toString('base64url'),
      },
      pending: null,
    };
  }
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const hubEphemeralKey = rawPublicKey(publicKey).toString('base64url');
  const transcript = relayWelcomeTranscript(input, outcome.version, hubEphemeralKey);
  const channel = deriveChannel(privateKey, hello.ephemeralKey, transcript, 'web-to-computer');
  if (!channel) return { ok: false };
  const signature = hub.sign(transcript);
  return {
    ok: true,
    answer: {
      type: 'welcome',
      version: outcome.version,
      ephemeralKey: hubEphemeralKey,
      signature: signature.toString('base64url'),
    },
    pending: new PendingHubChannel(
      channel,
      relayFinishTranscript(input, outcome.version, hubEphemeralKey)
    ),
  };
}

/**
 * One end of an open channel: seal what this end sends, open what it receives.
 * After any frame fails to open, the channel refuses everything; the caller
 * closes the connection.
 */
export class RelayChannel {
  private sendSeq = 0;
  private receiveSeq = 0;
  private broken = false;

  /**
   * Hold one end's two keys; built by the handshake, never by hand.
   *
   * @param sendKey - The key for frames this end sends.
   * @param receiveKey - The key for frames this end receives.
   * @param sendDirection - Which way this end's frames travel.
   */
  constructor(
    private readonly sendKey: Buffer,
    private readonly receiveKey: Buffer,
    private readonly sendDirection: RelayDirection
  ) {}

  /**
   * Seal one inner frame, or `null` when it is too large to send: the
   * sequence number is spent only on a frame that will go out, so dropping an
   * oversized one never leaves a gap that closes the channel.
   *
   * @param innerText - The inner frame's JSON text (from `encodeRelayFrame`).
   */
  seal(innerText: string): RelaySealedFrame | null {
    if (this.broken) return null;
    const plaintext = Buffer.from(innerText, 'utf8');
    const boxLength = Math.ceil(((plaintext.length + TAG_BYTES) * 4) / 3);
    // The sealed frame's own JSON adds a few dozen characters around the box.
    if (boxLength + 64 > SESSION_RELAY_MAX_FRAME_LENGTH) return null;
    if (this.sendSeq >= Number.MAX_SAFE_INTEGER) return null;
    const seq = this.sendSeq++;
    const cipher = createCipheriv('chacha20-poly1305', this.sendKey, frameNonce(seq), {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(frameAad(this.sendDirection, seq), { plaintextLength: plaintext.length });
    const box = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    return { type: 'sealed', seq, box: box.toString('base64url') };
  }

  /**
   * Open one sealed frame from the other end, or `null` when it is out of
   * order, replayed, altered or from the wrong direction. After a `null`, the
   * channel refuses everything.
   *
   * @param frame - The sealed frame as parsed.
   * @returns The inner frame's text.
   */
  open(frame: RelaySealedFrame): string | null {
    if (this.broken || frame.seq !== this.receiveSeq) return this.fail();
    const box = Buffer.from(frame.box, 'base64url');
    if (box.length < TAG_BYTES || box.toString('base64url') !== frame.box) return this.fail();
    const receiveDirection: RelayDirection =
      this.sendDirection === 'computer-to-web' ? 'web-to-computer' : 'computer-to-web';
    try {
      const decipher = createDecipheriv(
        'chacha20-poly1305',
        this.receiveKey,
        frameNonce(frame.seq),
        { authTagLength: TAG_BYTES }
      );
      decipher.setAAD(frameAad(receiveDirection, frame.seq), {
        plaintextLength: box.length - TAG_BYTES,
      });
      decipher.setAuthTag(box.subarray(box.length - TAG_BYTES));
      const text = Buffer.concat([
        decipher.update(box.subarray(0, box.length - TAG_BYTES)),
        decipher.final(),
      ]);
      this.receiveSeq += 1;
      return text.toString('utf8');
    } catch {
      return this.fail();
    }
  }

  /** Whether a frame has failed to open, which ends the channel. */
  get closed(): boolean {
    return this.broken;
  }

  private fail(): null {
    this.broken = true;
    return null;
  }
}

/** Derive one end's channel, or `null` when the peer's key is unusable. */
function deriveChannel(
  ownEphemeral: KeyObject,
  peerEphemeralKey: string,
  transcript: Uint8Array,
  sendDirection: RelayDirection
): RelayChannel | null {
  const peer = publicKeyFromRaw(X25519_SPKI_PREFIX, peerEphemeralKey);
  if (!peer) return null;
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey: ownEphemeral, publicKey: peer });
  } catch {
    // OpenSSL refuses low-order points itself.
    return null;
  }
  // A backstop: an all-zero secret is one anyone could compute.
  if (shared.every((byte) => byte === 0)) return null;
  const salt = createHash('sha256').update(transcript).digest();
  const okm = Buffer.from(
    hkdfSync('sha256', shared, salt, `${SESSION_RELAY_TRANSCRIPT_LABEL} keys`, 64)
  );
  const computerToWeb = okm.subarray(0, 32);
  const webToComputer = okm.subarray(32, 64);
  return sendDirection === 'computer-to-web'
    ? new RelayChannel(computerToWeb, webToComputer, sendDirection)
    : new RelayChannel(webToComputer, computerToWeb, sendDirection);
}

/** A 12-byte nonce: four zero bytes, then the sequence number big-endian. */
function frameNonce(seq: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  return nonce;
}

/** What each sealed frame authenticates beside its text: the label, direction and sequence. */
function frameAad(direction: RelayDirection, seq: number): Buffer {
  return Buffer.from(`${SESSION_RELAY_TRANSCRIPT_LABEL} sealed ${direction} ${seq}`);
}

/** Verify an Ed25519 signature, as `false` rather than a throw on anything malformed. */
function safeVerify(data: Uint8Array, key: KeyObject, signature: Buffer): boolean {
  try {
    return verify(null, data, key, signature);
  } catch {
    return false;
  }
}

/** Something that can check a parsed value, as a Zod schema does. */
interface Checker<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** Parse JSON text against a schema, or `null`. */
function parseJson<T>(text: string, schema: Checker<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The raw 32 bytes of an X25519 or Ed25519 public key. */
function rawPublicKey(key: KeyObject): Buffer {
  return key.export({ format: 'der', type: 'spki' }).subarray(-32);
}

/**
 * A public key from its raw 32 bytes, or `null` when they are not exactly 32
 * bytes in canonical base64url (no stray characters, no spare bits).
 */
function publicKeyFromRaw(prefix: Buffer, rawBase64url: string): KeyObject | null {
  const raw = Buffer.from(rawBase64url, 'base64url');
  if (raw.length !== 32 || raw.toString('base64url') !== rawBase64url) return null;
  try {
    return createPublicKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'spki' });
  } catch {
    return null;
  }
}

/**
 * An Ed25519 public key as the other end pins it: raw 32 bytes, base64url.
 * Used for the hub's signing key and for each computer's key alike.
 *
 * @param signingKey - The private signing key.
 */
export function pinnableKey(signingKey: KeyObject): string {
  return rawPublicKey(createPublicKey(signingKey)).toString('base64url');
}

/**
 * Read an Ed25519 private signing key from its PEM text.
 *
 * @param pem - PKCS#8 PEM, as the hub or the computer stores it.
 */
export function signingKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}
