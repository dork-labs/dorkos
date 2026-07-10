import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';
import { resolveClaudeConfigDir } from '../claude-config-dir.js';

describe('resolveClaudeConfigDir', () => {
  const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;

  beforeEach(() => {
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
    }
  });

  it('defaults to ~/.claude when CLAUDE_CONFIG_DIR is unset', () => {
    expect(resolveClaudeConfigDir()).toBe(path.join(os.homedir(), '.claude'));
  });

  it('honors CLAUDE_CONFIG_DIR when set, matching the SDK subprocess', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/custom-claude-config';
    expect(resolveClaudeConfigDir()).toBe('/tmp/custom-claude-config');
  });

  it('re-reads the env var on every call (no stale caching)', () => {
    expect(resolveClaudeConfigDir()).toBe(path.join(os.homedir(), '.claude'));
    process.env.CLAUDE_CONFIG_DIR = '/tmp/second-config';
    expect(resolveClaudeConfigDir()).toBe('/tmp/second-config');
  });
});
