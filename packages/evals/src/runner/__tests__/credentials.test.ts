/**
 * Credential resolution: the documented precedence (API key → subscription token
 * → the `claude` sign-in on this machine), what each source can and cannot be
 * handed to, and the fail-closed "nothing resolved" answer.
 *
 * The local sign-in is the whole point of this module — it is how a developer's
 * machine reaches a model every day, and the harness used to refuse to see it.
 * So the tests that matter most are: it IS accepted, it is NOT portable into a
 * container, and its absence together with both variables is still a hard no.
 */
import { describe, it, expect, vi } from 'vitest';
import { describeCredentialSource, type CredentialSource } from '../../types.js';
import {
  resolveModelCredential,
  noCredentialMessage,
  dockerNeedsPortableCredentialMessage,
} from '../credentials.js';

/** A probe that reports the machine as signed in (or not) without spawning anything. */
function localLogin(signedIn: boolean): () => Promise<boolean> {
  return vi.fn(async () => signedIn);
}

describe('resolveModelCredential', () => {
  it('prefers ANTHROPIC_API_KEY and carries it as a value', async () => {
    const probe = localLogin(true);
    const credential = await resolveModelCredential({
      env: { ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test' },
      probeLocalLogin: probe,
    });

    expect(credential).toEqual({
      source: 'anthropic-api-key',
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      portable: true,
    });
    // Never pay for a subprocess when a key already answered.
    expect(probe).not.toHaveBeenCalled();
  });

  it('falls back to CLAUDE_CODE_OAUTH_TOKEN, which is the only other name it reads', async () => {
    const credential = await resolveModelCredential({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test', SOME_OTHER_SECRET: 'nope' },
      probeLocalLogin: localLogin(false),
    });

    // Pinned by name on purpose: a caller-chosen variable name was a credential
    // disclosure lever, so nothing else in the environment may be picked up.
    expect(credential).toEqual({
      source: 'claude-oauth-token',
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test' },
      portable: true,
    });
  });

  it('accepts the `claude` sign-in on this machine when neither variable is set', async () => {
    const credential = await resolveModelCredential({
      env: {},
      probeLocalLogin: localLogin(true),
    });

    expect(credential?.source).toBe('local-claude-login');
    // It travels as inherited PATH + HOME, not as a value, so there is nothing
    // to hand to a launched server and nothing a container could be given.
    expect(credential?.env).toEqual({});
    expect(credential?.portable).toBe(false);
  });

  it('treats an empty or whitespace-only variable as unset', async () => {
    const credential = await resolveModelCredential({
      env: { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '   ' },
      probeLocalLogin: localLogin(true),
    });

    // CI passes `ANTHROPIC_API_KEY: ${{ secrets.… }}` unconditionally, so an
    // unconfigured secret arrives as an empty string rather than as absent.
    expect(credential?.source).toBe('local-claude-login');
  });

  it('resolves nothing when no source answers (the fail-closed input)', async () => {
    const credential = await resolveModelCredential({
      env: {},
      probeLocalLogin: localLogin(false),
    });
    expect(credential).toBeUndefined();
  });
});

describe('credential reporting', () => {
  it('describes each source in a line that says who pays', () => {
    expect(describeCredentialSource('local-claude-login')).toContain(
      'your own Claude subscription'
    );
    expect(describeCredentialSource('anthropic-api-key')).toContain('ANTHROPIC_API_KEY');
  });

  it('never throws on an unrecognized source', () => {
    // This runs while rendering the summary table. A report printer that can die
    // over a label would take the whole run's output with it, including the
    // results a reader needs in order to see what went wrong.
    const bogus = 'something-that-does-not-exist' as CredentialSource;
    expect(() => describeCredentialSource(bogus)).not.toThrow();
    expect(describeCredentialSource(bogus)).toContain('unrecognized');
  });
});

describe('credential failure messages', () => {
  it('names all three fixes when nothing resolved', () => {
    const message = noCredentialMessage('claude-code-cheap');
    expect(message).toContain('claude auth login');
    expect(message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(message).toContain('ANTHROPIC_API_KEY');
  });

  it('tells a docker-tier run how to proceed without weakening the container', () => {
    const message = dockerNeedsPortableCredentialMessage();
    expect(message).toContain('ANTHROPIC_API_KEY');
    expect(message).toContain('--isolation child-process');
    // It must never suggest mounting host credentials into the container.
    expect(message).not.toMatch(/mount/i);
  });
});
