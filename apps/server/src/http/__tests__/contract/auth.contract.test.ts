/**
 * Contract for the Better Auth routes (`/api/auth/*`) and the sign-in limiter
 * in front of them. They move to Hono in DOR-2807; that PR must pass this file
 * unchanged.
 *
 * The cases run in order against one server, and later ones depend on earlier
 * ones: the first sign-up creates the owner, and every sign-in or sign-up POST
 * that reaches the limiter counts toward it, which this suite sets to six.
 * A request CORS refuses never reaches it, so it counts for nothing.
 */
import { contractSuite, SERVER_ORIGIN } from './harness.js';

const OWNER = { email: 'owner' + '@' + 'dork.test', password: 'correct-horse-battery-staple' };
/** A host the server answers to, as if reached through a TLS-terminating proxy. */
const PROXIED_HOST = 'dorkos.example';
/** A Better Auth session cookie: prefixed per data directory, never `Secure` in development. */
const SESSION_COOKIE = /^better-auth[-0-9a-f]*\.session_token=[^;]+;.*HttpOnly.*SameSite=Lax/i;

contractSuite(
  'auth',
  [
    {
      name: 'GET /api/auth/ok answers',
      path: '/api/auth/ok',
      expect: { status: 200, body: { ok: true } },
    },
    {
      name: 'GET /api/auth/get-session with no cookie answers null',
      path: '/api/auth/get-session',
      expect: { status: 200, body: null },
    },
    {
      name: 'an unknown auth endpoint is Better Auth’s 404, not the API one',
      path: '/api/auth/no-such-endpoint',
      // Empty, where the API's own 404 is `{ error, code: 'API_NOT_FOUND' }`.
      expect: { status: 404, headers: { 'x-content-type-options': 'nosniff' }, body: '' },
    },
    {
      name: '(attempt 1) the first sign-up creates the owner and signs them in',
      method: 'POST',
      path: '/api/auth/sign-up/email',
      headers: { origin: SERVER_ORIGIN },
      body: { ...OWNER, name: 'Owner' },
      expect: {
        status: 200,
        headers: {
          'set-cookie': SESSION_COOKIE,
          'access-control-allow-origin': SERVER_ORIGIN,
          'access-control-allow-credentials': 'true',
          'ratelimit-limit': '6',
          'ratelimit-remaining': '5',
        },
      },
    },
    {
      name: '(attempt 2) a second sign-up is refused: registration is closed',
      method: 'POST',
      path: '/api/auth/sign-up/email',
      headers: { origin: SERVER_ORIGIN },
      body: { email: 'second' + '@' + 'dork.test', password: 'another-long-password', name: 'B' },
      expect: {
        status: 403,
        body: {
          code: 'REGISTRATION_CLOSED',
          message:
            'Registration is closed. An owner account already exists for this DorkOS instance.',
        },
      },
    },
    {
      name: '(attempt 3) a wrong password is refused',
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: { origin: SERVER_ORIGIN },
      body: { email: OWNER.email, password: 'not-the-password' },
      expect: {
        status: 401,
        headers: { 'set-cookie': null },
        body: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
      },
    },
    {
      // Better Auth reads its own body: nothing in front of it may parse the
      // stream first, or every sign-in would arrive empty.
      name: '(attempt 4) a body that is not JSON is Better Auth’s to refuse',
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: { origin: SERVER_ORIGIN, 'content-type': 'application/json' },
      body: '{"email":',
      // The API chain's own parser would answer a 500 here.
      expect: {
        status: 400,
        headers: { 'set-cookie': null },
        body: { message: 'Invalid JSON in request body', code: 'BAD_REQUEST' },
      },
    },
    {
      name: '(attempt 5) the right password signs in',
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: { origin: SERVER_ORIGIN },
      body: OWNER,
      expect: { status: 200, headers: { 'set-cookie': SESSION_COOKIE } },
    },
    {
      // CORS pairs the origin with the scheme the request says it came in on;
      // with no `X-Forwarded-Proto`, an https origin is not this server's own.
      name: '(not counted) behind a proxy, an https origin is foreign without X-Forwarded-Proto',
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: { host: PROXIED_HOST, origin: `https://${PROXIED_HOST}` },
      body: OWNER,
      expect: {
        status: 500,
        headers: { 'set-cookie': null, 'ratelimit-limit': null },
        body: {
          error: `Origin https://${PROXIED_HOST} not allowed by CORS`,
          code: 'INTERNAL_ERROR',
        },
      },
    },
    {
      // Better Auth reads `X-Forwarded-Proto` too: the origin it checks against
      // is built from it, and `dorkos.example` is on no trusted-origin list.
      name: '(attempt 6) behind a proxy, X-Forwarded-Proto makes the https origin its own',
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: {
        host: PROXIED_HOST,
        origin: `https://${PROXIED_HOST}`,
        'x-forwarded-proto': 'https',
      },
      body: OWNER,
      expect: { status: 200, headers: { 'set-cookie': SESSION_COOKIE } },
    },
    {
      name: '(attempt 7) one attempt too many is refused by the limiter, before Better Auth',
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: { origin: SERVER_ORIGIN },
      body: OWNER,
      expect: {
        status: 429,
        headers: {
          'set-cookie': null,
          'ratelimit-limit': '6',
          'ratelimit-remaining': '0',
          'retry-after': /^\d+$/,
        },
        body: {
          error: 'Too many sign-in attempts. Try again in a few minutes.',
          code: 'RATE_LIMITED',
        },
      },
    },
    {
      name: 'the limiter does not count or refuse a session check',
      path: '/api/auth/get-session',
      expect: { status: 200, headers: { 'ratelimit-limit': null }, body: null },
    },
    {
      name: 'a foreign Host is refused before Better Auth runs',
      method: 'POST',
      path: '/api/auth/sign-in/email',
      headers: { host: 'evil.example' },
      body: OWNER,
      expect: {
        status: 403,
        headers: { 'set-cookie': null },
        body: {
          error:
            'This instance does not answer to the address "evil.example". If that is how you reach DorkOS, list it in DORKOS_TRUSTED_HOSTS, or turn on login.',
          code: 'HOST_NOT_ALLOWED',
        },
      },
    },
    {
      // The CORS delegate refuses an untrusted origin with a 500 today; a
      // move keeps it.
      name: 'an untrusted browser origin is refused',
      path: '/api/auth/get-session',
      headers: { origin: 'https://evil.example' },
      expect: {
        status: 500,
        body: { error: 'Origin https://evil.example not allowed by CORS', code: 'INTERNAL_ERROR' },
      },
    },
  ],
  { env: { DORKOS_AUTH_SIGNIN_RATE_LIMIT: '6', DORKOS_TRUSTED_HOSTS: PROXIED_HOST } }
);
