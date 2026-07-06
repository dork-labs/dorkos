---
title: 'Agent CLI command & skill naming: OpenCode, Codex, Claude Code'
date: 2026-07-06
type: implementation
status: active
tags: [harness-sync, opencode, codex, claude-code, commands, skills, projection]
feature_slug: harness-opencode-target
---

# Agent CLI command & skill naming (OpenCode / Codex / Claude Code)

Research backing the Harness Sync OpenCode target (`@dorkos/harness`). Verified against live docs + `sst/opencode` source, 2026-07-06. Items marked **DOCS SILENT** were not found in official docs and need empirical verification before being relied on beyond the conservative choice already made.

## 1. OpenCode commands

- **Directory**: `.opencode/commands/` (plural `commands`), project scope. There is also a global `~/.config/opencode/command/` — note the singular there; the project dir is plural `commands`. (The project plural dir is what Harness Sync targets.)
- **Names are FLAT, no namespacing.** A file `foo.md` is invoked `/foo`. OpenCode has no equivalent of Claude Code's directory-namespaced `/<pkg>:<name>`. Subdirectories are not a namespacing mechanism the way Claude uses them.
  - Consequence for projection: a Claude plugin command `/flow:capture` must be projected to a flat file. We hyphen-join: `flow-capture.md`, invoked `/flow-capture`. **The invocation name necessarily differs from Claude's `/flow:capture` — expected, not a bug.**
  - Collision edge: hyphen-joining `<pkg>-<name>` can theoretically collide across packages (`flow-a` + `b` vs `flow` + `a-b`). Marketplace package names are unique and commands are unique within a package, so within one plugin there is no collision; cross-package hyphen collisions are a low-risk v1 edge, documented in the guide.
- **Arguments**: `$ARGUMENTS` (all args) and positional `$1 … $n` are supported.
- **Frontmatter (documented keys)**: `description`, `agent`, `model`, `subtask`, `template`. `!`-prefixed shell injection and `@file` references are also documented in the body.
- **Unknown-key tolerance: DOCS SILENT.** Whether OpenCode ignores or rejects unknown frontmatter keys (e.g. Claude's `allowed-tools`, `argument-hint`, `category`) is not documented. **Conservative choice taken:** generated wrappers emit ONLY `description` and strip all Claude-specific keys, so a stripped wrapper is valid regardless of how OpenCode treats unknowns. If OpenCode is later confirmed to ignore unknown keys, we could pass more through, but there is no upside to risking a parse error.

## 2. Skill-name derivation per tool (the collision vector)

The invocable/identity name of a skill is derived differently per harness. This matters because Harness Sync namespaces installed-plugin skill **directories** as `<pkg>__<name>` to avoid overwriting authored skills, but the directory name is not the identity in every harness.

| Tool        | Skill identity key                          | Source                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code | **Directory name** of the skill dir         | Claude Code loads `.claude/skills/<dir>/SKILL.md` and derives the name from `<dir>`; `<pkg>__<name>` therefore namespaces correctly.                                                                                                                                                                                                                                                                                     |
| OpenCode    | **`SKILL.md` frontmatter `name`**           | Source-verified: `sst/opencode` `packages/opencode/src/skill/index.ts` keys the skills map on `md.data.name` and never consults the directory name. (Reviewed around commit `47f33329`.) Note a **docs contradiction**: OpenCode docs describe reading `.claude/skills` / `.agents/skills` / `.opencode/skills` but do not spell out that the frontmatter `name` is the registry key — the source is authoritative here. |
| Codex       | **`SKILL.md` frontmatter `name`** (implied) | Codex docs describe skills by their frontmatter `name`; when two skills share a name "both can appear" (no merge). The docs do **not** state that the directory name is ever the identity, so identity is frontmatter-name. **DOCS SILENT** on the exact tie-break/registry mechanics — treated as frontmatter-keyed for the collision warning, which is the safe assumption.                                            |

**Consequence:** the `<pkg>__<name>` **directory** namespacing does NOT protect OpenCode or Codex from a collision, because their loaders key on the **frontmatter** `name` inside `SKILL.md` (which Harness Sync does not, and should not, rewrite inside a third-party plugin). Two installed skills — or an installed skill and an authored skill — that share a frontmatter `name` collide in those harnesses.

**Implementation outcome:** keep the `__` directory separator as-is (it still protects Claude Code and keeps the sweep/gitignore ownership predicate). Additionally emit a `ProjectionWarning` (`planSkillNameCollisions`) when an installed skill's frontmatter `name` equals an authored skill name or another installed skill's frontmatter name, attributed to each enabled frontmatter-keyed harness (OpenCode, Codex). Renaming the frontmatter `name` at the source is the fix.

## 3. Underscore / separator handling

- Claude Code derives the invocable name from the directory, and a dir like `flow__capturing-work` namespaces cleanly (the `__` is part of the dir name; Claude does not choke on it).
- OpenCode/Codex ignore the directory entirely for identity, so the `__` in the projected symlink directory is invisible to them — again the reason the frontmatter-name collision is not solved by the `__` convention. Underscores in a `name` are otherwise unremarkable; no tool documents a restriction that would break `<pkg>-<name>` command filenames or `<pkg>__<name>` skill dirs.

## 4. OpenCode hooks: a plugin API, NOT declarative config

- **DOCS-confirmed**: OpenCode has **no declarative hook configuration file** (nothing analogous to Claude's `settings.json` `hooks` or Codex's `.codex/hooks.json`). Automation is done via a **code-based TypeScript plugin API** (`.opencode/plugin/*.ts` exporting event handlers).
- Consequence for projection: installed-plugin hooks have no on-disk file target on OpenCode, so Harness Sync emits an **honest `drop`** for OpenCode hooks with that reason (rather than a broken projection). Translating Claude command-style hooks into an OpenCode TS plugin is out of scope (would require code generation, not file projection).

## 5. Item A context (folded-hook token rewrite)

Separate from OpenCode, this research confirmed the fix for installed-plugin hooks folded into generated hook files (`.codex/hooks.json`, `.cursor/hooks.json`, `.github/hooks/copilot-hooks.json`): because an installed plugin's absolute install dir is known at plan time, `${CLAUDE_PLUGIN_ROOT}` in its hook commands is rewritten to that absolute path before merging, exactly as the `.claude/settings.local.json` merge already did. The projected hook then actually works in the target harness, and the Claude-only-token warning is reserved for **authored** hooks (unknown install root) or other unresolved `${CLAUDE_*}` tokens.

## Open items needing empirical verification

- **OpenCode unknown-frontmatter-key tolerance** (§1). Currently mitigated by stripping to `description` only.
- **Codex skill registry tie-break** on duplicate frontmatter names (§2). Docs say "both can appear"; exact behavior unverified. Collision warning is the safe response regardless.
- Whether OpenCode resolves `$ARGUMENTS`/`$1..$n` identically to Claude for the wrapped bodies we emit (bodies are passed through unchanged except for the `${CLAUDE_PLUGIN_ROOT}` rewrite).
