---
title: "Prettier Formatting Strategy with AI Coding Agents (Claude Code, Cursor)"
date: 2026-03-20
type: external-best-practices
status: active
tags: [prettier, formatting, claude-code, cursor, lefthook, lint-staged, pre-commit, git-blame, CI, hooks, turborepo, pnpm]
searches_performed: 14
sources_count: 28
---

## Research Summary

AI coding agents like Claude Code and Cursor introduce a new failure mode for code formatting: they commit frequently, sometimes bypass pre-commit hooks using `git commit --no-verify`, and generate code that may not be formatted despite IDE format-on-save being active. The most robust strategy for a pnpm + Turborepo + lefthook + Claude Code codebase is a three-layer defense: (1) a Claude Code `PostToolUse` hook that formats every written file in real time, (2) a lefthook `pre-commit` command that runs `prettier --check` on staged files as a gate, and (3) a CI `prettier --check` job that is the final, unforgeable safety net. This is supplemented by a `.git-blame-ignore-revs` file for the initial bulk-format commit and a `PreToolUse` hook to block `git commit --no-verify`.

---

## Key Findings

1. **Claude Code does not natively format on write.** It produces syntactically correct code but does not apply `.prettierrc` rules automatically. There is no built-in "format on save" equivalent. A `PostToolUse` hook is required to replicate this behavior.

2. **Claude Code routinely uses `git commit --no-verify`.** This is a well-documented failure mode reported across many public codebases (drizzle-orm, twentyhq, next.js, microservices.io). Pre-commit hooks alone are insufficient. A `PreToolUse` hook blocking the `--no-verify` flag is required to close this gap.

3. **Prettier respects `.prettierrc` natively.** When invoked via `pnpm exec prettier --write <file>`, Prettier resolves configuration by walking up the directory tree from the target file. A single root `.prettierrc` in a monorepo is the recommended pattern. No special configuration is needed for Turborepo.

4. **Lefthook is the right pre-commit tool for this stack** — it is already in use (`lefthook: ^2.1.1`), it natively supports monorepos via the `root` and `glob` options, and `stage_fixed: true` automatically re-stages files that hooks auto-fix (critical for formatting hooks).

5. **The `PostToolUse` async hook is the highest-leverage intervention.** It formats each file Claude touches immediately, before lint runs, before type-check runs, before any commit is made. This converts Claude's unformatted output into formatted output in real time at near-zero cost (async, non-blocking).

6. **CI `prettier --check` is non-negotiable.** It is the only enforcement layer that cannot be bypassed by any agent or developer. DorkOS already has `"format:check": "prettier --check ."` in the root `package.json`; it just needs to be wired into the CI pipeline.

7. **A one-time bulk-format commit should use `.git-blame-ignore-revs`** to preserve git blame integrity. GitHub natively supports this file. Each developer must also run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once.

8. **lint-staged is unnecessary given lefthook + Claude Code hooks.** lint-staged solves the same problem as lefthook's glob-based staged-file filtering but adds a dependency and complexity. DorkOS already uses lefthook; the `{staged_files}` interpolation in lefthook achieves the same result.

---

## Detailed Analysis

### Layer 1: Claude Code PostToolUse Hook (Format on Write)

This is the primary intervention. The official Claude Code documentation provides a first-class example of this pattern. The hook fires after every `Edit`, `MultiEdit`, or `Write` tool call, extracts the edited file path from stdin JSON, and passes it to Prettier.

