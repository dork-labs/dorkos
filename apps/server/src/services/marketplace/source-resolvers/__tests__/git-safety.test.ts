/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { hardenedGitEnv } from '../git-safety.js';

describe('hardenedGitEnv', () => {
  it('confines git to the https/ssh/git transports (blocks ext::/file::)', () => {
    expect(hardenedGitEnv().GIT_ALLOW_PROTOCOL).toBe('https:ssh:git');
  });

  it('disables the interactive credential prompt so a private URL cannot hang', () => {
    expect(hardenedGitEnv().GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('inherits the parent environment so git keeps its PATH', () => {
    // eslint-disable-next-line no-restricted-syntax -- asserting inheritance of a real env var in a test
    expect(hardenedGitEnv().PATH).toBe(process.env.PATH);
  });
});
