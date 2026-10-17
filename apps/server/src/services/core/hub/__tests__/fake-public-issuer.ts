/**
 * A minimal in-process OpenID Connect issuer for a public client: discovery,
 * authorize, token and JWKS, on a loopback port. It checks what a real issuer
 * checks for a public client (no secret at all, the PKCE verifier, the exact
 * redirect address, one use per code) and signs RS256 ID tokens carrying the
 * request's nonce, so Better Auth's own verification runs. Adapted from the
 * Community's (`apps/community/src/__tests__/fake-oidc-issuer.ts`).
 */
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

/** Who the issuer vouches for on the next authorization. */
export interface FakeIdentity {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
}

/** The fake issuer and the dials a test turns. */
export interface FakePublicIssuer {
  /** `http://127.0.0.1:<port>`. */
  issuer: string;
  clientId: string;
  /** Who the next `/authorize` signs in. */
  identity: FakeIdentity;
  /** Fields merged over the discovery document. */
  discovery: Record<string, unknown>;
  /** Every request, as `METHOD /path`. */
  requests: string[];
  close(): Promise<void>;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) body += String(chunk);
  return body;
}

/** Start a fake public-client issuer on a loopback port. */
export async function startFakePublicIssuer(): Promise<FakePublicIssuer> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fake', alg: 'RS256', use: 'sig' };
  const codes = new Map<
    string,
    { identity: FakeIdentity; nonce: string | null; challenge: string; redirectUri: string }
  >();
  const state: FakePublicIssuer = {
    issuer: '',
    clientId: 'hub-test-client',
    identity: {
      sub: 'acct_owner',
      email: 'owner@example.com',
      email_verified: true,
      name: 'Owner',
    },
    discovery: {},
    requests: [],
    close: async () => undefined,
  };
  const idToken = (identity: FakeIdentity, nonce: string | null) => {
    const now = Math.floor(Date.now() / 1000);
    const input = `${base64url({ alg: 'RS256', kid: 'fake', typ: 'JWT' })}.${base64url({
      iss: state.issuer,
      aud: state.clientId,
      iat: now,
      exp: now + 300,
      ...(nonce ? { nonce } : {}),
      ...identity,
    })}`;
    return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
  };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', state.issuer);
      state.requests.push(`${request.method} ${url.pathname}`);
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (url.pathname === '/.well-known/openid-configuration') {
        return reply(200, {
          issuer: state.issuer,
          authorization_endpoint: `${state.issuer}/authorize`,
          token_endpoint: `${state.issuer}/token`,
          jwks_uri: `${state.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
          ...state.discovery,
        });
      }
      if (url.pathname === '/jwks') return reply(200, { keys: [jwk] });
      if (url.pathname === '/authorize') {
        const params = url.searchParams;
        const scopes = (params.get('scope') ?? '').split(' ').sort().join(' ');
        if (
          params.get('client_id') !== state.clientId ||
          params.get('response_type') !== 'code' ||
          params.get('code_challenge_method') !== 'S256' ||
          !params.get('code_challenge') ||
          scopes !== 'email openid profile'
        ) {
          return reply(400, { error: 'invalid_request' });
        }
        const code = randomBytes(16).toString('hex');
        const redirectUri = params.get('redirect_uri') ?? '';
        codes.set(code, {
          identity: { ...state.identity },
          nonce: params.get('nonce'),
          challenge: params.get('code_challenge')!,
          redirectUri,
        });
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        target.searchParams.set('state', params.get('state') ?? '');
        response.writeHead(302, { location: target.href });
        return response.end();
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const form = new URLSearchParams(await readBody(request));
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (
          request.headers.authorization !== undefined ||
          form.has('client_secret') ||
          form.get('client_id') !== state.clientId ||
          !grant ||
          form.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256').update(verifier).digest('base64url') !== grant.challenge
        ) {
          return reply(400, { error: 'invalid_grant' });
        }
        return reply(200, {
          access_token: randomBytes(16).toString('hex'),
          token_type: 'Bearer',
          expires_in: 300,
          id_token: idToken(grant.identity, grant.nonce),
        });
      }
      return reply(404, { error: 'not_found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fake issuer port');
  state.issuer = `http://127.0.0.1:${address.port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}
