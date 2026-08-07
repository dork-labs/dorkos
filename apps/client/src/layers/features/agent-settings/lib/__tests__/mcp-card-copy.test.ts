/**
 * The Details "Sign-in" row's sentence — specifically what it says once a person
 * has supplied their own app credentials (DOR-982).
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import type { McpServerTransport } from '@dorkos/shared/mesh-schemas';
import { signInRowCopy } from '../mcp-card-copy';

const OAUTH_SERVER: McpServerTransport = {
  transport: 'http',
  url: 'https://mcp.example/mcp',
  headers: {},
  authKind: 'oauth2',
};

describe('signInRowCopy', () => {
  it('says whose app credentials are in use, and still who holds the key', () => {
    const copy = signInRowCopy({
      connection: OAUTH_SERVER,
      authStatus: 'connected',
      clientOrigin: 'manual',
    });

    expect(copy).toContain('using your own app credentials');
    expect(copy).toContain('signed in');
    // The custody promise holds either way — it is the reason the row exists.
    expect(copy).toContain('the agent never sees it');
  });

  it('does not claim a sign-in that has not happened yet', () => {
    const copy = signInRowCopy({
      connection: OAUTH_SERVER,
      authStatus: undefined,
      clientOrigin: 'manual',
    });

    expect(copy).toContain('using your own app credentials');
    expect(copy).toContain('not signed in yet');
    expect(copy).not.toContain('renews automatically');
  });

  it('says nothing extra when DorkOS registered itself, which is the ordinary case', () => {
    // Naming automatic registration would be noise on every card that has it.
    const copy = signInRowCopy({
      connection: OAUTH_SERVER,
      authStatus: 'connected',
      clientOrigin: 'dcr',
    });

    expect(copy).not.toContain('your own app credentials');
    expect(copy).toContain('signed in, and it renews automatically');
  });

  it('is unchanged for a server whose origin is unknown', () => {
    expect(signInRowCopy({ connection: OAUTH_SERVER, authStatus: 'connected' })).toBe(
      signInRowCopy({ connection: OAUTH_SERVER, authStatus: 'connected', clientOrigin: 'dcr' })
    );
  });
});
