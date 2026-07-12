---
description: Create a new release with version bump, changelog update, git tag, npm publish, and optional GitHub Release
argument-hint: [patch|minor|major|X.Y.Z] [--dry-run]
allowed-tools: Bash, Read, Write, Edit, Glob, AskUserQuestion, Agent
---

# System Release Command

Create a new release: bump the version, update the changelog, run harness maintenance, create a git tag, publish to npm, and optionally create a GitHub Release. Quick pre-flight checks and all user interaction happen in the main context; the context-heavy changelog/commit analysis for auto-detect is delegated to a `context-isolator` subagent.

## Arguments

- `$ARGUMENTS` — Optional bump type or explicit version, plus optional flags:
  - _(no argument)_ — **Auto-detect** version bump from changelog and commits
  - `patch` / `minor` / `major` — Force that bump type
  - `X.Y.Z` — Explicit version number (e.g., `0.2.0`)
  - `--dry-run` — Show what would happen without making changes

## Semantic Versioning

| Bump Type | When to Use                                  | Example        |
| --------- | -------------------------------------------- | -------------- |
| **MAJOR** | Breaking changes to user config or workflows | 0.1.0 -> 1.0.0 |
| **MINOR** | New features, backward compatible            | 0.1.0 -> 0.2.0 |
| **PATCH** | Bug fixes, documentation updates             | 0.1.0 -> 0.1.1 |

---

## Phase 1: Parse Arguments

Determine the **bump type** (`patch`, `minor`, `major`, explicit version, or **auto** — the default) and whether `--dry-run` is present.

---

## Phase 2: Pre-flight Checks

```bash
# Check 1: Working directory is clean
git status --porcelain
```

If output is not empty, **STOP**: report the uncommitted files and tell the user to commit or stash before releasing.

```bash
# Check 2: On main branch
git branch --show-current
```

If not `main`, **STOP**: releases must be created from `main`.

```bash
# Check 3: Read current version from VERSION file (single source of truth)
cat VERSION

# Check 4: Get latest tag for comparison
git describe --tags --abbrev=0 2>/dev/null || echo "none"

# Check 5: Analyze commits since last tag for changelog completeness
git log $(git describe --tags --abbrev=0 2>/dev/null || echo "")..HEAD --oneline
```

### Check 5: Changelog completeness

Compare the commits since the last tag against the **fragments in `changelog/unreleased/`** (one file per change; see `changelog/README.md`). Categorize missing commits by conventional commit type: `feat:` → Added, `fix:` → Fixed, `refactor:`/`perf:` → Changed, `BREAKING CHANGE` or `!` → Breaking; `docs:`/`style:`/`test:`/`build:`/`ci:`/`chore:` are skipped (not user-facing by default — hand-author a fragment if one genuinely is). The post-commit hook normally writes a fragment per commit, so the gap is usually small (hand-authored PRs that skipped a fragment, or squashed merges).

**If missing entries exist**, report which commits are unrepresented (grouped by category, with short SHAs) and ask via AskUserQuestion:

```
header: "Backfill"
question: "Add missing entries to changelog before releasing?"
options:
  - label: "Yes, add all missing entries (Recommended)"
    description: "Ensures release notes capture all changes since last release"
  - label: "No, release with current fragments"
    description: "Use only the fragments already in changelog/unreleased/"
  - label: "Cancel and edit manually"
    description: "Exit so you can add fragments yourself"
```

If backfilling: write one fragment per missing change under `changelog/unreleased/` (`/changelog:backfill --apply` does this), rewritten to be user-friendly per the `writing-changelogs` skill (focus on what users can DO, imperative verbs, benefits over mechanisms).

**If both `changelog/unreleased/` and the commit history are empty** since the last release, **STOP** — there is nothing to release.

### Check 6: Config schema migration drift

Verify that any changes to the user-config schema since the last release have a paired `conf` migration. Missing migrations silently break upgrades for existing users, so catch it here before the tag is cut.

**Do this check inline in the main context (no subagent).** The diff is small (usually <500 lines) and the judgment calls ("is this an added field with a default? a rename? a type change?") benefit from full project knowledge.

