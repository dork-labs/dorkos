import { execSync } from 'child_process';

export function checkClaude(): void {
  try {
    execSync('claude --version', { stdio: 'pipe' });
  } catch {
    console.error('Error: Claude Code CLI not found in PATH.');
    console.error('');
    console.error('LifeOS Gateway requires the Claude Code CLI to function.');
    console.error('Install it with:  npm install -g @anthropic-ai/claude-code');
    console.error('');
    console.error('More info: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }
}
