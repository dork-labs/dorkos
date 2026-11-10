import { describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { secretValuesFromEnv, sweepContextBody } from '../turn-context-redaction.js';
import { TurnContextStore } from '../turn-context-store.js';

/** All made up, in the shapes the real ones take. */
const MCP_TOKEN = `dork_mcp_local_${'ab12'.repeat(16)}`;
const PROVIDER_KEY = 'sk-ant-api03-madeUpKeyForTheTest0123456789';
const BEARER = 'Bearer abcDEF0123456789ghiJKL';

describe('sweepContextBody', () => {
  it('leaves an ordinary prompt byte-for-byte alone, fence nonces included', () => {
    const prompt = [
      '--- BEGIN CHAT MESSAGE 4e90b299 ---',
      'From: DorkOS Code (agent 01KJXYKJYW4N8QGQ5W4GB6YM9J)',
      'Port: 4242. Read the brief, then open the PR on `hold`.',
      '--- END CHAT MESSAGE 4e90b299 ---',
    ].join('\n');
    expect(sweepContextBody(prompt, [])).toEqual({ text: prompt, redacted: false });
  });

  it('sweeps the local MCP token by its shape even when its value is not known', () => {
    const swept = sweepContextBody(`token is ${MCP_TOKEN} ok`, []);
    expect(swept.text).not.toContain(MCP_TOKEN);
    expect(swept.redacted).toBe(true);
  });

  it('sweeps provider keys and bearer values', () => {
    const swept = sweepContextBody(`key ${PROVIDER_KEY}\nAuthorization: ${BEARER}`, []);
    expect(swept.text).not.toContain(PROVIDER_KEY);
    expect(swept.text).not.toContain('abcDEF0123456789ghiJKL');
    expect(swept.redacted).toBe(true);
  });

  it('sweeps a known secret value of any shape, wherever it appears', () => {
    const value = 'plain-words-that-are-really-a-password';
    expect(sweepContextBody(`a ${value} b ${value}`, [value]).text).toBe(
      'a [redacted] b [redacted]'
    );
  });

  it('sweeps a PEM private key block, whole, and one cut off before its end', () => {
    const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7madeUpKey'.repeat(3);
    const block = `-----BEGIN PRIVATE KEY-----\n${body}\n${body}\n-----END PRIVATE KEY-----`;
    const whole = sweepContextBody(`before\n${block}\nafter`, []);
    expect(whole.text).toBe('before\n[redacted]\nafter');
    const rsa = block.replaceAll('PRIVATE KEY', 'RSA PRIVATE KEY');
    expect(sweepContextBody(rsa, []).text).toBe('[redacted]');
    const cut = sweepContextBody(`-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n${body}`, []);
    expect(cut.text).not.toContain(body);
    expect(cut.redacted).toBe(true);
  });

  it('sweeps an agent token (32 hex), bare and as DORKOS_AGENT_TOKEN, though the server never holds its value', () => {
    const token = '0123456789abcdef0123456789abcdef';
    for (const text of [
      `token ${token} here`,
      `DORKOS_AGENT_TOKEN=${token}`,
      `export DORKOS_AGENT_TOKEN="${token}"`,
      `{"DORKOS_AGENT_TOKEN": "${token}"}`,
    ]) {
      const swept = sweepContextBody(text, []);
      expect(swept.text, text).not.toContain(token);
      expect(swept.redacted).toBe(true);
    }
  });

  it('ignores known values too short to be anything but a word', () => {
    expect(sweepContextBody('the cat sat', ['cat']).text).toBe('the cat sat');
  });
});

describe('secretValuesFromEnv', () => {
  it('takes long values of variables named like keys, tokens and secrets, and nothing else', () => {
    expect(
      secretValuesFromEnv({
        ANTHROPIC_API_KEY: 'sk-ant-made-up-value-123',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-made-up-value-456',
        MCP_API_KEY: 'mcp-made-up-value-7890',
        DORKOS_PORT: '4242',
        HOME: '/Users/someone/made-up-home',
        SHORT_TOKEN: 'abc',
      }).sort()
    ).toEqual(
      ['mcp-made-up-value-7890', 'oauth-made-up-value-456', 'sk-ant-made-up-value-123'].sort()
    );
  });
});

describe('the record never holds a secret (Security, Nov 8)', () => {
  it('stores no MCP token, provider key or bearer value from any part', () => {
    const db = createTestDb();
    const store = new TurnContextStore(db, { knownSecrets: () => [MCP_TOKEN] });
    store.record({
      sessionId: 's1',
      runtime: 'opencode',
      place: 'chat',
      systemSentThisTurn: true,
      parts: [
        { slot: 'system', text: `<env>MCP: ${MCP_TOKEN}</env>` },
        { slot: 'synthetic', text: `curl -H "Authorization: ${BEARER}"` },
        { slot: 'message', text: `here is ${PROVIDER_KEY}` },
      ],
    });
    const everything = JSON.stringify(
      db.$client.prepare('SELECT * FROM turn_context_bodies').all()
    );
    for (const secret of [MCP_TOKEN, PROVIDER_KEY, 'abcDEF0123456789ghiJKL']) {
      expect(everything).not.toContain(secret);
    }
    expect(store.listTurnContextsForSession('s1')[0]!.parts.every((part) => part.redacted)).toBe(
      true
    );
  });
});
