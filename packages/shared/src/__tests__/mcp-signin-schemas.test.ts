/**
 * The in-conversation MCP sign-in schemas (DOR-1004).
 *
 * The scheme guard is the part worth pinning. This URL is composed server-side
 * and rendered as a link a person is being TOLD it is safe to click, under a
 * disclosure explaining what they are authorizing — so the one thing the schema
 * must never do is let an arbitrary scheme through to that button.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { McpSigninRequiredEventSchema, McpSigninPartSchema } from '../schemas.js';

const BASE = {
  serverName: 'granola',
  agentId: '01HV7KJZZZ0000000000000000',
  flowId: 'flow-1',
  disclosure: 'DorkOS stores the token on this machine.',
};

/** Whether the event schema accepts this sign-in URL. */
function accepts(authorizeUrl: string): boolean {
  return McpSigninRequiredEventSchema.safeParse({ ...BASE, authorizeUrl }).success;
}

describe('sign-in link scheme guard', () => {
  it.each([
    'https://mcp.granola.ai/authorize?code_challenge=abc',
    'https://localhost:8443/authorize',
  ])('accepts %s', (url) => {
    expect(accepts(url)).toBe(true);
  });

  it.each([
    'http://localhost:9000/authorize',
    'http://127.0.0.1:9000/authorize',
    'http://[::1]:9000/authorize',
  ])('accepts loopback over plain http: %s', (url) => {
    // A provider running on this machine — a local MCP server, or the in-process
    // mock the OAuth tests drive — is reached over http, and nothing leaves the
    // box.
    expect(accepts(url)).toBe(true);
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'http://evil.example/authorize',
    'not-a-url',
    '',
  ])('refuses %s', (url) => {
    expect(accepts(url)).toBe(false);
  });

  it('guards the message PART as well as the event', () => {
    // The part is what the renderer reads. Guarding only the event would leave
    // the guard one refactor away from being bypassed.
    expect(
      McpSigninPartSchema.safeParse({
        type: 'mcp_signin',
        ...BASE,
        authorizeUrl: 'javascript:alert(1)',
      }).success
    ).toBe(false);
  });
});

describe('sign-in receipt fields', () => {
  it('accepts a settled receipt carrying its tool count', () => {
    const parsed = McpSigninPartSchema.safeParse({
      type: 'mcp_signin',
      ...BASE,
      authorizeUrl: 'https://mcp.granola.ai/authorize',
      outcome: 'connected',
      toolCount: 7,
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a negative tool count', () => {
    expect(
      McpSigninPartSchema.safeParse({
        type: 'mcp_signin',
        ...BASE,
        authorizeUrl: 'https://mcp.granola.ai/authorize',
        outcome: 'connected',
        toolCount: -1,
      }).success
    ).toBe(false);
  });
});
