import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

/** The person the fake issuer vouches for on the next authorization. */
export interface FakeIdentity {
  sub: string;
  email: string;
  email_verified: boolean;
  name: string;
}

/** A minimal in-process OpenID Connect issuer: discovery, authorize, token and JWKS. */
export interface FakeIssuer {
  /** The issuer URL, `http://127.0.0.1:<port>`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Every request the issuer has received, as `METHOD /path`, oldest first. */
  requests: string[];
  /** Who the next `/authorize` signs in. */
  identity: FakeIdentity;
  /** While true, discovery answers 503, as an issuer that is down. */
  down: boolean;
  /** Fields merged over the discovery document, to serve a wrong or unsafe one. */
  discovery: Record<string, unknown>;
  /** Leave the email out of the ID token, so the profile comes from `/userinfo`. */
  idTokenWithoutEmail: boolean;
  /** Answer the token request with no ID token at all. */
  omitIdToken: boolean;
  /** Fields merged over the identity `/userinfo` returns, to disagree with the ID token. */
  userinfo: Partial<FakeIdentity>;
  /** Sign a valid ID token for `identity` directly, as one stolen or replayed would be. */
  mintIdToken(identity: FakeIdentity, nonce?: string | null): string;
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

/**
 * Start a fake issuer on a loopback port. It checks what a real issuer checks on the token
 * request (client credentials, PKCE verifier, redirect URI, one use per code) and signs RS256 ID
 * tokens carrying the authorization request's nonce, so Better Auth's own verification runs.
 */
export async function startFakeIssuer(): Promise<FakeIssuer> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...publicKey.export({ format: 'jwk' }),
    kid: 'fake-issuer',
    alg: 'RS256',
    use: 'sig',
  };
  const codes = new Map<
    string,
    { identity: FakeIdentity; nonce: string | null; challenge: string; redirectUri: string }
  >();
  const tokens = new Map<string, { accessToken: string; identity: FakeIdentity }>();
  const state: FakeIssuer = {
    issuer: '',
    clientId: 'community-test-client',
    clientSecret: 'community-test-secret',
    requests: [],
    identity: {
      sub: 'person-1',
      email: 'person@example.com',
      email_verified: true,
      name: 'Person',
    },
    down: false,
    discovery: {},
    idTokenWithoutEmail: false,
    omitIdToken: false,
    userinfo: {},
    mintIdToken: () => '',
    close: async () => undefined,
  };
  const idToken = (identity: FakeIdentity, nonce: string | null) => {
    const now = Math.floor(Date.now() / 1000);
    const input = `${base64url({ alg: 'RS256', kid: 'fake-issuer', typ: 'JWT' })}.${base64url({
      iss: state.issuer,
      aud: state.clientId,
      iat: now,
      exp: now + 300,
      ...(nonce ? { nonce } : {}),
      ...identity,
      ...(state.idTokenWithoutEmail ? { email: undefined, email_verified: undefined } : {}),
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
        if (state.down) return reply(503, { error: 'unavailable' });
        return reply(200, {
          issuer: state.issuer,
          authorization_endpoint: `${state.issuer}/authorize`,
          token_endpoint: `${state.issuer}/token`,
          jwks_uri: `${state.issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          userinfo_endpoint: `${state.issuer}/userinfo`,
          code_challenge_methods_supported: ['S256'],
          ...state.discovery,
        });
      }
      if (url.pathname === '/userinfo') {
        const grant = [...tokens.values()].find(
          (candidate) => request.headers.authorization === `Bearer ${candidate.accessToken}`
        );
        if (!grant) return reply(401, { error: 'invalid_token' });
        return reply(200, { ...grant.identity, ...state.userinfo });
      }
      if (url.pathname === '/jwks') return reply(200, { keys: [jwk] });
      if (url.pathname === '/authorize') {
        const params = url.searchParams;
        const redirectUri = params.get('redirect_uri') ?? '';
        if (
          params.get('client_id') !== state.clientId ||
          params.get('response_type') !== 'code' ||
          params.get('code_challenge_method') !== 'S256' ||
          !params.get('code_challenge') ||
          !(params.get('scope') ?? '').split(' ').includes('openid')
        )
          return reply(400, { error: 'invalid_request' });
        const code = randomBytes(16).toString('hex');
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
        const basic = request.headers.authorization?.startsWith('Basic ')
          ? Buffer.from(request.headers.authorization.slice(6), 'base64').toString().split(':')
          : null;
        const clientId = basic ? decodeURIComponent(basic[0]) : form.get('client_id');
        const clientSecret = basic ? decodeURIComponent(basic[1]) : form.get('client_secret');
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (
          clientId !== state.clientId ||
          clientSecret !== state.clientSecret ||
          !grant ||
          form.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256').update(verifier).digest('base64url') !== grant.challenge
        )
          return reply(400, { error: 'invalid_grant' });
        const accessToken = randomBytes(16).toString('hex');
        tokens.set(accessToken, { accessToken, identity: grant.identity });
        return reply(200, {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 300,
          ...(state.omitIdToken ? {} : { id_token: idToken(grant.identity, grant.nonce) }),
        });
      }
      return reply(404, { error: 'not_found' });
    })();
  });
  state.mintIdToken = (identity, nonce = null) => idToken(identity, nonce);
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