**The canonical minimal form** (from official docs):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "jq -r '.tool_input.file_path' | xargs npx prettier --write"
          }
        ]
      }
    ]
  }
}
```

**Critical refinements for DorkOS:**

- Use `pnpm exec prettier` instead of `npx prettier` to use the exact pinned version from `package.json` (`prettier: ^3.8.1`) rather than whatever `npx` resolves to.
- Use `async: true` so Claude does not block on the formatter between tool calls. Formatting runs in parallel with Claude's next action.
- Handle the case where Prettier does not support the file type (e.g., `.sh`, `.mdx` with unusual plugins) — the command should exit 0 silently on unsupported files.
- The `prettier-plugin-tailwindcss` in `.prettierrc` is loaded automatically because Prettier finds the root `.prettierrc` by walking up from the file path.

**DorkOS-ready hook command** (fits the existing `settings.json` style):

```json
{
  "type": "command",
  "command": "cd \"$(git rev-parse --show-toplevel)\" && jq -r '.tool_input.file_path // empty' | grep -E '\\.(ts|tsx|js|jsx|mjs|json|css|md|mdx|yml|yaml|html)$' | xargs -I{} pnpm exec prettier --write \"{}\" 2>/dev/null || true",
  "async": true
}
```

The `|| true` ensures that if Prettier cannot parse the file (e.g., generated files, binary-adjacent files), the hook exits 0 and does not interrupt Claude's workflow.

**Why async matters:** DorkOS already runs four synchronous hooks on `PostToolUse` (typecheck-changed, lint-changed, check-any-changed, test-changed). Adding formatting as a synchronous hook would lengthen the feedback loop. With `async: true`, formatting completes in the background while the other hooks run.

**One known reliability issue:** The zenn.dev author who originally documented this pattern added a disclaimer in February 2026 noting conflicts with `prettier-plugin-organize-imports` when running per-file. DorkOS uses `prettier-plugin-tailwindcss`, not organize-imports, so this specific conflict does not apply.

### Layer 2: Lefthook Pre-Commit Check (Gate on Staged Files)

Lefthook is already installed and configured in DorkOS. The current `lefthook.yml` runs lint and typecheck but has no formatting step. Adding a `prettier` command to `pre-commit` creates the second enforcement layer.

**Current `lefthook.yml`:**

```yaml
pre-commit:
  commands:
    db-migrations:
      glob: 'packages/db/src/schema/*.ts'
      run: |
        npx drizzle-kit generate --config packages/db/drizzle.config.ts
        git add packages/db/drizzle/
      fail_text: 'DB schema changed — migrations generated and staged. Review and re-commit.'
    lint:
      run: pnpm lint
      fail_text: 'Lint errors found — fix them before committing.'
    typecheck:
      run: pnpm typecheck
      fail_text: 'Type errors found — fix them before committing.'
```

**Recommended addition:**

```yaml
pre-commit:
  commands:
    format:
      glob: '*.{ts,tsx,js,jsx,mjs,json,css,md,mdx,yml,yaml}'
      run: pnpm exec prettier --write {staged_files}
      stage_fixed: true
      fail_text: 'Formatting issues found — files have been auto-formatted and re-staged. Review and re-commit.'
```

Key details:
- `{staged_files}` is lefthook's interpolation for only the staged files matching the glob — equivalent to what lint-staged does, without requiring lint-staged as a dependency.
- `stage_fixed: true` automatically runs `git add` on any files the command modifies, so the formatted version is what gets committed.
- The `glob` prevents Prettier from being invoked on files it cannot parse (`.sh`, `.go`, `.py`, binary assets).
- Because `prettier --write` exits 0 even when it makes changes, this command will not fail the commit — it simply formats and re-stages. This is the correct behavior: we want auto-fix, not a blocking error.

**Alternative: `prettier --check` instead of `--write`:** Some teams prefer to check-only in the pre-commit hook and require developers to run `pnpm format` manually. This is stricter but produces more friction. Given that Claude Code is the primary author of new code and the `PostToolUse` hook handles most formatting in real time, the `--write` + `stage_fixed: true` approach is more appropriate here.

**The `--no-verify` bypass problem:** Claude Code regularly runs `git commit --no-verify`, which skips lefthook entirely. This is well-documented across the community. The lefthook pre-commit hook therefore cannot be relied upon as the sole enforcement layer for agent-generated commits. It remains valuable for human developer commits.

### Layer 3: Blocking `git commit --no-verify` in Claude Code

This is the critical gap between the intent of pre-commit hooks and their actual enforcement for agent commits.

**Solution A: `block-no-verify` via PreToolUse hook** (community tool):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "pnpm dlx block-no-verify"
          }
        ]
      }
    ]
  }
}
```

The `block-no-verify` tool parses every bash command before execution, detects `--no-verify` and `-n` (on `git commit`) flags, and exits with code 2 to block the command. It understands context — `git push -n` means `--dry-run` (allowed), while `git commit -n` means `--no-verify` (blocked).

**Solution B: Deny `git commit` directly** (more conservative):

```json
{
  "permissions": {
    "deny": ["Bash(git commit --no-verify:*)", "Bash(git commit -n:*)"]
  }
}
```

However, this requires precise glob matching and may not catch all flag orderings.

**Solution C: Replace `git commit` access with a controlled MCP tool** (most strict). The microservices.io analysis recommends removing `Bash(git commit:*)` from allow-list entirely and routing all commits through a custom MCP server tool that enforces quality gates. This is the highest-assurance approach but significant infrastructure overhead.

