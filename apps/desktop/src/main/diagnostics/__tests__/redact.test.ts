import { describe, it, expect } from 'vitest';
import { SENSITIVE_CONFIG_KEYS } from '@dorkos/shared/config-schema';
import { REDACTED, redactSecrets } from '../redact';

/** Set a dotted path on a plain object, creating the sections it needs. */
function setAtPath(root: Record<string, unknown>, dotted: string, value: unknown): void {
  const segments = dotted.split('.');
  const leaf = segments.pop() as string;
  let node = root;
  for (const segment of segments) {
    node[segment] ??= {};
    node = node[segment] as Record<string, unknown>;
  }
  node[leaf] = value;
}

/** Read a dotted path back out, or `undefined` if any segment is missing. */
function readAtPath(root: unknown, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>(
      (node, segment) =>
        node !== null && typeof node === 'object'
          ? (node as Record<string, unknown>)[segment]
          : undefined,
      root
    );
}

describe('redactSecrets — the paths the schema declares sensitive', () => {
  /**
   * Built from `SENSITIVE_CONFIG_KEYS` rather than a hand-written list, so a
   * fifth credential added to the schema is covered here without anyone
   * remembering that this file exists. The hand-written version of this test
   * shipped a regex that missed `tunnel.auth`.
   */
  it('masks every key the schema declares sensitive, and leaks none of their values', () => {
    const config: Record<string, unknown> = {};
    const secrets = SENSITIVE_CONFIG_KEYS.map((key, index) => `s3cret-${index}-${key}`);
    SENSITIVE_CONFIG_KEYS.forEach((key, index) => setAtPath(config, key, secrets[index]));

    const redacted = redactSecrets(config);

    for (const key of SENSITIVE_CONFIG_KEYS) expect(readAtPath(redacted, key)).toBe(REDACTED);
    for (const secret of secrets) expect(JSON.stringify(redacted)).not.toContain(secret);
  });

  it('masks tunnel.auth, whose name says nothing about holding a password', () => {
    // The regression this pass exists for: `tunnel.auth` is an ngrok
    // basic-auth `user:password` pair, and a name-based rule waved it through
    // into a file called config-redacted.json.
    const redacted = redactSecrets({ tunnel: { authtoken: 'ngrok-tok', auth: 'lil:hunter2' } });

    expect(redacted).toEqual({ tunnel: { authtoken: REDACTED, auth: REDACTED } });
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
  });

  it('masks a sensitive path even when its value is an object', () => {
    expect(redactSecrets({ mcp: { apiKey: { ref: 'keychain://dorkos/mcp' } } })).toEqual({
      mcp: { apiKey: REDACTED },
    });
  });
});

describe('redactSecrets — the key-name pass, for what the schema cannot know', () => {
  it('masks the obvious secret-bearing key names', () => {
    const redacted = redactSecrets({
      apiKey: 'sk-ant-live-000',
      accessToken: 'ghp_000',
      clientSecret: 'shhh',
      password: 'hunter2',
      passphrase: 'correct horse',
      githubCredential: 'x',
    });

    expect(redacted).toEqual({
      apiKey: REDACTED,
      accessToken: REDACTED,
      clientSecret: REDACTED,
      password: REDACTED,
      passphrase: REDACTED,
      githubCredential: REDACTED,
    });
  });

  it('matches regardless of case or surrounding words', () => {
    expect(redactSecrets({ ANTHROPIC_API_KEY: 'sk-000', myTokenStore: 'x' })).toEqual({
      ANTHROPIC_API_KEY: REDACTED,
      myTokenStore: REDACTED,
    });
  });

  it('masks a secret nested somewhere the schema has no path for', () => {
    const redacted = redactSecrets({
      mcpServers: { linear: { url: 'https://mcp.linear.app', env: { API_KEY: 'sk-000' } } },
    });

    expect(redacted).toEqual({
      mcpServers: { linear: { url: 'https://mcp.linear.app', env: { API_KEY: REDACTED } } },
    });
  });

  it('masks a secret-named key wholesale, even when it holds an object', () => {
    // Over-redaction on purpose: a credential that moved one level deeper is
    // still covered, at the cost of a structure a reader cannot inspect.
    expect(redactSecrets({ tokens: { github: 'ghp_000', linear: 'lin_000' } })).toEqual({
      tokens: REDACTED,
    });
  });

  it('masks an auth-named field anywhere, accepting auth.enabled as collateral', () => {
    // No exemption for "obviously harmless" values: the rule that would have
    // spared `auth.enabled` is the rule that spared `tunnel.auth`.
    expect(redactSecrets({ auth: { enabled: true } })).toEqual({ auth: REDACTED });
  });

  it('walks into arrays of objects', () => {
    expect(redactSecrets([{ name: 'a', apiKey: 'sk-1' }, { name: 'b' }])).toEqual([
      { name: 'a', apiKey: REDACTED },
      { name: 'b' },
    ]);
  });
});

describe('redactSecrets — what it must leave alone', () => {
  it('leaves non-secret config exactly as it was, structure included', () => {
    const config = {
      server: { port: 4242, cwd: '/Users/someone/code', boundary: null },
      runtimes: { defaultType: 'claude-code' },
      rooms: [{ name: 'team', replyLimit: 12 }],
      tunnel: { enabled: false, region: 'us' },
    };

    expect(redactSecrets(config)).toEqual(config);
  });

  it('passes primitives and null through untouched', () => {
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets('a string with a token in it')).toBe('a string with a token in it');
    expect(redactSecrets(false)).toBe(false);
  });

  it('never mutates the input', () => {
    const config = { tunnel: { auth: 'lil:hunter2' }, nested: { password: 'hunter2' } };

    redactSecrets(config);

    expect(config).toEqual({ tunnel: { auth: 'lil:hunter2' }, nested: { password: 'hunter2' } });
  });
});
