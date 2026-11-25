/**
 * The in-process test server registers Claude Code's folder facts the way `start()`
 * does (DOR-4928, `harness-boot.ts`'s KEEP IN SYNC contract): without them its turn
 * code honours no agent file's runtime and its protected-path policy refuses every path.
 * The server's own registration is `startup/__tests__/runtimes-agent-computer.test.ts`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootInProcessTestServer } from '../harness-boot.js';
import { protectedPathRoots } from '../services/core/protected-paths/protected-path-roots.js';
import { isCreditsClaudeRoot } from '../services/runtimes/claude-code/credits-root.js';
import { runtimeUnlessHeld } from '../services/runtimes/claude-code/folder-settings/folder-config-consent.js';
import { claudeTranscriptPath } from '../services/runtimes/claude-code/sessions/project-slug.js';
import { claudeCodeFacts } from '../services/session/resolution/claude-code-facts.js';

const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-boot-facts-')));

// A throwaway home: nothing here reads the real data folder or Claude folders.
beforeAll(() => {
  vi.stubEnv('HOME', sandbox);
  vi.stubEnv('DORK_HOME', path.join(sandbox, '.dork'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(sandbox, '.claude'));
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('bootInProcessTestServer', () => {
  it('registers Claude Code’s folder facts', async () => {
    // Purpose: fails if the harness boot stops calling registerClaudeCodeFacts.
    expect(() => protectedPathRoots(sandbox)).toThrow(/not registered/u);
    const server = await bootInProcessTestServer(path.join(sandbox, '.dork'));
    try {
      expect(claudeCodeFacts()).toEqual({
        runtimeUnlessHeld,
        isCreditsRoot: isCreditsClaudeRoot,
        transcriptPath: claudeTranscriptPath,
      });
      expect(() => protectedPathRoots(sandbox)).not.toThrow();
    } finally {
      server.dispose();
    }
  });
});
