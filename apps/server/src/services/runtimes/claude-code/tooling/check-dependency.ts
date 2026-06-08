import { execFileSync } from 'node:child_process';
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import { resolveClaudeCliPath } from '../sdk/sdk-utils.js';

/** Return the platform-appropriate install command for the Claude Code CLI. */
function getInstallHint(): string {
  if (process.platform === 'win32') {
    return 'irm https://claude.ai/install.ps1 | iex';
  }
  // macOS, Linux, WSL
  return 'curl -fsSL https://claude.ai/install.sh | bash';
}

/**
 * Check whether a usable Claude Code binary is available to power agent sessions.
 *
 * Reports `satisfied` when {@link resolveClaudeCliPath} finds a runnable binary —
 * either the SDK's bundled native binary (shipped with DorkOS since SDK 0.2.113)
 * or a `claude` on PATH — and that binary answers `--version`. Reports `missing`
 * with an install hint only when neither resolves, so a failed optional-dependency
 * install (which would otherwise break sessions silently) surfaces clearly.
 */
export function checkClaudeDependency(): DependencyCheck {
  const name = 'Claude Code CLI';
  const description = 'The Claude Code CLI powers agent sessions in DorkOS.';
  const binary = resolveClaudeCliPath();

  if (binary) {
    try {
      const version = execFileSync(binary, ['--version'], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      return { name, description, status: 'satisfied', version };
    } catch {
      // Binary resolved but failed to launch — fall through to "missing".
    }
  }

  return {
    name,
    description,
    status: 'missing',
    installHint: getInstallHint(),
    infoUrl: 'https://docs.anthropic.com/en/docs/claude-code',
  };
}
