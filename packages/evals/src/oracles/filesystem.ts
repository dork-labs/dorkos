/**
 * Filesystem oracles: assert that a prompt produced (or did NOT produce) a
 * concrete file/dir change inside the sandbox — the install-metadata file that
 * only atomic activation writes, an uninstalled plugin root that is gone, a
 * seeded file whose contents changed, no crash-left `*.dorkos-bak-*` sibling.
 * Every path is resolved from the sandbox (`projectCwd`/`dorkHome`), so an
 * oracle can never read outside the isolated run.
 *
 * @module evals/oracles/filesystem
 */
import { stat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { EvalSandbox, Oracle } from '../types.js';

/** Resolves an absolute path from the eval's sandbox (e.g. a plugin install dir). */
export type SandboxPath = (sandbox: EvalSandbox) => string;

/** Marketplace install-transaction backup suffix (`<target>.dorkos-bak-<ts>-<uuid>`). */
const BACKUP_MARKER = '.dorkos-bak-';

/** Resolve true iff `p` exists on disk. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Oracle: the resolved path exists (a file or directory the prompt should have
 * created — e.g. `.dork/install-metadata.json`, `agent.json`).
 *
 * @param pathOf - Resolves the asserted path from the sandbox.
 * @param label - Human-readable label; defaults to `<resolved path> exists`.
 * @returns An {@link Oracle}.
 */
export function fileExists(pathOf: SandboxPath, label?: string): Oracle {
  return async (ctx) => {
    const target = pathOf(ctx.sandbox);
    const passed = await pathExists(target);
    return {
      label: label ?? `${target} exists`,
      passed,
      evidence: { path: target, exists: passed },
      detail: passed ? undefined : `expected path to exist: ${target}`,
    };
  };
}

/**
 * Oracle: the resolved path is ABSENT (a plugin root that uninstall removed).
 *
 * @param pathOf - Resolves the asserted path from the sandbox.
 * @param label - Human-readable label; defaults to `<resolved path> is absent`.
 * @returns An {@link Oracle}.
 */
export function dirAbsent(pathOf: SandboxPath, label?: string): Oracle {
  return async (ctx) => {
    const target = pathOf(ctx.sandbox);
    const exists = await pathExists(target);
    return {
      label: label ?? `${target} is absent`,
      passed: !exists,
      evidence: { path: target, exists },
      detail: exists ? `expected path to be gone: ${target}` : undefined,
    };
  };
}

/**
 * Oracle: the resolved file exists and its contents satisfy `matcher` (a RegExp
 * to test, or a predicate). Used to prove a seeded file changed from baseline.
 *
 * @param pathOf - Resolves the asserted file from the sandbox.
 * @param matcher - A RegExp tested against the contents, or a content predicate.
 * @param label - Human-readable label; defaults to `<resolved path> matches`.
 * @returns An {@link Oracle}.
 */
export function fileMatches(
  pathOf: SandboxPath,
  matcher: RegExp | ((content: string) => boolean),
  label?: string
): Oracle {
  return async (ctx) => {
    const target = pathOf(ctx.sandbox);
    if (!(await pathExists(target))) {
      return {
        label: label ?? `${target} matches`,
        passed: false,
        evidence: { path: target, exists: false },
        detail: `file does not exist: ${target}`,
      };
    }
    const content = await readFile(target, 'utf8');
    const passed = matcher instanceof RegExp ? matcher.test(content) : matcher(content);
    return {
      label: label ?? `${target} matches`,
      passed,
      evidence: { path: target, matched: passed },
      detail: passed ? undefined : `contents did not match: ${target}`,
    };
  };
}

/**
 * Oracle: the resolved directory holds NO crash-left `*.dorkos-bak-*` sibling —
 * proof the marketplace install/uninstall transaction cleaned up atomically
 * (`transaction.ts`, ADR-0304).
 *
 * @param dirOf - Resolves the directory to scan from the sandbox.
 * @param label - Human-readable label; defaults to a no-backups message.
 * @returns An {@link Oracle}.
 */
export function noBackupSiblings(dirOf: SandboxPath, label?: string): Oracle {
  return async (ctx) => {
    const dir = dirOf(ctx.sandbox);
    let leftovers: string[] = [];
    try {
      const entries = await readdir(dir);
      leftovers = entries.filter((e) => e.includes(BACKUP_MARKER));
    } catch {
      // A missing directory has no backup siblings.
    }
    const passed = leftovers.length === 0;
    return {
      label: label ?? `no *.dorkos-bak-* under ${path.basename(dir)}`,
      passed,
      evidence: { dir, leftovers },
      detail: passed ? undefined : `leftover backups: ${leftovers.join(', ')}`,
    };
  };
}
