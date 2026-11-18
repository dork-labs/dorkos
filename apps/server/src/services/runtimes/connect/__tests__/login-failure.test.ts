import { describe, it, expect } from 'vitest';
import { StderrSample, classifyLoginFailure, loginFailureMessage } from '../login-failure.js';

/** Made-up stand-ins for what a vendor CLI might print. None is a real credential. */
const FAKE_TOKEN = 'sk-ant-fake-0000-made-up';
const FAKE_URL = 'https://example.invalid/oauth?code=made-up-code';

/** A stderr sample holding exactly `text`. */
function sample(text: string): StderrSample {
  const s = new StderrSample();
  if (text) s.push(Buffer.from(text));
  return s;
}

/** The reason a non-zero exit with this stderr is sorted into. */
function reasonFor(stderr: string): string {
  return classifyLoginFailure({ kind: 'exit', code: 1, signal: null, stderr: sample(stderr) })
    .reason;
}

describe('classifyLoginFailure', () => {
  it('names a timeout and the step it stopped at', () => {
    expect(classifyLoginFailure({ kind: 'timeout' })).toEqual({
      reason: 'timeout',
      step: 'waiting_for_browser',
    });
  });

  it('keeps a spawn error code, and only a code', () => {
    expect(classifyLoginFailure({ kind: 'spawn', code: 'ENOENT' })).toEqual({
      reason: 'spawn_failed',
      step: 'start',
      errno: 'ENOENT',
    });
    // Anything that is not an errno-shaped code is dropped, never logged.
    expect(classifyLoginFailure({ kind: 'spawn', code: `bad ${FAKE_TOKEN}` })).toEqual({
      reason: 'spawn_failed',
      step: 'start',
    });
  });

  it('records the exit code, the step and the stderr size, never stderr text', () => {
    const text = `Login failed: ${FAKE_TOKEN} ${FAKE_URL}\nmore`;
    const failure = classifyLoginFailure({
      kind: 'exit',
      code: 1,
      signal: null,
      stderr: sample(text),
    });
    expect(failure).toEqual({
      reason: 'exited',
      step: 'oauth_flow',
      exitCode: 1,
      stderrBytes: Buffer.byteLength(text),
    });
    const logged = JSON.stringify(failure);
    expect(logged).not.toContain(FAKE_TOKEN);
    expect(logged).not.toContain('example.invalid');
    expect(logged).not.toContain('Login failed');
  });

  it('records the signal when the CLI was killed', () => {
    expect(
      classifyLoginFailure({ kind: 'exit', code: null, signal: 'SIGTERM', stderr: sample('') })
    ).toEqual({ reason: 'exited', step: 'unknown', signal: 'SIGTERM', stderrBytes: 0 });
  });

  it('tells a network failure apart', () => {
    expect(reasonFor('Login failed: connect ECONNREFUSED 127.0.0.1:443')).toBe('network');
    expect(reasonFor('Login failed: fetch failed')).toBe('network');
  });

  it('tells a credential-store failure apart', () => {
    expect(reasonFor('Login failed: could not write to the keychain')).toBe('credential_store');
  });

  it('tells a refused account apart', () => {
    expect(reasonFor('Login failed: this organization is not allowed')).toBe('refused');
    expect(reasonFor('Login failed: Request failed with status code 403')).toBe('refused');
  });

  it('does not read a cause into a bare word', () => {
    // "organization" and "network" turn up in progress lines and stack paths.
    expect(reasonFor('Fetching organization details\nLogin failed: unexpected')).toBe('exited');
    expect(reasonFor('at /app/node_modules/network-utils/index.js:1\nexit')).toBe('exited');
  });

  it('names the refresh-token step', () => {
    expect(
      classifyLoginFailure({
        kind: 'exit',
        code: 1,
        signal: null,
        stderr: sample('Login from refresh token failed: expired'),
      }).step
    ).toBe('refresh_token');
  });

  it('keeps the first line and the full size when stderr runs long', () => {
    const s = new StderrSample();
    s.push(Buffer.from('Login failed: see below\n'));
    for (let i = 0; i < 40; i++) s.push(Buffer.from(`${'x'.repeat(500)}\n`));
    s.push(Buffer.from('connect ECONNRESET'));
    const failure = classifyLoginFailure({ kind: 'exit', code: 1, signal: null, stderr: s });
    expect(failure.step).toBe('oauth_flow');
    expect(failure.reason).toBe('network');
    expect(failure.stderrBytes).toBe(24 + 40 * 501 + 18);
    // Bounded: the sample never holds the whole 20 KB.
    expect(s.text().length).toBeLessThan(10_000);
  });
});

describe('loginFailureMessage', () => {
  it('gives every reason its own line with a next step, in at most 15 words', () => {
    const reasons = [
      'timeout',
      'spawn_failed',
      'network',
      'credential_store',
      'refused',
      'exited',
    ] as const;
    const lines = reasons.map((reason) => loginFailureMessage(reason));
    expect(new Set(lines).size).toBe(reasons.length);
    for (const line of lines) {
      expect(line.split(/\s+/).length).toBeLessThanOrEqual(15);
      // A reason, then what to do: every line ends on an action.
      expect(line).toMatch(/(try again|terminal|account)\.$/i);
    }
  });

  it('says one minute, not one minutes', () => {
    expect(loginFailureMessage('timeout', 1)).toContain('within 1 minute,');
  });
});