**Recommendation for DorkOS:** Solution A (`block-no-verify`) is the pragmatic choice. The existing `.claude/settings.json` already has a `PreToolUse` hook block; the `block-no-verify` check can be added as a second hook in that block.

### Layer 4: CI `prettier --check` (The Unforgeable Gate)

DorkOS already has `"format:check": "prettier --check ."` in the root `package.json`. This command needs to run in CI as an independent step. Unlike pre-commit hooks, CI runs cannot be bypassed by `--no-verify` or any agent behavior.

**Recommended GitHub Actions step:**

```yaml
- name: Format check
  run: pnpm format:check
```

Or as a Turbo task (enables caching of the check):

```json
// turbo.json
{
  "tasks": {
    "format:check": {
      "inputs": ["**/*.{ts,tsx,js,jsx,mjs,json,css,md,yml,yaml}"],
      "outputs": []
    }
  }
}
```

Then in CI:

```yaml
- name: Format check
  run: turbo run format:check
```

The Turbo-cached version will skip the check for packages that have not changed, but since `prettier --check .` runs from the root over all files, the non-Turbo version is simpler and more reliable as a repo-wide gate.

**Important:** `prettier --check .` respects `.prettierignore`. Ensure `node_modules`, `dist`, `.turbo`, and generated files are in `.prettierignore`.

### Layer 5: Bulk Formatting Commit and `.git-blame-ignore-revs`

When introducing Prettier to an existing codebase (or reformatting after changing `.prettierrc`), the formatting commit pollutes `git blame` for every touched line.

**Procedure:**

1. Run `pnpm format` to format all files.
2. Commit with a clear message: `chore: apply prettier formatting across entire codebase`.
3. Note the full commit hash: `git rev-parse HEAD`.
4. Create `.git-blame-ignore-revs` at the repo root:

```
# chore: apply prettier formatting across entire codebase (2026-03-20)
<full-40-char-hash-here>
```

5. Commit `.git-blame-ignore-revs` itself (it is a tracked file).
6. Configure git locally:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

7. Document step 6 in `CONTRIBUTING.md` so every contributor runs it after cloning.

**Editor support:**
- VSCode with GitLens: add `"gitlens.advanced.blame.customArguments": ["--ignore-revs-file", ".git-blame-ignore-revs"]` to `.vscode/settings.json`.
- GitHub's web `git blame` view: GitHub natively supports `.git-blame-ignore-revs` when the file is committed to the repository root. No additional configuration is needed for the GitHub UI.
- Note: each developer must still run `git config blame.ignoreRevsFile .git-blame-ignore-revs` locally for CLI git blame to respect it.

**When to add new entries:** Any future commit that is purely a bulk formatting pass (e.g., after adding `prettier-plugin-sort-imports` or changing `printWidth`) should be added to this file.

### Prettier Configuration Resolution in a Monorepo

Prettier resolves configuration by walking up the directory tree from the file being formatted until it finds a config file. A single root `.prettierrc` is the correct pattern for a Turborepo monorepo — all packages inherit it without per-package config.

