/**
 * Where the Codex CLI keeps its own state on this machine, and the rollout roots
 * the message-search index reads out of it.
 *
 * The CLI resolves its home as `$CODEX_HOME`, else `~/.codex` — the same chain
 * `enumerate-mcp-servers.ts` describes when it explains why DorkOS shells out to
 * `codex mcp list` instead of parsing `config.toml` itself. Inside that home,
 * one thread is one append-only JSONL rollout file:
 *
 * ```
 * $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl   # live threads
 * $CODEX_HOME/archived_sessions/rollout-<ISO>-<uuid>.jsonl     # flat, archived
 * ```
 *
 * **Nothing here imports `@openai/codex-sdk`, and that is the point** (Hard Rule
 * 2). The index reads bytes already at rest, exactly as it does for Claude Code;
 * it never boots a runtime to ask what was said. This module exists so the two
 * path facts — the home, and the two roots inside it — are written down once,
 * the way `claude-config-dir.ts` serves the Claude Code source.
 *
 * **The archive is a MOVE, not a copy**, measured on this machine 2026-08-25:
 * the four archived rollouts carry four session ids, and none of them appears
 * under `sessions/`. That matters because the M1 sweep refuses BOTH files when
 * two claim one container id — so a Codex release that started copying instead
 * of moving would take those sessions out of the index rather than duplicating
 * them, loudly, with one failure per collision.
 *
 * `os.homedir()` is banned everywhere else in `apps/server/src/` (see
 * `.claude/rules/dork-home.md`); this file is a carve-out for the same reason
 * `claude-config-dir.ts` is — it mirrors another program's own resolution of its
 * own directory, and a hardcoded `~/.codex` would split-brain the moment
 * anything sets `CODEX_HOME`. The carve-out is by FILENAME, so a sibling module
 * may not call `os.homedir()` either. The IMPORT ban still reaches this file, so
 * the import must stay spelled `import os from 'os'`.
 *
 * @module services/runtimes/codex/codex-home
 */
import path from 'path';
import os from 'os';

/**
 * The Codex CLI's own home directory: `$CODEX_HOME`, else `~/.codex`.
 *
 * @param env - Environment to read (defaults to the process's). A parameter so a
 *   test can prove both branches without mutating `process.env` under a suite
 *   that runs in parallel with everything else.
 * @returns The absolute path Codex reads and writes its state in. Not checked
 *   for existence — a machine that has never run Codex simply has none, which
 *   discovery treats as an empty root rather than as a fault.
 */
export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME;
  return configured !== undefined && configured !== ''
    ? configured
    : path.join(os.homedir(), '.codex');
}

/**
 * Every directory holding rollout files, in sweep order.
 *
 * Two roots rather than one, and both are real history: `sessions/` is where a
 * live thread is written, and `archived_sessions/` is where the CLI moves one
 * the operator archived. Dropping the archive would be the same failure DOR-682
 * fixed for Claude Code one root over — a search box that quietly covers less
 * than the person's history, and says nothing about it.
 *
 * The date directories under `sessions/` are not enumerated here. Discovery
 * walks whatever it is handed, so a Codex release that changes `YYYY/MM/DD` to
 * something else costs nothing.
 *
 * @param env - Environment to read (defaults to the process's).
 * @returns The rollout roots, live first.
 */
export function resolveCodexRolloutRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = resolveCodexHome(env);
  return [path.join(home, 'sessions'), path.join(home, 'archived_sessions')];
}
