import { describe, it, expect } from 'vitest';
import type { McpServerTransport } from '@dorkos/shared/mesh-schemas';
import { classifyFailure, holdsSignIn, probeAdjustedStatus, usesOwnKey } from '../mcp-server-state';

/** A local (stdio) connection. */
const STDIO: McpServerTransport = { transport: 'stdio', command: 'npx', args: [], env: {} };

/** A remote connection with the given headers and no DorkOS-held sign-in. */
function remote(headers: Record<string, string> = {}): McpServerTransport {
  return { transport: 'http', url: 'https://example.dev/mcp', headers };
}

/** A remote connection DorkOS signs into itself. */
const OAUTH: McpServerTransport = {
  transport: 'http',
  url: 'https://example.dev/mcp',
  headers: {},
  authKind: 'oauth2',
};

describe('classifyFailure', () => {
  it.each([
    ['Validation failed: missing required field "command"', 'setup-problem'],
    ['spawn npx ENOENT', 'setup-problem'],
    ['sh: mcp-server: command not found', 'setup-problem'],
    ['Invalid configuration for server "x"', 'setup-problem'],
    ['connect ECONNREFUSED 127.0.0.1:9000', 'cant-reach'],
    ['socket hang up', 'cant-reach'],
    ['Streamable HTTP error: 503 Service Unavailable', 'cant-reach'],
  ])('classifies %j as %s', (error, expected) => {
    expect(classifyFailure(error)).toBe(expected);
  });

  it('falls through to unreachable when there is no error at all', () => {
    // The safer half to be wrong about: "it didn't answer" sends a person to Try
    // again; "your setup is broken" sends them to edit a file that may be fine.
    expect(classifyFailure(undefined)).toBe('cant-reach');
  });

  it.each([
    ['{"error":"invalid_grant","error_description":"refresh token expired"}'],
    ['401 Unauthorized: invalid_token'],
  ])('does not call an expired sign-in a setup problem: %j', (error) => {
    // These are auth failures wearing the word "invalid". A bare `invalid` marker
    // swept them up and told people to go and fix a config that was never wrong.
    expect(classifyFailure(error)).toBe('cant-reach');
  });
});

describe('usesOwnKey', () => {
  it('is true only for a remote server carrying an Authorization header of its own', () => {
    expect(usesOwnKey(remote({ Authorization: 'Bearer abc' }))).toBe(true);
    // Header names are case-insensitive on the wire, so the check must be too.
    expect(usesOwnKey(remote({ authorization: 'Bearer abc' }))).toBe(true);
  });

  it('is false for a local command, a bare remote, and an OAuth server', () => {
    expect(usesOwnKey(STDIO)).toBe(false);
    expect(usesOwnKey(remote())).toBe(false);
    // An OAuth server's bearer is DorkOS's to hold, not a key the operator added
    // — calling it "Uses your key" would credit the wrong party.
    expect(usesOwnKey({ ...OAUTH, headers: { Authorization: 'Bearer injected' } })).toBe(false);
  });

  it('ignores a non-auth header', () => {
    expect(usesOwnKey(remote({ 'X-Tenant': 'acme' }))).toBe(false);
  });
});

describe('holdsSignIn', () => {
  it('is true for an OAuth server, and for any server the listing has an opinion about', () => {
    expect(holdsSignIn({ connection: OAUTH, authStatus: undefined })).toBe(true);
    expect(holdsSignIn({ connection: remote(), authStatus: 'connected' })).toBe(true);
    expect(holdsSignIn({ connection: remote(), authStatus: 'needs-auth' })).toBe(true);
  });

  it('is false for a local command and for a remote server nothing holds a sign-in for', () => {
    // These are the two cases where "Sign in again" / "Sign out" would be actions
    // against a credential DorkOS does not have.
    expect(holdsSignIn({ connection: STDIO, authStatus: undefined })).toBe(false);
    expect(holdsSignIn({ connection: remote({ Authorization: 'k' }), authStatus: undefined })).toBe(
      false
    );
  });
});

describe('probeAdjustedStatus', () => {
  it('lets a live 401 drive the sentence even while the chip reads Connected', () => {
    // The DOR-985 shape: the runtime's cache from the last turn still says
    // connected, and the card rightly offers Sign in off the probe. The sentence
    // has to agree with the button, not with the chip — "12 tools available"
    // beside a Sign in button is the same contradiction from the other side.
    expect(
      probeAdjustedStatus({ status: 'connected', probe: { ok: false, needsAuth: true } })
    ).toBe('needs-sign-in');
  });

  it('classifies a failed probe the same way a runtime failure is classified', () => {
    expect(
      probeAdjustedStatus({ status: 'connected', probe: { ok: false, error: 'ECONNREFUSED' } })
    ).toBe('cant-reach');
    expect(
      probeAdjustedStatus({ status: 'connected', probe: { ok: false, error: 'Validation failed' } })
    ).toBe('setup-problem');
  });

  it('leaves the status alone for an OK probe or no probe at all', () => {
    expect(probeAdjustedStatus({ status: 'signed-in', probe: { ok: true, toolCount: 3 } })).toBe(
      'signed-in'
    );
    expect(probeAdjustedStatus({ status: 'not-checked', probe: undefined })).toBe('not-checked');
  });

  it('never overrides Off', () => {
    // A turned-off server has nothing to do, whatever a probe from before it was
    // turned off once found.
    expect(probeAdjustedStatus({ status: 'off', probe: { ok: false, needsAuth: true } })).toBe(
      'off'
    );
  });
});