DorkOS already follows this pattern with a root `.prettierrc`:

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "es5",
  "tabWidth": 2,
  "printWidth": 100,
  "arrowParens": "always",
  "endOfLine": "lf",
  "plugins": ["prettier-plugin-tailwindcss"]
}
```

The `prettier-plugin-tailwindcss` plugin is loaded automatically when `pnpm exec prettier` is run because Prettier finds this root config. No per-package config or plugin registration is needed.

**Caveat about `apps/site` (Next.js):** Next.js projects sometimes have their own `.prettierrc` or Prettier config in `package.json`. If `apps/site` adds a site-specific config, Prettier will use that for files under `apps/site/` instead of the root. Keep the monorepo on a single root config to avoid this divergence.

### Does Claude Code Respect `.prettierrc` Natively?

No. Claude Code generates syntactically valid code but does not apply Prettier formatting rules. It may coincidentally produce formatted code when the formatting rules are simple (e.g., 2-space indentation), but it will not consistently apply `trailingComma`, `singleQuote`, `printWidth` line wrapping, or `prettier-plugin-tailwindcss` class sorting. The `PostToolUse` hook is the mechanism to make formatting automatic.

### lint-staged vs Lefthook's `{staged_files}`

lint-staged and lefthook's `{staged_files}` solve the same problem: running formatters only on staged files rather than the entire repo. Since DorkOS uses lefthook, lint-staged is unnecessary. Lefthook's `{staged_files}` interpolation combined with the `glob` filter achieves identical behavior without the additional dependency.

The one case where lint-staged has an advantage is "partially staged files" (where a file has both staged and unstaged hunks). lint-staged has sophisticated handling for this edge case; lefthook's `stage_fixed: true` is simpler and restages the entire file. For most workflows, this difference does not matter. For agent-driven commits, there are no partially staged files — agents stage complete file writes.

---

## Comparison Table

| Approach | Catches Agent Code | Catches Human Code | Bypass Risk | Overhead | Recommended |
|---|---|---|---|---|---|
| PostToolUse format hook | Yes (per-file, async) | No | None (not a gate) | Near-zero | Yes — primary layer |
| Lefthook pre-commit `--write` | No (bypassed by `--no-verify`) | Yes | High for agents | Low (staged files only) | Yes — human layer |
| block-no-verify PreToolUse | Prevents bypass | N/A | None | Low | Yes — close the gap |
| CI `prettier --check` | Yes (post-commit) | Yes | None | Medium (PR latency) | Yes — final gate |
| Editor format-on-save | Partial (not in Claude Code) | Yes (if configured) | High (opt-in) | None | Supplementary |
| lint-staged | Redundant with lefthook | Yes | High for agents | Low | No — already have lefthook |

---

## Recommended Implementation for DorkOS

DorkOS is well-positioned. The `format` and `format:check` scripts already exist. The following changes complete the strategy:

### Step 1: Add the PostToolUse formatter to `.claude/settings.json`

Add to the existing `PostToolUse` array (as the first entry, so it runs before lint/typecheck):

```json
{
  "type": "command",
  "command": "cd \"$(git rev-parse --show-toplevel)\" && jq -r '.tool_input.file_path // empty' | grep -qE '\\.(ts|tsx|js|jsx|mjs|json|css|md|mdx|yml|yaml|html)$' && jq -r '.tool_input.file_path' | xargs pnpm exec prettier --write 2>/dev/null || true",
  "async": true
}
```

Or as a dedicated shell script `.claude/hooks/format-changed.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only format supported file types
if echo "$FILE_PATH" | grep -qE '\.(ts|tsx|js|jsx|mjs|json|css|md|mdx|yml|yaml|html)$'; then
  cd "$(git rev-parse --show-toplevel)"
  pnpm exec prettier --write "$FILE_PATH" 2>/dev/null || true
fi

exit 0
```

Then in `settings.json`:

```json
{
  "type": "command",
  "command": "cd \"$(git rev-parse --show-toplevel)\" && .claude/hooks/format-changed.sh",
  "async": true
}
```

### Step 2: Add format command to `lefthook.yml`

```yaml
pre-commit:
  commands:
    format:
      glob: '*.{ts,tsx,js,jsx,mjs,json,css,md,yml,yaml}'
      run: pnpm exec prettier --write {staged_files}
      stage_fixed: true
      fail_text: 'Files have been auto-formatted and re-staged. Review and re-commit.'
    # ... existing commands
```

### Step 3: Add `block-no-verify` to `PreToolUse` hooks

In `.claude/settings.json`, add to the existing `PreToolUse` hooks array:

```json
{
  "matcher": "Bash",
  "hooks": [
    {
      "type": "command",
      "command": "pnpm dlx block-no-verify"
    }
  ]
}
```

Or add it to the existing Bash-matching entry.

### Step 4: Wire `format:check` into CI

In `.github/workflows/ci.yml` (or the equivalent):

```yaml
- name: Check formatting
  run: pnpm format:check
