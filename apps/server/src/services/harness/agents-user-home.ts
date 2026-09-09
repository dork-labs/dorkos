/**
 * Resolves `~/.agents/skills` — the one user-level skills directory five agent
 * tools read, and the only directory outside DorkOS's own data folder that
 * Harness Sync at global scope ever writes a link into.
 *
 * This is the sixth carve-out from the `os.homedir()` ban (Hard Rule 3,
 * `.claude/rules/dork-home.md`), and it is the same shape as the three beside it:
 * it mirrors ANOTHER program's documented resolution of its own directory 1:1,
 * and resolves nothing of DorkOS's own. `claude-config-dir.ts` mirrors the Claude
 * Agent SDK, `codex-home.ts` mirrors the Codex CLI, `opencode-data-dir.ts`
 * mirrors the OpenCode CLI; this mirrors five vendors at once, because Codex,
 * OpenCode, Cursor, Gemini CLI and Copilot all document `$HOME/.agents/skills` as
 * a user-scope read path and the repo's own `vendor-facts/index.ts` records it
 * for each of them (`skills.readPaths.user`, pinned by the invariant case in
 * `packages/harness/src/vendor-facts/__tests__/vendor-facts.test.ts`).
 *
 * **Why a carve-out and not a config field.** A `harness.global.userSkillsDir`
 * setting would avoid the rule change and make the ordinary case require
 * configuration, which is worse: nobody would set it, the feature would appear
 * broken to everybody who did not, and the field would become a second place a
 * home directory is spelled.
 *
 * **The carve-out is per FILE, not per directory.** A sibling in
 * `services/harness/` may not call `os.homedir()`; both halves of the ESLint ban
 * name this path and only this path.
 *
 * `~/.agents` has no environment-variable override to honour. Unlike the three
 * modules above there is no `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME` or
 * `$XDG_DATA_HOME` equivalent: every vendor page spells the directory as
 * `~/.agents/skills` flat, so mirroring them 1:1 means exactly one line of body.
 *
 * @module services/harness/agents-user-home
 */
import os from 'os';
import path from 'path';

/**
 * The cross-tool user-level skills directory: `~/.agents/skills`.
 *
 * The engine never resolves this itself — `@dorkos/harness` takes both global
 * roots injected (`GlobalPlanRoots`) precisely so that the one place a home
 * directory is spelled is a file the ban's carve-out list names.
 *
 * @returns the absolute path to `~/.agents/skills`.
 */
export function agentsUserSkillsDir(): string {
  return path.join(os.homedir(), '.agents', 'skills');
}
