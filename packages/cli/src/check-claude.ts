import { execFileSync } from 'node:child_process';
import { resolveClaudeCliPath } from '../server/services/runtimes/claude-code/sdk/sdk-utils.js';

/**
 * Resolve a runnable Claude Code binary, through the SERVER's resolver — the one
 * ladder a session actually spawns down: the `DORKOS_CLAUDE_CLI_PATH` override,
 * the SDK's bundled per-platform binary (asar-aware), a provisioned install
 * under `~/.dork/runtimes/claude-code`, then a `claude` on PATH.
 *
 * This used to be a second, hand-maintained copy of that ladder, and it had
 * already drifted: no env rung, no provisioned rung, no asar remap, so `dorkos`
 * start-up and `dorkos doctor` could warn "Claude Code CLI not found" about a
 * binary the server was about to spawn happily (DOR-1334 review). The CLI
 * bundle reaches narrow server modules through the `../server/**` specifiers
 * `scripts/build.ts` rewrites (mirrored for tsc in `packages/cli/server/`), and
 * `sdk-utils` imports no runtime SDK, so the confinement boundary (ADR-0089) is
 * untouched.
 *
 * @returns Absolute path to a Claude Code binary, or `null` when none resolves.
 */
export function findClaudeBinary(): string | null {
  return resolveClaudeCliPath() ?? null;
}

/**
 * Verify a resolved Claude Code binary actually launches (`--version` exits 0),
 * without printing anything.
 *
 * Shared by {@link checkClaude} (which adds a warning) and `dorkos doctor`
 * (which renders its own checklist line).
 *
 * @returns true if a Claude Code binary was found and launches, false otherwise
 */
export function claudeCliLaunches(): boolean {
  const binary = findClaudeBinary();
  if (!binary) return false;
  try {
    execFileSync(binary, ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify a runnable Claude Code binary is available (bundled native binary or PATH).
 *
 * Prints a warning when missing but does NOT exit — the onboarding flow provides
 * a friendlier system-requirements check with install guidance.
 *
 * @returns true if a Claude Code binary was found and launches, false otherwise
 */
export function checkClaude(): boolean {
  if (claudeCliLaunches()) return true;

  const yellow = '\x1b[33m';
  const reset = '\x1b[0m';
  const installCmd =
    process.platform === 'win32'
      ? 'irm https://claude.ai/install.ps1 | iex'
      : 'curl -fsSL https://claude.ai/install.sh | bash';
  console.warn(`${yellow}[Warning] Claude Code CLI not found.${reset}`);
  console.warn('  Agent sessions require the Claude Code CLI.');
  console.warn(`  Install it with:  ${installCmd}`);
  console.warn('  More info: https://docs.anthropic.com/en/docs/claude-code');
  console.warn('');
  return false;
}
