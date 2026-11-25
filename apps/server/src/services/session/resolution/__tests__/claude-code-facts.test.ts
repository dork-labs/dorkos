/**
 * The port turn code reads Claude Code's folder answers through (DOR-4928): before the
 * startup registers them, every answer grants nothing. That the startup does register them is
 * `startup/__tests__/runtimes-agent-computer.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { claudeCodeFacts } from '../claude-code-facts.js';

const UNREGISTERED = claudeCodeFacts();

describe('claudeCodeFacts', () => {
  it('grants nothing before anything registers', () => {
    // Purpose: fails if an unwired server could honour an agent file's runtime, call a folder
    // the credits folder, or point a carry-over at a transcript it never located.
    expect(UNREGISTERED.runtimeUnlessHeld({ id: 'a', runtime: 'codex' }, '/agents/a')).toBe(
      undefined
    );
    expect(UNREGISTERED.isCreditsRoot('/any/folder')).toBe(false);
    expect(UNREGISTERED.transcriptPath('/accounts/work', '/p', 's-1')).toBeNull();
  });
});
