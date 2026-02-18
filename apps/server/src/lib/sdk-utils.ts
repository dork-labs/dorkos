import { existsSync } from 'fs';
import { execFileSync } from 'child_process';

/**
 * Wrap a plain-text user message in the AsyncIterable form required by the SDK
 * when mcpServers is provided. Safe to use unconditionally — the SDK accepts
 * AsyncIterable for all query types.
 */
export async function* makeUserPrompt(content: string) {
  yield {
    type: 'user' as const,
    message: { role: 'user' as const, content },
    parent_tool_use_id: null,
    session_id: '',
  };
}

/**
 * Resolve the Claude Code CLI path for the SDK to spawn.
 *
 * Tries SDK bundled path first, then PATH lookup, then falls back to
 * undefined for SDK default resolution (may fail in Electron).
 */
export function resolveClaudeCliPath(): string | undefined {
  // 1. Try the SDK's bundled cli.js (works when running from source / node_modules)
  try {
    const sdkCli = require.resolve('@anthropic-ai/claude-agent-sdk/cli.js');
    if (existsSync(sdkCli)) return sdkCli;
  } catch {
    /* not resolvable in bundled context */
  }

  // 2. Find the globally installed `claude` binary via PATH
  try {
    const bin = execFileSync('which', ['claude'], { encoding: 'utf-8' }).trim();
    if (bin && existsSync(bin)) return bin;
  } catch {
    /* not found on PATH */
  }

  // 3. Let SDK use its default resolution (may fail in Electron)
  return undefined;
}
