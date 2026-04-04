import { execFileSync } from 'child_process';
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';

/** Return the platform-appropriate install command for the Claude Code CLI. */
function getInstallHint(): string {
  if (process.platform === 'win32') {
    return 'irm https://claude.ai/install.ps1 | iex';
  }
  // macOS, Linux, WSL
  return 'curl -fsSL https://claude.ai/install.sh | bash';
}

/**
 * Check whether the Claude Code CLI is installed and reachable via PATH.
 *
 * Returns a structured result describing the binary's availability and version.
 */
export function checkClaudeDependency(): DependencyCheck {
  try {
    const version = execFileSync('claude', ['--version'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    return {
      name: 'Claude Code CLI',
      description: 'The Claude Code CLI powers agent sessions in DorkOS.',
      status: 'satisfied',
      version,
    };
  } catch {
    return {
      name: 'Claude Code CLI',
      description: 'The Claude Code CLI powers agent sessions in DorkOS.',
      status: 'missing',
      installHint: getInstallHint(),
      infoUrl: 'https://docs.anthropic.com/en/docs/claude-code',
    };
  }
}
