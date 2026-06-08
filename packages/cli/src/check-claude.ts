import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/** Resolve modules relative to this file — ESM has no ambient `require`. */
const requireFrom = createRequire(import.meta.url);

/** npm name of the SDK whose bundled native binary powers agent sessions. */
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

/**
 * Resolve a runnable Claude Code binary: the SDK's bundled per-platform native
 * binary (shipped as an optional dependency since SDK 0.2.113), else a `claude`
 * on PATH.
 *
 * This deliberately mirrors the server runtime resolver
 * (`apps/server/src/services/runtimes/claude-code/sdk-utils.ts` →
 * `resolveClaudeCliPath`) so the install check agrees with how sessions actually
 * spawn. It is kept self-contained here because the SDK-confinement boundary
 * (ADR-0089) keeps the runtime resolver inside `services/runtimes/claude-code/`,
 * which this standalone CLI utility can't import without coupling to the server
 * module graph. Keep the two in sync.
 */
function resolveClaudeBinary(): string | null {
  const { platform, arch } = process;
  const ext = platform === 'win32' ? '.exe' : '';
  // Only one variant is ever installed on a given host; try each, take the first.
  const candidates =
    platform === 'linux'
      ? [`${SDK_PKG}-linux-${arch}`, `${SDK_PKG}-linux-${arch}-musl`]
      : platform === 'android'
        ? [`${SDK_PKG}-linux-${arch}-android`]
        : [`${SDK_PKG}-${platform}-${arch}`];

  for (const pkg of candidates) {
    try {
      const resolved = requireFrom.resolve(`${pkg}/claude${ext}`);
      if (existsSync(resolved)) return resolved;
    } catch {
      /* optional dependency not installed for this variant */
    }
  }

  const locator = platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(locator, ['claude'], { encoding: 'utf-8' }).split(/\r?\n/)[0].trim();
    if (found && existsSync(found)) return found;
  } catch {
    /* not on PATH */
  }
  return null;
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
  const binary = resolveClaudeBinary();
  if (binary) {
    try {
      execFileSync(binary, ['--version'], { stdio: 'pipe' });
      return true;
    } catch {
      /* resolved but failed to launch — fall through to the warning */
    }
  }

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
