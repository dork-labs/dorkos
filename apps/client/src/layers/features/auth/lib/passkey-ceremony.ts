/**
 * Run a passkey check or make a passkey in the browser, from the options the
 * server sent, and turn the browser's answer into the JSON the server reads
 * (DOR-3647, DOR-4744). The server builds and checks everything; this only
 * converts between base64url text and the bytes WebAuthn wants.
 *
 * @module features/auth/lib/passkey-ceremony
 */

/** Base64url text to bytes. */
function fromBase64url(text: string): ArrayBuffer {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Bytes to base64url text, unpadded. */
function toBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The server's options for a passkey check, as JSON. */
interface RequestOptionsJSON {
  challenge: string;
  rpId?: string;
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: { id: string; type?: 'public-key'; transports?: AuthenticatorTransport[] }[];
}

/** The server's options for making a passkey, as JSON. */
interface CreationOptionsJSON {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: { alg: number; type: 'public-key' }[];
  timeout?: number;
  excludeCredentials?: { id: string; type?: 'public-key' }[];
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
}

/** Whether this browser can do passkeys here at all (a secure page, WebAuthn). */
export function passkeysAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator.credentials?.get === 'function'
  );
}

/**
 * Ask the browser for a passkey check against the server's options.
 *
 * @param options - What the server sent.
 * @returns The response to send back, as JSON.
 * @throws When the person cancels or the browser refuses.
 */
export async function runPasskeyCheck(options: unknown): Promise<Record<string, unknown>> {
  const json = options as RequestOptionsJSON;
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: fromBase64url(json.challenge),
      rpId: json.rpId,
      timeout: json.timeout,
      userVerification: json.userVerification ?? 'required',
      allowCredentials: json.allowCredentials?.map((item) => ({
        id: fromBase64url(item.id),
        type: 'public-key' as const,
        ...(item.transports ? { transports: item.transports } : {}),
      })),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was used.');
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: {},
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      authenticatorData: toBase64url(response.authenticatorData),
      signature: toBase64url(response.signature),
      ...(response.userHandle ? { userHandle: toBase64url(response.userHandle) } : {}),
    },
  };
}

/**
 * Ask the browser to make a passkey from the server's options.
 *
 * @param options - What the server sent.
 * @returns The new passkey to send back, as JSON.
 * @throws When the person cancels or the browser refuses.
 */
export async function makePasskey(options: unknown): Promise<Record<string, unknown>> {
  const json = options as CreationOptionsJSON;
  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: fromBase64url(json.challenge),
      rp: json.rp,
      user: { ...json.user, id: fromBase64url(json.user.id) },
      pubKeyCredParams: json.pubKeyCredParams,
      timeout: json.timeout,
      excludeCredentials: json.excludeCredentials?.map((item) => ({
        id: fromBase64url(item.id),
        type: 'public-key' as const,
      })),
      authenticatorSelection: { ...json.authenticatorSelection, userVerification: 'required' },
      attestation: json.attestation ?? 'none',
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('No passkey was made.');
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: {},
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      attestationObject: toBase64url(response.attestationObject),
    },
  };
}
