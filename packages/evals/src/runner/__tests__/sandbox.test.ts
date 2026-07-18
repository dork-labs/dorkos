/**
 * Sandbox isolation: each eval gets a fresh temp `DORK_HOME` + project cwd that
 * exist on creation, are removed on a clean teardown, and are RETAINED when a
 * failed run asks to keep them for debugging.
 */
import { describe, it, expect } from 'vitest';
import { stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createSandbox } from '../sandbox.js';

/** Resolve true iff `p` exists on disk. */
async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('createSandbox', () => {
  it('creates an isolated DORK_HOME and project cwd under the OS temp dir', async () => {
    const sandbox = await createSandbox();
    try {
      expect(sandbox.dorkHome.startsWith(tmpdir())).toBe(true);
      expect(sandbox.projectCwd.startsWith(tmpdir())).toBe(true);
      expect(sandbox.dorkHome).not.toBe(sandbox.projectCwd);
      expect(await exists(sandbox.dorkHome)).toBe(true);
      expect(await exists(sandbox.projectCwd)).toBe(true);
    } finally {
      await sandbox.cleanup();
    }
  });

  it('gives every sandbox a distinct directory (no cross-eval bleed)', async () => {
    const a = await createSandbox();
    const b = await createSandbox();
    try {
      expect(a.dorkHome).not.toBe(b.dorkHome);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  it('cleanup() removes the sandbox on a clean run', async () => {
    const sandbox = await createSandbox();
    await sandbox.cleanup();
    expect(await exists(sandbox.dorkHome)).toBe(false);
    expect(await exists(sandbox.projectCwd)).toBe(false);
  });

  it('retains the sandbox on failure for debugging (retainOnFailure default)', async () => {
    const sandbox = await createSandbox();
    await sandbox.cleanup({ failed: true });
    expect(await exists(sandbox.dorkHome)).toBe(true);
    // Explicit clean teardown still removes it.
    await sandbox.cleanup();
    expect(await exists(sandbox.dorkHome)).toBe(false);
  });

  it('removes even a failed sandbox when retainOnFailure is off', async () => {
    const sandbox = await createSandbox({ retainOnFailure: false });
    await sandbox.cleanup({ failed: true });
    expect(await exists(sandbox.dorkHome)).toBe(false);
  });
});
