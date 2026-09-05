/**
 * Sandbox isolation: each eval gets a fresh temp `DORK_HOME` + project cwd that
 * exist on creation, are removed on a clean teardown, and are RETAINED when a
 * failed run asks to keep them for debugging.
 */
import { describe, it, expect } from 'vitest';
import { stat, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
  it('creates an isolated DORK_HOME and project cwd under the (canonicalized) OS temp dir', async () => {
    // The sandbox realpath's its root (so it matches the server's realpath'd
    // filesystem boundary), so compare against the canonicalized temp dir — on
    // macOS `os.tmpdir()` is `/var/...`, a symlink to `/private/var/...`.
    const tmpRoot = await realpath(tmpdir());
    const sandbox = await createSandbox();
    try {
      expect(sandbox.dorkHome.startsWith(tmpRoot)).toBe(true);
      expect(sandbox.projectCwd.startsWith(tmpRoot)).toBe(true);
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

  it('creates a controlled Claude config dir beside them, and removes it with the rest', async () => {
    const tmpRoot = await realpath(tmpdir());
    const sandbox = await createSandbox();
    // What is measured must not be a fact about the operator's home: this is
    // where a turn's user-level settings, CLAUDE.md and skills come from
    // (DOR-1712), so it belongs in the throwaway root like everything else.
    expect(sandbox.claudeConfigDir.startsWith(tmpRoot)).toBe(true);
    expect(await exists(sandbox.claudeConfigDir)).toBe(true);

    // The trust gate is keyed by project path, so the config dir must be seeded
    // with THIS sandbox's own cwd. Asserting the two agree is what stops the
    // sandbox layout and the seed from drifting apart in separate modules.
    const state = JSON.parse(
      await readFile(path.join(sandbox.claudeConfigDir, '.claude.json'), 'utf8')
    ) as { projects: Record<string, { hasTrustDialogAccepted: unknown }> };
    expect(state.projects[sandbox.projectCwd]?.hasTrustDialogAccepted).toBe(true);

    await sandbox.cleanup();
    expect(await exists(sandbox.claudeConfigDir)).toBe(false);
  });

  it('puts the config dir at `<root>/.claude`, so a HOME on the root resolves ~/.claude onto it', async () => {
    const sandbox = await createSandbox();
    try {
      // The launcher pins the child's HOME to the sandbox root when it pins the
      // config dir (DOR-1779). That is only a TOTAL isolation of the server's
      // Claude root set — which unions in `~/.claude` unconditionally — because
      // the seed sits at exactly the path `~/.claude` then resolves to. Move the
      // seed and the union quietly widens back onto the operator again, so this
      // layout is load-bearing rather than incidental.
      const sandboxRoot = path.dirname(sandbox.dorkHome);
      expect(sandbox.claudeConfigDir).toBe(path.join(sandboxRoot, '.claude'));
      // And it QUALIFIES as an account root (`isClaudeAccountRoot`: it holds a
      // `projects/`), so the collapsed union is a real, empty root rather than a
      // path the server skips — which would leave the union empty and the fix
      // untestable from the outside.
      expect(await exists(path.join(sandbox.claudeConfigDir, 'projects'))).toBe(true);
    } finally {
      await sandbox.cleanup();
    }
  });

  it('removes even a failed sandbox when retainOnFailure is off', async () => {
    const sandbox = await createSandbox({ retainOnFailure: false });
    await sandbox.cleanup({ failed: true });
    expect(await exists(sandbox.dorkHome)).toBe(false);
  });
});
