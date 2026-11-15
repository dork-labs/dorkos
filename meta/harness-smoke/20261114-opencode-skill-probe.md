# Harness Smoke — OpenCode skills (hand probe) — 2026-11-14

## Run

- **Harness:** OpenCode 1.19.3, the pinned, hash-checked binary the real-binary tests use (`apps/server/src/services/runtimes/opencode/__tests__/pinned-opencode.ts`)
- **Kind:** a hand probe, not a `scripts/harness-smoke/run.sh` report. It stages the tree by hand in the shape the projector writes (`plan/installed-projector.ts`): `.agents/skills/<package>__<skill>`, each a relative symlink to the skill's directory, with `SKILL.md` and its frontmatter `name` left as authored
- **Isolation:** throwaway `HOME` and every `XDG_*` folder; models fetch and self-update off; every non-local address goes to a proxy that does not answer
- **Model:** a scripted fake on 127.0.0.1 that calls the `skill` tool once. No key, nothing billed
- **Listing oracle:** `opencode debug skill` (non-model)
- **Loading oracle:** `opencode run` against the fake model; the `skill` tool's result as the fake received it
- **Skill packs:** the real `writing-pack` and `marketplace-dev` from `dork-labs/marketplace`

## Results

| Case                                                                                          | Listed                                                             | Loaded                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `.agents/skills/writing-pack__writing-adrs`: relative symlink, frontmatter `name` ≠ directory | yes, as `writing-adrs`                                             | yes, full body                                                                       |
| `~/.agents/skills/marketplace-dev__marketplace-dev`: relative symlink, user scope             | yes, as `marketplace-dev`                                          | not run                                                                              |
| Plain directory `pkg__ctl-real-mismatch`, `name: ctl-real-mismatch`                           | yes                                                                | not run                                                                              |
| Plain directory `ctl-plain-dir`, `name: ctl-other-name`                                       | yes, as `ctl-other-name`                                           | not run                                                                              |
| Absolute symlink `ctl-link-match`, name = directory                                           | yes                                                                | not run                                                                              |
| Plain directory `ctl-real-match`, name = directory (control)                                  | yes                                                                | yes                                                                                  |
| `writing-pack__writing-developer-guides` symlink with `reference.md` beside `SKILL.md`        | yes                                                                | yes; `reference.md` listed in `<skill_files>`, exactly as for a plain-directory copy |
| The same skill linked from both `.claude/skills` and `.agents/skills`                         | once                                                               | n/a                                                                                  |
| Two packs whose skills share `name: shared-name`                                              | once: `pack-a__shared-name` kept, `pack-b` dropped with no warning | `pack-a`'s body                                                                      |

## What it settles

- **identity:** the frontmatter `name`; the directory name is not used.
- **nameMustMatchDir:** not enforced. The docs say the name must match the directory, but a mismatched name loads, with no warning at `--log-level WARN`.
- **symlinks:** followed, relative and absolute, at project and user scope, for listing, loading and the skill's other files.
- **dedupe:** by name. The second skill with the same frontmatter name collapses into the first, whether it is the same target reached twice or a different one.
- **readPaths:** `.agents/skills` and `.claude/skills` at project scope and `~/.agents/skills` at user scope were read. `.opencode/skills` and `~/.config/opencode/skills` were not staged.

## What it does not settle

- **onInvalidName:** every frontmatter name in the probe met the documented rule, so what happens to one that breaks it is still unknown.
- **walk** (the probe ran at the repository root), **nameRequired**, **liveReload**.
- **Which of two same-name packs wins:** `pack-a` won in both runs. Alphabetical order is a guess, not a measurement.

## Caveat: loading needs ripgrep

The `skill` tool lists a skill's files with ripgrep. With no `rg` on `PATH` and no network to download one, every load failed with `ripgrep execution failed`, while the listing still worked. The loads above ran with a real ripgrep on `PATH`. A normal install finds `rg` or downloads it; a machine with neither lists skills but cannot load them.

## Evidence

The probe script and its last output are kept under `/Volumes/ext-ssd-1/dork-os/evidence/2026-11-14-opencode-skill-probe/`.