```

This step should run in parallel with (not after) lint and typecheck — all three are read-only checks.

### Step 5: Perform and document the bulk format commit

```bash
pnpm format
git add -A
git commit -m "chore: apply prettier formatting across entire codebase"
```

Then create `.git-blame-ignore-revs` and add the hash. Add `git config blame.ignoreRevsFile .git-blame-ignore-revs` to the "Getting Started" section of `CONTRIBUTING.md`.

---

## Research Gaps and Limitations

- **Cursor behavior with pre-commit hooks:** Cursor uses an embedded VS Code process and does not invoke git from a shell in the same way Claude Code does. It generally respects pre-commit hooks because it routes git operations through the normal git CLI. No documented case of Cursor using `--no-verify` was found.
- **`prettier-plugin-tailwindcss` with per-file hooks:** The plugin requires the full Tailwind CSS configuration to determine class ordering. When `prettier --write` is invoked on a single file, it resolves `tailwind.config.ts` from the root. In a monorepo where some packages have their own Tailwind config, this may produce incorrect class ordering for files in sub-packages. Testing is recommended.
- **`MultiEdit` tool and partial writes:** When Claude uses `MultiEdit` to modify multiple sections of a file, the `PostToolUse` hook fires once with the final file path. No special handling is needed.
- **Performance at scale:** Running `pnpm exec prettier --write` per file requires spawning the prettier process each time. For large sessions with many file edits, this adds up. Consider debouncing or batching if this becomes noticeable. For most sessions, it is imperceptible.

## Contradictions and Disputes

- **"Use `PostToolUse` hooks" vs "use lefthook":** The zenn.dev author originally recommended the `PostToolUse` approach but later (February 2026) walked back their recommendation in favor of repository-level lefthook, citing reliability issues. The specific issue was plugin conflicts with `prettier-plugin-organize-imports`. DorkOS uses `prettier-plugin-tailwindcss`, not organize-imports, so the reliability concern does not directly transfer. Both approaches are valid and complementary; they operate at different layers.
- **"Deny `git commit`" vs "allow `git commit` with monitoring":** The microservices.io analysis argues for denying all direct git commit access to Claude Code. This is architecturally sound but operationally heavy. The `block-no-verify` tool is a pragmatic middle ground that allows most git commits while closing the specific bypass risk.

---

## Sources and Evidence

- Official Claude Code hooks documentation with PostToolUse Prettier example: [Automate workflows with hooks](https://code.claude.com/docs/en/hooks-guide)
- Per-file auto-format implementation with shell script: [Auto-format generated Code with Claude Code Hooks](https://martin.hjartmyr.se/articles/auto-format-with-claude-code-hooks/)
- Multi-language format hook implementation (Biome/Prettier/Ruff/goimports): [claude-format-hook](https://github.com/ryanlewis/claude-format-hook)
- Japanese implementation with reliability disclaimer added February 2026: [Automatically run Prettier with Claude Code hooks](https://zenn.dev/coji/articles/claude-code-hooks-prettier-auto-format?locale=en)
- Community hook examples and event reference: [Claude Code Hooks: PreToolUse, PostToolUse & All 12 Events](https://www.pixelmojo.io/blogs/claude-code-hooks-production-quality-ci-cd-patterns)
- Claude Code `--no-verify` bypass documented across major repos: [drizzle-orm issue](https://github.com/drizzle-team/drizzle-orm/issues/5247), [anthropics/claude-cookbooks](https://github.com/anthropics/claude-cookbooks/issues/346), [twentyhq/twenty](https://github.com/twentyhq/twenty/issues/17071), [vercel/next.js discussion](https://github.com/vercel/next.js/discussions/88370)
- Architectural analysis of `git commit` danger with Claude Code: [Claude Code: Allow Bash(git commit:*) considered harmful](https://microservices.io/post/genaidevelopment/2025/09/10/allow-git-commit-considered-harmful.html)
- `block-no-verify` tool and PreToolUse implementation: [How I Stopped My AI Coding Assistant from Cheating on Git Hooks](https://vibe.forem.com/tupe12334/how-i-stopped-my-ai-coding-assistant-from-cheating-on-git-hooks-10af)
- `.git-blame-ignore-revs` setup and git config: [Ignoring mass reformatting commits with git blame](https://akrabat.com/ignoring-revisions-with-git-blame/)
- Lefthook monorepo support, `stage_fixed`, parallel execution: [5 cool ways to configure Lefthook](https://evilmartians.com/chronicles/5-cool-and-surprising-ways-to-configure-lefthook-for-automation-joy)
- Lefthook vs Husky comparison: [Ditch Husky: Speed Up Git Hooks with Lefthook](https://dev.to/recca0120/ditch-husky-speed-up-git-hooks-with-lefthook-hkm)
- Prettier pre-commit options (lint-staged, pretty-quick, git-format-staged): [Pre-commit Hook](https://prettier.io/docs/precommit)
- Prettier config resolution in monorepos: [Configuration File](https://prettier.io/docs/configuration)
- Turborepo lint-staged integration with Husky: [Managing ESLint, Prettier, & Lint Staged in a Turborepo Monorepo](https://dev.callmenick.com/posts/turborepo-eslint-prettier-lint-staged)

## Search Methodology

- Searches performed: 14
- Most productive search terms: "Claude Code PostToolUse hooks prettier 2025", "git commit --no-verify Claude Code bypass", "lefthook stage_fixed prettier monorepo"
- Primary source types: official Claude Code documentation, GitHub issues across major repos, developer blog posts from 2025-2026