**Ordering with auto-detect mode:** Steps 1 and 2 below (detect drift, classify changes) can run here regardless of bump mode. Steps 3 and 4 (check for a matching migration at the target version, present findings, scaffold) require `NEXT_VERSION` — computed in Phase 1 for explicit bumps, in Phase 3 for auto-detect. **If auto-detect is in play, run Steps 1-2 here and defer Steps 3-4 until immediately after Phase 3, before Phase 4 confirmation.**

#### Step 1: Detect drift

```bash
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
SCHEMA_DIFF=$(git diff "$LAST_TAG"..HEAD -- \
  packages/shared/src/config-schema.ts \
  apps/server/src/services/core/config-manager.ts)
```

If `SCHEMA_DIFF` is empty → skip the rest of this check.

#### Step 2: Analyze the diff

Read `apps/server/src/services/core/config-manager.ts` and extract the current `migrations` block keys (semver strings) and the current `projectVersion`.

Classify each hunk of `SCHEMA_DIFF`:

- **Added field with a `.default(...)`** — `conf`'s defaults-merge handles this automatically on next instantiation. Usually no migration needed.
- **Added field without a default** — will crash `USER_CONFIG_DEFAULTS` import. Block the release and tell the user to add a default.
- **Removed field** — migration needed (clean up stale user data).
- **Renamed field** (paired add + remove with similar name/type) — migration needed (move user's value from old key to new key).
- **Type change** (e.g., `z.number()` → `z.string()`) — migration needed (transform stored values).
- **Default value change** — **sometimes** needs a migration. If users can have set an explicit value, leave theirs alone. If the default was never user-settable, no migration needed.
- **TSDoc-only / comment-only changes** — no migration needed.

#### Step 3: Check for existing migration at the target version

Check the `migrations` block for an entry keyed to `NEXT_VERSION`. If present, display its body verbatim so the user can confirm it's correct.

#### Step 4: Present findings

Report: files changed, per-hunk classifications with reasons, whether a migration is required, and whether one already exists for `NEXT_VERSION`. Then follow one of three flows.

#### Flow A — migration needed, none exists

Draft a scaffolded migration based on the detected changes. Keep it idempotent (always guard with `store.has()`). Example shape:

```typescript
// Proposed migration (append to migrations block in apps/server/src/services/core/config-manager.ts)
'[next_version]': (store) => {
  // Auto-scaffolded during /system:release for v[next_version]
  // Review carefully before accepting.
  if (store.has('mesh.legacyMode')) {
    store.delete('mesh.legacyMode');
  }
  // `server.timeout` added with a default — conf's defaults merge handles
  // the new-key case automatically; no explicit migration needed for it.
},
```

Use AskUserQuestion:

```
header: "Config Migration"
question: "Schema changes detected without a matching migration. What would you like to do?"
options:
  - label: "Yes, add the scaffolded migration (Recommended)"
    description: "Appends to CONFIG_MIGRATIONS in config-manager.ts and stages for the release commit"
  - label: "Let me write it myself"
    description: "Pauses the release so you can edit config-manager.ts manually, then re-run"
  - label: "No migration needed (I know what I'm doing)"
    description: "Skip. Use only for type-only or no-op schema changes"
  - label: "Cancel release"
    description: "Abort without making changes"
```

**On "Yes, add the scaffolded migration":**

1. Append the migration entry to the module-level `CONFIG_MIGRATIONS` constant in `apps/server/src/services/core/config-manager.ts`, keyed to `[next_version]`. Do NOT touch `projectVersion` — it's sourced from `SERVER_VERSION` (see `lib/version.ts`) and updates automatically when `VERSION` and `package.json` are bumped in Phase 6.
2. Add `apps/server/src/services/core/config-manager.ts` to the Phase 6 `git add` list — it must be staged alongside VERSION/CHANGELOG/package.json.
3. Log the scaffold action for the final report: `✓ Auto-scaffolded config migration for v[next_version]`.

**On "Let me write it myself":** exit cleanly, telling the user to add a migration entry keyed to `'[next_version]'` in `CONFIG_MIGRATIONS` (no need to touch `projectVersion`; see `.claude/skills/adding-config-fields/SKILL.md`), then re-run `/system:release`.

**On "No migration needed":** log the acknowledgment and continue. Include in the final report: `⚠ Config schema changed but user declined migration (acknowledged)`.

**On "Cancel release":** exit with no changes.

#### Flow B — migration needed, matching entry exists

Show a one-line confirmation that the migration for `v[next_version]` already exists (with a brief summary of its body) and continue. No user interaction needed.

#### Flow C — changes are safe (no migration needed)

Applies when all detected changes are "added field with default" / TSDoc-only / comment-only. Show the classifications, then ask a single confirmation ("Proceed without a migration?" / "No, I want to add one manually") in case the user's intent differs from the classifier's reading.

#### Known limitations

- **Cross-file renames** (a field moved from one nested object to another) surface as paired add + remove with different paths. The classifier may miss the connection. Use "Let me write it myself" if you spot this.
- **Schemas imported from outside the watch list** won't show up in the diff. Today all DorkOS user-config sub-schemas (e.g., `LoggingConfigSchema`, `OnboardingStateSchema`) live inline in `packages/shared/src/config-schema.ts`, so this is theoretical. If a future refactor moves a sub-schema into a separate file, add that file to Step 1's `git diff` path list.

---

## Phase 3: Version Analysis

### If explicit bump type provided (patch/minor/major/X.Y.Z)

Calculate the next version directly from the current VERSION and proceed to Phase 4.

### If auto-detect needed (no bump type)

**Dispatch a `context-isolator` agent** (model: haiku) to analyze changes and recommend the bump. This keeps changelog parsing and commit analysis out of the main context.

Agent prompt — instruct it to:

1. Read every fragment in `changelog/unreleased/` (each file holds one or more `### Category` sections with bullets), noting which categories have content across all fragments.
2. Run `git log [last_tag]..HEAD --oneline`; count commits by conventional type; look for `BREAKING CHANGE` / `!` markers.
3. Apply detection rules — **MAJOR**: changelog contains "Breaking" or `### Removed` has content, or commits have breaking markers. **MINOR**: `### Added` has content or `feat:` commits exist. **PATCH**: only fixes/chores/docs.
4. Rewrite each changelog entry to be user-friendly (what users can DO, imperative verbs, benefits — e.g. "Open files in Obsidian without manual vault setup", not "Add obsidian_manager.py for auto vault registration").
5. Return in this exact structured format so the orchestrator can parse it:

```
RECOMMENDED_BUMP: [MAJOR|MINOR|PATCH]
NEXT_VERSION: [X.Y.Z]

CHANGELOG_SIGNALS:
- Added/Changed/Fixed/Removed counts, Breaking: yes/no

COMMIT_SIGNALS:
- Total commits, counts by type, breaking markers: yes/no

REASONING:
[1-2 sentences]

CHANGELOG_CONTENT_RAW:
[The raw fragment bullets, grouped by category]

CHANGELOG_CONTENT_IMPROVED:
[User-friendly rewritten entries]

RELEASE_THEME:
[1 sentence — the focus of this release]

RELEASE_HIGHLIGHTS:
[2-3 most significant changes with benefit explanations]
```

Include the current version (from VERSION) and last tag in the prompt. Parse the response for the recommendation, signals, reasoning, changelog content, theme, and highlights.

---

## Phase 4: Present and Confirm

Present the release plan compactly: current → new version, bump type and reasoning, the changelog/commit signals, the changes to be released, and the mechanical steps ahead (files modified: `VERSION`, `packages/cli/package.json`, root `package.json`, `apps/desktop/package.json`, `CHANGELOG.md`, `docs/changelog.mdx`, blog post; `changelog/unreleased/` fragments deleted; media freshness check + `apps/site/public/product/archive/vX.Y.Z/` written for the embedded shots; plus `changelog/archive/` + `docs/changelog-archive.mdx` if any version ages past the 10-version cap; git commit `chore(release): vX.Y.Z` + annotated tag; npm publish).

Also note: pushing the `vX.Y.Z` tag triggers the "Desktop Release" workflow (`.github/workflows/desktop-release.yml`), which asynchronously builds, signs, and notarizes the arm64 macOS app and attaches the DMG + `.zip` + `latest-mac.yml` to this release. That runs in a separate workflow, so a desktop build failure can never block or unwind the product release created here.

If `--dry-run`, **STOP** here.

Otherwise, use AskUserQuestion:

```
header: "Confirm Release"
question: "Create release vX.Y.Z?"
options:
  - label: "Yes, [BUMP] is correct (Recommended)"
  - label: "No, make it PATCH"
  - label: "No, make it MAJOR"
  - label: "Cancel"
```

If the user overrides the bump type, recalculate the version (and re-run Check 6 Steps 3-4 if the target version changed).

---

## Phase 5: Harness Maintenance (before tagging)

A release is the natural checkpoint for the decision/docs/research records. Run these before cutting the tag so the release ships with a curated record:

1. **ADR lifecycle** — run `/adr:review` scoped to specs implemented since the last tag (or `--all` if the proposed backlog is small). Accept implemented proposed ADRs, deprecate stale ones.
2. **Docs reconciliation** — run `/docs:reconcile --since "<last tag date>"` to catch developer-guide and external-doc drift from the changes going into this release. Apply high-priority updates now; note deferred items in the final report.
3. **Stamp maintenance markers** with the current date so the SessionStart nags reset:

   ```bash
   date -u +"%Y-%m-%dT%H:%M:%SZ" > docs/.last-reviewed
   date -u +"%Y-%m-%dT%H:%M:%SZ" > research/.last-curated
   ```

If any of these produce commits, land them on `main` before proceeding (they must be inside the tag).

---

## Phase 6: Execute Release

### 6.1: Check tag doesn't exist

```bash
git tag -l "vX.Y.Z"
```

If the tag exists, **STOP** and report (delete with `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z` if intentional).

### 6.2: Update VERSION file

```bash
printf "X.Y.Z" > VERSION
```

### 6.3: Sync version to package.json files

```bash
# packages/cli/package.json (the published npm package)
cd packages/cli && npm version X.Y.Z --no-git-tag-version && cd ../..

# Root package.json
npm version X.Y.Z --no-git-tag-version

# apps/desktop/package.json (the macOS desktop app)
cd apps/desktop && npm version X.Y.Z --no-git-tag-version && cd ../..
```

Bumping the desktop app keeps its artifact version (`DorkOS-X.Y.Z-arm64.dmg`) and electron-updater's version comparison in lockstep with the product version — the macOS build rides the `vX.Y.Z` tag (see Phase 4 and the "Desktop Release" workflow).

### 6.4: Compile fragments into the changelog

Compile every fragment in `changelog/unreleased/` into a new version section (see `changelog/README.md` for the semantics):

1. Collect all fragments, sorted by filename (chronological).
2. For each category in standard order (Added, Changed, Deprecated, Removed, Fixed, Security), merge every bullet from every fragment under a single `### Category` heading.
3. Insert that as `## [X.Y.Z] - YYYY-MM-DD` (today's date) directly below the `## [Unreleased]` note at the top of `CHANGELOG.md`. Leave the `## [Unreleased]` heading + its "add a fragment" HTML comment in place.
4. **Delete the compiled fragment files** (`git rm changelog/unreleased/*.md`) so `changelog/unreleased/` holds only `.gitkeep`.
5. **Refresh the `[Unreleased]` link-reference** at the bottom of `CHANGELOG.md` to point at the new release: `[Unreleased]: https://github.com/dork-labs/dorkos/compare/vX.Y.Z...HEAD`.
6. **Enforce the 10-version cap**: `CHANGELOG.md` keeps the 10 most recent version sections. Move any older section — byte-for-byte, with its link-reference definition if it has one — into the archive file under `changelog/archive/`: **prepend** it above the current top section (the archive is newest-first), then rename the file so its upper bound is the newest archived version (e.g. when `0.36.0` ages out, `CHANGELOG-v0.1.0-to-v0.35.0.md` → `CHANGELOG-v0.1.0-to-v0.36.0.md` via `git mv`) and update the archive's header line, the "Older releases…" pointer at the bottom of `CHANGELOG.md`, and the archive pointer in `docs/changelog.mdx` to the new range/filename.

### 6.5: Sync changelog to docs

Update `docs/changelog.mdx` to match the retained `CHANGELOG.md` sections: keep the frontmatter (`title: Changelog`, description) and intro line, replace the version sections with the 10 most recent, keep the "Changelog archive" pointer line, and never include link-reference definitions. Append any section that aged past the 10-version cap to `docs/changelog-archive.mdx` (keep its sections newest-first, mirroring `changelog.mdx`).

### 6.6: Media — freshness check, shot selection, and archive

Product media (screenshots and loops) gets embedded in this release's notes and blog post. This step catches a stale capture before it ships an out-of-date screenshot, picks the shots worth embedding, and freezes exactly those under the version label so the URLs written in 6.7 and 6.11 resolve forever. Read `apps/e2e/capture/README.md` and `changelog/README.md` (media section) if unfamiliar with the pipeline.

#### a. Freshness check

Read the currently published manifest's provenance:

```bash
GENERATED_AT=$(jq -r '.generatedAt' apps/site/public/product/manifest.json)
RUN_ID=$(jq -r '.runId' apps/site/public/product/manifest.json)
```

List UI-affecting commits since that capture ran:

```bash
git log --since="$GENERATED_AT" --oneline -- apps/client
```

List shots exempt from staleness nagging — human overrides (`source: "manual"` in the manifest) are curated on purpose and don't go stale the way an automated capture does:

```bash
jq -r '.assets[] | select(.source == "manual") | .surface' apps/site/public/product/manifest.json | sort -u
```

If the commit list is non-empty **and** this release's compiled changelog (the `## [X.Y.Z]` section from Phase 6.4) contains a user-visible UI change, the manifest is stale for that change's surface — unless that surface appears in the manual-override list above, in which case skip the nag for it.

**If a stale, non-exempt surface exists**, stop and re-capture before continuing:

```bash
pnpm --filter @dorkos/e2e capture
```

Then re-read the manifest (`generatedAt`, `runId`) and re-run this check before moving to shot selection.

#### b. Shot selection

From the compiled changelog section (Phase 6.4) and the underlying feature work, pick the shots worth embedding, matching each candidate to a `shots[].id` in `apps/site/public/product/manifest.json` (or `apps/e2e/capture/shots.ts`):

- **GitHub release notes** (Phase 6.11): 1-3 hero shots — the release's most significant, most visual changes.
- **Blog post** (Phase 6.7): more may be embedded, one per highlight where it helps show rather than just tell.

If a shipped feature has no shot yet, do not invent a placeholder or link a nonexistent file — note it in the Phase 7 report as a follow-up (e.g. "add a shot for X") and leave that highlight text-only.

#### c. Archive

Freeze exactly the shots selected in (b) — and only those — under the version label, so the URLs embedded in (d) keep resolving after the next capture run overwrites the live assets:

```bash
pnpm --filter @dorkos/e2e capture:archive vX.Y.Z --shots <comma-separated-shot-ids-from-step-b>
```

This writes `apps/site/public/product/archive/vX.Y.Z/` (the shot files plus an archive manifest). Add that directory to the release commit's `git add` list (Phase 6.8, below). **Repo-size discipline**: never omit `--shots` to archive the full set "just in case" — archive only what a note actually embeds.

#### d. Embedding rules

GitHub renders PNG/GIF inline in release-note markdown but does **not** play `.webm` inline — a bare webm link renders as a dead link in most markdown viewers. So, for every shot embedded in release notes or the blog post:

- Embed the shot's **poster PNG**, never the loop file: `archive/vX.Y.Z/<shot-id>-dark.png` for a loop shot (its poster) or `archive/vX.Y.Z/<shot-id>-light.png` for a still-only shot.
- Link the image (or a line beneath it) to the motion version: the docs page that embeds `<ProductShot id="<shot-id>" />` if one exists, otherwise the matching `/features/<slug>` section on dorkos.ai. Never link directly to a bare `.webm` URL as the "see it move" affordance — always route through a page that renders it in the shared frame.
- Use the **archived** absolute URL, `https://dorkos.ai/product/archive/vX.Y.Z/<shot-id>-<theme>.png` — never the live `/product/<file>` path in a release note. The live path repoints to the next capture run and would silently change what an old release note shows.

#### e. Feature catalog prompt

Checklist — answer before continuing:

- Does this release ship a feature that belongs in the marketing catalog (`apps/site/src/layers/features/marketing/lib/features.ts`)?
  - **New feature**: add a `Feature` entry. Write `tagline`/`description`/`benefits` benefit-led, not feature-led, per the file's schema TSDoc and the `writing-for-humans` skill — the tagline alone must answer "so what".
  - **Existing feature changed materially**: update its `tagline`/`description`/`benefits` to match the new behavior.
  - **Needs a `media.surface` binding and no shot exists**: add the shot to `apps/e2e/capture/shots.ts` (with `marketing` in its `consumers`) and capture it (`pnpm --filter @dorkos/e2e capture`) before wiring `media.surface` — never bind to a surface id with no published asset (the `features.test.ts` guard fails on this).
  - **No catalog-worthy change**: note "no catalog changes" in the Phase 7 report and continue.

### 6.7: Scaffold blog post

Write this for readers, not for the engineering team: apply the `writing-for-humans` skill (9th-grade level, benefit before mechanism). The theme sentence must pass the **explain-back test**: a non-developer should be able to read it once and say what the release does. Each highlight is **one idea, ≤2 sentences**, never a single run-on carrying three or four claims. Embed the shots selected in 6.6b using the rules in 6.6d.

Create `blog/dorkos-X-Y-Z.mdx` (dots → hyphens in the version):

```markdown
---
title: DorkOS X.Y.Z
description: [Theme sentence]
date: [today YYYY-MM-DD]
author: DorkOS Team
category: release
tags: [release, plus 2-3 relevant tags from the changes]
---

[Theme paragraph — 1-2 sentences describing the release focus]

## Highlights

[2-3 most significant changes with brief explanations, each backed by an embedded poster image per 6.6d where a shot exists]

## All Changes

[Copy from CHANGELOG.md version section — same content as GitHub Release]

## Install / Update

\`\`\`
npm install -g dorkos@X.Y.Z
\`\`\`
```

The user can edit this post before the release commit.

### 6.8: Commit and tag

```bash
# Stage all version-related changes. If Check 6 scaffolded a config migration,
# also stage apps/server/src/services/core/config-manager.ts (and
# packages/shared/src/config-schema.ts if it was part of the drift).
git add VERSION CHANGELOG.md docs/changelog.mdx docs/changelog-archive.mdx changelog/ packages/cli/package.json package.json apps/desktop/package.json blog/ apps/site/public/product/archive/vX.Y.Z/

git commit -m "$(cat <<'EOF'
chore(release): vX.Y.Z
EOF
)"

git tag -a vX.Y.Z -m "Release vX.Y.Z"
```

### 6.9: Publish to npm

Ask via AskUserQuestion (publish to npm now, or skip). If yes:

```bash
pnpm run publish:cli
```

The `prepublishOnly` hook in `packages/cli/package.json` builds before publishing.

#### Authentication: use a granular access token, not `npm login`

The npm account has 2FA enabled, so publishing requires a token that bypasses 2FA — a **web-login session token (`npm login`) will fail publish with a `403` demanding "a granular access token with bypass 2fa enabled."** Do not loop on `npm login` / OTP prompts.

The durable fix (lasts up to ~90 days, no per-publish OTP):

1. Create a **granular access token** at https://www.npmjs.com/settings/dorkian/tokens → _Generate New Token → Granular Access Token_:
   - **Expiration:** 90 days (npm's max)
   - **Permissions:** Read and write
   - **Packages and scopes:** select only the `dorkos` package (scopes the blast radius)
   - Granular tokens bypass 2FA automatically — nothing else to toggle.
2. Install it in `~/.npmrc` (replaces any existing web-login token line in place). The user runs this themselves so the secret stays out of the agent transcript:
   ```bash
   npm config set //registry.npmjs.org/:_authToken=npm_YOUR_TOKEN
   ```
3. Verify with `npm whoami` (should print the username with no error), then re-run `pnpm run publish:cli`.

When the token expires (~every couple months), the publish 403s again — repeat step 1 to mint a fresh one. To check auth state without printing the secret: `grep -c "_authToken" ~/.npmrc`.

### 6.10: Push to origin

```bash
git push origin main && git push origin vX.Y.Z
```

If push fails: the commit and tag exist locally — report the error, retry with the same commands, or undo with `git reset --hard HEAD~1 && git tag -d vX.Y.Z`.

### 6.11: GitHub Release notes

Ask via AskUserQuestion (create a GitHub Release, or skip). If yes, generate **narrative release notes**, using the `writing-changelogs` skill for structure and the `writing-for-humans` skill for readability:

- **Theme** (1-2 sentences) and **Highlights** (2-3 significant changes with benefit explanations) are written fresh. The theme sentence must pass the **explain-back test** (a non-developer can read it once and say what the release does). Each highlight is **one idea, ≤2 sentences**, never a single run-on carrying three or four claims.
- Embed the 1-3 hero shots selected in 6.6b, following the poster-PNG-plus-motion-link rules in 6.6d. A release with user-visible UI changes always includes at least one visual — do not skip this for a UI-affecting release.
- **All Changes** is copied **verbatim** from the just-created `## [X.Y.Z]` section of `CHANGELOG.md` — do NOT rewrite, regenerate, or summarize; those entries were already reviewed.
- End with install/update instructions (`npm update -g dorkos`) and the compare link: `https://github.com/dork-labs/dorkos/compare/v[prev]...v[new]`.

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "[narrative release notes]"
```

If `gh` is unavailable: `brew install gh && gh auth login`, or create the release manually at `https://github.com/dork-labs/dorkos/releases/new?tag=vX.Y.Z`.

**The GitHub Release is created here, first, with the notes above.** The macOS desktop assets (`.dmg` + `.zip` + `latest-mac.yml`) attach **later, asynchronously**: pushing the `vX.Y.Z` tag (Phase 6.10) already kicked off the "Desktop Release" workflow, which builds, signs, and notarizes the app and then upserts those files onto this same release. The first-ever notarization from a fresh signing identity can take ~30–65 min; later ones are minutes. The release and its notes are complete and published regardless — the desktop build attaching is a separate, fail-soft step.

---

## Phase 7: Report

Summarize: version, tag, commit SHA, npm package link (`https://www.npmjs.com/package/dorkos`), GitHub tag/compare links, harness-maintenance outcomes (ADRs progressed, docs reconciled, deferred items), any Check 6 migration notes, and the media outcome from Phase 6.6 (whether a re-capture was required, which shots were archived under `archive/vX.Y.Z/`, any shipped feature noted as missing a shot, and the features.ts catalog decision). Mention that the Docker image publishes automatically to `ghcr.io/dork-labs/dorkos:{version}` on the tag push (monitor: `https://github.com/dork-labs/dorkos/actions/workflows/publish-docker.yml`).

Also tell the user the "Desktop Release" workflow is building the macOS app on the same tag push and will attach the DMG + `.zip` + `latest-mac.yml` to this release when it finishes (monitor: `https://github.com/dork-labs/dorkos/actions/workflows/desktop-release.yml`). First-ever notarization can take ~30–65 min; minutes thereafter. Once the assets attach, `https://dorkos.ai/download/mac` starts resolving to the new DMG. A desktop build failure does not affect the already-published release — re-run the workflow from the tag if it fails.

If npm publish failed after the tag was pushed: retry `pnpm run publish:cli`; check auth with `npm whoami` (see the token section above).

---

## Related Commands

- `/changelog:backfill` — Emit fragments in `changelog/unreleased/` for commits since the last tag that lack one

## When to Use

- After completing a set of features (minor release)
- After fixing bugs (patch release)
- Before breaking changes (major release)
- At natural milestones (sprint end, before sharing)

**Do NOT release on every commit** — releases represent meaningful milestones.
