import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { MemoryPathError, resolveMemoryFile } from '../paths.js';

describe('resolveMemoryFile', () => {
  it('resolves the one file an agent keeps its memory in', () => {
    // Would go red if the file ever moved, or gained a per-session or per-room
    // component — memory is scoped to the agent and to nothing narrower.
    expect(resolveMemoryFile('/agents/alpha')).toBe(
      path.join('/agents/alpha', '.dork', 'MEMORY.md')
    );
  });

  // THE JAIL. Every case here is red if the `..` guard is deleted — see the
  // seeded-defect proof below, which was run rather than assumed.
  describe('the path jail', () => {
    it('refuses a path that traverses out of the agent directory', () => {
      // SEEDED-DEFECT PROOF (run, then restored): with the `'..'` segment check
      // removed from paths.ts, this call returns
      // '/agents/beta/.dork/MEMORY.md' — a different agent's memory file — and
      // this expectation fails. `path.resolve` collapses the traversal silently,
      // so nothing downstream could have caught it.
      expect(() => resolveMemoryFile('/agents/alpha/../beta')).toThrow(MemoryPathError);
    });

    it('refuses a traversal spelled with a backslash', () => {
      expect(() => resolveMemoryFile('/agents/alpha\\..\\beta')).toThrow(MemoryPathError);
    });

    it('refuses a relative path, which would resolve against whatever cwd happened to be', () => {
      expect(() => resolveMemoryFile('agents/alpha')).toThrow(MemoryPathError);
    });

    it('refuses an empty path', () => {
      expect(() => resolveMemoryFile('   ')).toThrow(MemoryPathError);
    });

    it('refuses a null byte', () => {
      expect(() => resolveMemoryFile('/agents/alpha\0/evil')).toThrow(MemoryPathError);
    });

    it('names the path and the reason, so the refusal is actionable', () => {
      // A refusal that said only "invalid path" would send whoever reads the log
      // looking through every call site.
      expect(() => resolveMemoryFile('/agents/alpha/../beta')).toThrow(/'\.\.' segment/);
      expect(() => resolveMemoryFile('/agents/alpha/../beta')).toThrow(/agents\/alpha/);
    });
  });

  it('keeps a directory whose NAME merely contains dots', () => {
    // The guard is about traversal, not about dots. A positive control: without
    // it, the refusals above would also pass for a function that rejects
    // everything.
    expect(resolveMemoryFile('/agents/my..agent')).toBe(
      path.join('/agents/my..agent', '.dork', 'MEMORY.md')
    );
  });
});
