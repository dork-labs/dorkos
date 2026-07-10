/**
 * Resolves the Claude Agent SDK's config root — the directory holding
 * `projects/` (JSONL transcripts), `todos/`, and other SDK-managed state.
 *
 * The SDK's own subprocess resolves this as `CLAUDE_CONFIG_DIR ?? ~/.claude`
 * (verified against `@anthropic-ai/claude-agent-sdk`'s bundled `sdk.mjs`: the
 * config-dir accessor is `process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(),
 * ".claude")`). DorkOS reads transcripts written by that same subprocess, so
 * every read site MUST resolve the identical directory — a hardcoded
 * `~/.claude` silently split-brains the moment a user (or an agent launched
 * from inside a Claude Code session) sets `CLAUDE_CONFIG_DIR`: the SDK writes
 * one place, DorkOS reads another, and the session 404s despite having run,
 * billed, and streamed successfully (DOR-250).
 *
 * `os.homedir()` is banned everywhere else in `apps/server/src/` (see
 * `.claude/rules/dork-home.md`), but this directory is exempt: it predates the
 * ban and mirrors the SDK's own config-dir resolution, which is itself
 * homedir-based when no override is set. See `eslint.config.js` — the
 * `services/runtimes/claude-code/**` block never applies `HOMEDIR_BANS`.
 *
 * @module services/runtimes/claude-code/claude-config-dir
 */
import path from 'path';
import os from 'os';

/**
 * Resolve the Claude Agent SDK's config root directory.
 *
 * @returns `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`.
 */
export function resolveClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
}
