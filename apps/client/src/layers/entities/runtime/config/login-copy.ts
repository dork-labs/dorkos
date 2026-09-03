/**
 * Per-runtime wording for the delegated sign-in — the ONE copy table every
 * surface that offers a sign-in reads.
 *
 * It lives in `entities/runtime` because two features now render the same
 * action: the Settings connect flow and the chat auth-error card that signs in
 * without leaving the conversation (DOR-1651). "Sign in with ChatGPT" is not a
 * detail either one may decide for itself — a person who reads it in Settings
 * and something else in chat has been told the runtimes differ when they do not.
 *
 * @module entities/runtime/config/login-copy
 */

/** Per-runtime copy for the delegated login flow — honest, provider-specific wording. */
export interface LoginCopy {
  /** Label on the delegated sign-in button. */
  signInLabel: string;
  /** One-line hint under the sign-in button. */
  signInHint: string;
  /** Status line shown while the delegated login is in flight. */
  signInPending: string;
  /** Label above the paste-key input. */
  keyLabel: string;
  /** Placeholder for the key input (a format hint, never a real key). */
  keyPlaceholder: string;
  /** Optional "get a key" link. */
  getKeyUrl?: string;
}

const LOGIN_COPY: Record<string, LoginCopy> = {
  'claude-code': {
    signInLabel: 'Sign in',
    signInHint: 'Use your Claude subscription or Anthropic account.',
    signInPending: 'Waiting for sign-in to complete…',
    keyLabel: 'Anthropic API key',
    keyPlaceholder: 'sk-ant-…',
    getKeyUrl: 'https://console.anthropic.com/settings/keys',
  },
  codex: {
    signInLabel: 'Sign in with ChatGPT',
    signInHint: 'Use your ChatGPT account.',
    signInPending: 'Waiting for sign-in to complete…',
    keyLabel: 'OpenAI API key',
    keyPlaceholder: 'sk-…',
    getKeyUrl: 'https://platform.openai.com/api-keys',
  },
};

/**
 * Sign-in wording for a runtime, falling back to the Claude Code copy for an
 * unknown type so a surface still renders something honest and generic.
 *
 * @param type - Runtime type identifier (e.g. `'codex'`).
 */
export function getLoginCopy(type: string): LoginCopy {
  return LOGIN_COPY[type] ?? LOGIN_COPY['claude-code'];
}
