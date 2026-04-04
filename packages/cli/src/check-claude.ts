import { execSync } from 'child_process';

/**
 * Verify the Claude Code CLI is installed and available in PATH.
 *
 * Prints a warning when missing but does NOT exit — the onboarding flow
 * provides a friendlier system-requirements check with install guidance.
 *
 * @returns true if claude CLI was found, false otherwise
 */
export function checkClaude(): boolean {
  try {
    execSync('claude --version', { stdio: 'pipe' });
    return true;
  } catch {
    const yellow = '\x1b[33m';
    const reset = '\x1b[0m';
    const installCmd =
      process.platform === 'win32'
        ? 'irm https://claude.ai/install.ps1 | iex'
        : 'curl -fsSL https://claude.ai/install.sh | bash';
    console.warn(`${yellow}[Warning] Claude Code CLI not found in PATH.${reset}`);
    console.warn('  Agent sessions require the Claude Code CLI.');
    console.warn(`  Install it with:  ${installCmd}`);
    console.warn('  More info: https://docs.anthropic.com/en/docs/claude-code');
    console.warn('');
    return false;
  }
}
