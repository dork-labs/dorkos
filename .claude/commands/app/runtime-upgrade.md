---
description: Analyze runtime dependency changelogs, assess codebase impact, and generate upgrade + feature adoption specs
argument-hint: '<package-name> [--to=version] [analyze|plan|interactive]'
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, WebSearch, WebFetch, AskUserQuestion, TaskCreate, TaskUpdate, TaskList, TaskOutput, Agent, mcp__context7__resolve-library-id, mcp__context7__query-docs
category: application
---

# Runtime Dependency Upgrade

Strategic upgrade workflow for agent runtime dependencies. Unlike `/app:upgrade` (which treats all deps uniformly — "can we safely bump?"), this command performs deep changelog analysis, impact assessment, and feature discovery — "what should we build on top of the new version?"

## When to Use This vs `/app:upgrade`

| Scenario                                                | Use                    |
| ------------------------------------------------------- | ---------------------- |
| Routine patch/minor bumps across all deps               | `/app:upgrade`         |
| Security-driven update to a runtime SDK                 | `/app:upgrade`         |
| New major version of a runtime SDK with new features    | `/app:runtime-upgrade` |
| Want to discover what new SDK capabilities to adopt     | `/app:runtime-upgrade` |
| Upgrading a dep that wraps our `AgentRuntime` interface | `/app:runtime-upgrade` |

## Arguments

Parse `$ARGUMENTS` for:

### Required

- `<package-name>` — The npm package to analyze (e.g., `@anthropic-ai/claude-agent-sdk`)

### Options

| Flag               | Effect                             |
| ------------------ | ---------------------------------- |
| `--to=<version>`   | Target version (default: `latest`) |
| `--from=<version>` | Override current version detection |

### Modes (mutually exclusive, default: interactive)

| Mode          | Description                                                  |
| ------------- | ------------------------------------------------------------ |
| `analyze`     | Fetch changelogs + produce impact assessment only (no specs) |
| `plan`        | Analyze + generate specs for upgrade and feature adoption    |
| `interactive` | Full guided workflow with decisions at each phase (default)  |

### Examples

```bash
/app:runtime-upgrade @anthropic-ai/claude-agent-sdk
/app:runtime-upgrade @anthropic-ai/claude-agent-sdk --to=0.3.0
/app:runtime-upgrade @anthropic-ai/claude-agent-sdk analyze
/app:runtime-upgrade @anthropic-ai/claude-agent-sdk plan --to=0.4.0
```

## Task

Execute phases based on the selected mode. Load the `upgrading-runtime-dependencies` skill for judgment guidance throughout.

---

## Phase 1: Discovery

### Step 1.1: Identify Current Version

```bash
grep '"<package-name>"' package.json apps/*/package.json packages/*/package.json
```

Verify the version is consistent across all workspace packages. If versions differ, warn the user.

### Step 1.2: Resolve Target Version

If `--to` was provided, use that. Otherwise:

```bash
npm view <package-name> version
```

If current == target, report "Already at latest version" and stop.

### Step 1.3: Load Runtime Config

Read `.claude/config/runtime-deps.json` to get package-specific context:

- `codebase_root` — Where the integration code lives
- `abstraction_boundary` — The interface this dep is behind
- `related_adrs` — ADRs that govern how we use this dep
- `changelog_sources` — Where to find changelogs
- `github_repo` — The GitHub owner/repo

If the package isn't in the config, use AskUserQuestion to gather this information and offer to add it.

### Step 1.4: Calculate Version Delta

```bash
npm view <package-name> versions --json
```

Filter to versions between current and target. Count releases, identify if any are major bumps.

Display:

```markdown
## Runtime Upgrade Discovery

**Package**: <package-name>
**Current**: <current-version>
**Target**: <target-version>
**Releases between**: <count>
**Major version bumps**: <yes/no>
**Codebase root**: <from config>
**Abstraction boundary**: <from config>
```

---

## Phase 2: Changelog Collection

Use the `changelog_sources` from `.claude/config/runtime-deps.json` in priority order. Cross-reference sources for completeness.

### Step 2.1: Get Authoritative Version List (npm Registry)

Fetch the npm packument to get the definitive version list and publish timestamps:

```
WebFetch: https://registry.npmjs.org/<package-name>
```

Extract the `.time` field (version → ISO timestamp mapping) and `.dist-tags.latest`. Filter to versions where semver is > from_version and <= to_version.

### Step 2.2: Fetch Per-Version Release Notes (GitHub Releases API)

If `github_repo` is known from runtime config:

```
WebFetch: https://api.github.com/repos/<owner>/<repo>/releases?per_page=100
```

- Each release has `tag_name` (e.g., `v0.2.89`), `published_at`, and `body` (Markdown)
- Filter to releases in the target version range
- Note: not every npm version has a GitHub release — track gaps for Step 2.3
- GitHub rate limit: 60 req/hr unauthenticated. One paginated call typically covers all needed versions.

### Step 2.3: Fill Gaps from CHANGELOG.md

For versions that appear in npm but not in GitHub releases, fetch the repo's CHANGELOG.md:

```
WebFetch: <changelog_md URL from config>
```

Parse `## X.Y.Z` headers to extract per-version blocks. Enrich with timestamps from Step 2.1.

**Note**: Some packages don't ship CHANGELOG.md in the npm tarball. Always fetch from the raw GitHub URL, not from node_modules.

### Step 2.4: Context7 Documentation (Major Versions Only)

For major version bumps, also check for migration guides:

```
mcp__context7__resolve-library-id: { libraryName: "<package-name>" }
mcp__context7__query-docs: { topic: "migration guide v[current] to v[target]" }
```

### Step 2.5: Web Search Fallback

If prior sources are insufficient (e.g., package not in config, no GitHub repo known):

```
WebSearch: "<package-name> changelog <from-version> to <to-version>"
WebSearch: "<package-name> migration guide <major-version>"
```

### Step 2.6: Filter Noise

De-emphasize low-signal entries:

- "Updated to parity with X vY.Z" — note but don't analyze individually
- "chore: Update CHANGELOG.md" — skip entirely
- Empty release bodies — mark as "no notes available"

### Step 2.7: Cross-Reference and Categorize

Merge findings from all sources. For each change, assign a category:

| Category      | Description                                           | Icon |
| ------------- | ----------------------------------------------------- | ---- |
| `breaking`    | API changes that will cause compile or runtime errors | 🔴   |
| `deprecated`  | APIs marked for removal in a future version           | 🟡   |
| `feature`     | New capabilities added                                | 🟢   |
| `fix`         | Bug fixes                                             | 🔧   |
| `performance` | Performance improvements                              | ⚡   |
| `internal`    | Refactors, docs, CI changes with no user impact       | ⚪   |

### Step 2.7: Write Changelog Document

Create the research directory and write the categorized changelog:

```bash
mkdir -p research/runtime-upgrades/<package-short-name>/<from>-to-<to>
```

Write to `research/runtime-upgrades/<package-short-name>/<from>-to-<to>/changelog.md`:

```markdown
# <package-name> Changelog: <from> → <to>

**Generated**: <date>
**Sources**: <list sources that contributed>
**Releases covered**: <count>

## Breaking Changes 🔴

### <version> — <title>

- <change description>
  - **Affected API**: `<function/type name>`
  - **Migration**: <what to do>

## Deprecations 🟡

### <version> — <title>

- <change description>
  - **Current usage**: `<deprecated API>`
  - **Replacement**: `<new API>`
  - **Removal timeline**: <when it will be removed>

## New Features 🟢

### <version> — <title>

- <change description>
  - **API**: `<new function/type>`
  - **Use case**: <what this enables>

## Bug Fixes 🔧

- <version>: <fix description>

## Performance ⚡

- <version>: <improvement description>

## Internal ⚪

- <version>: <change description>
```

**For `analyze` mode with no further phases**: Proceed to Phase 3 (Impact Analysis).

---

## Phase 3: Impact Analysis

For each non-internal change, analyze how it affects our codebase.

### Step 3.1: Read Runtime Integration Code

Using `codebase_root` from config, read the key integration files:

```bash
# Get an overview of the integration surface
grep -r "import.*from '<package-name>'" <codebase_root> --include="*.ts"
```

Read each file that imports from the package. Understand what SDK APIs we use.

### Step 3.2: Read Related ADRs

For each ADR ID in the config's `related_adrs`, read the decision to understand constraints:

```bash
ls decisions/<adr-number>-*.md
```

### Step 3.3: Analyze Breaking Changes

For each breaking change:

1. Grep for the affected API in the codebase root
2. Identify every file and line that needs to change
3. Estimate effort: `trivial` (1-5 lines), `moderate` (6-30 lines), `significant` (30+ lines or architectural)
4. Check if the change conflicts with any related ADR

### Step 3.4: Analyze Deprecations

For each deprecation:

1. Grep for deprecated API usage
2. Identify the replacement API
3. Check if we're using the deprecated API in tests only, production code, or both
4. Estimate migration effort

### Step 3.5: Analyze New Features

For each new feature, assess relevance to our use case:

| Relevance | Criteria                                                                  |
| --------- | ------------------------------------------------------------------------- |
| `high`    | Directly improves something we already do, or enables a requested feature |
| `medium`  | Useful but not urgent — nice-to-have improvement                          |
| `low`     | Not relevant to our current usage patterns                                |
| `none`    | Feature for a use case we don't have                                      |

For `high` and `medium` features, also assess:

- **Adoption effort**: trivial / moderate / significant
- **Dependencies**: Does adopting this require other changes first?
- **Value**: What specific improvement does this bring to DorkOS?

### Step 3.6: Analyze Bug Fixes

Check if any fixes resolve known issues or workarounds in our code:

```bash
# Search for TODO/FIXME/HACK comments that might reference the package
grep -r "TODO\|FIXME\|HACK\|WORKAROUND" <codebase_root> --include="*.ts"
```

### Step 3.7: Write Impact Assessment

Write to `research/runtime-upgrades/<package-short-name>/<from>-to-<to>/impact-assessment.md`:

```markdown
# Impact Assessment: <package-name> <from> → <to>

**Generated**: <date>
**Codebase root**: <path>
**Abstraction boundary**: <interface name>
**Related ADRs**: <list>

## Summary

| Category             | Count | Action Required |
| -------------------- | ----- | --------------- |
| Breaking changes     | X     | Must fix        |
| Deprecations         | X     | Should migrate  |
| Features (high)      | X     | Recommend adopt |
| Features (medium)    | X     | Consider adopt  |
| Features (low)       | X     | No action       |
| Bug fixes (relevant) | X     | Auto-resolved   |

**Overall upgrade risk**: [Low/Medium/High]
**Estimated total effort**: [time range]

## Breaking Changes — Detailed Impact

### <change title>

- **What changed**: <description>
- **Affected files**:
  - `<file>:<line>` — <what needs to change>
  - `<file>:<line>` — <what needs to change>
- **Effort**: <trivial/moderate/significant>
- **ADR conflicts**: <none, or describe>
- **Migration approach**: <specific steps>

## Deprecation Migrations

### <deprecated API>

- **Current usage**: X occurrences in Y files
- **Replacement**: `<new API>`
- **Files to update**:
  - `<file>:<line>`
- **Effort**: <trivial/moderate/significant>

## Recommended Feature Adoptions

### <feature name> (Relevance: High)

- **What it enables**: <description>
- **Value to DorkOS**: <specific benefit>
- **Adoption effort**: <trivial/moderate/significant>
- **Dependencies**: <other changes needed first>
- **Suggested approach**: <brief implementation strategy>

### <feature name> (Relevance: Medium)

- ...

## Bug Fixes Resolving Known Issues

- <fix>: Resolves workaround in `<file>:<line>` — can remove <workaround description>

## No Action Required

- <count> low-relevance features (see changelog for details)
- <count> internal changes
- <count> irrelevant bug fixes
```

**For `analyze` mode**: Stop here and display summary.

Use AskUserQuestion:

```
Impact assessment complete. Would you like to:
- Proceed to spec generation → continue to Phase 4
- Review the documents first → I'll show the paths
- Stop here → run `/app:runtime-upgrade <package> plan` later to generate specs
```

---

## Phase 4: Triage (Interactive Mode Only)

Present each actionable item for user decision.

### Step 4.1: Breaking Changes (Mandatory)

These must be handled — no decision needed. Confirm approach:

```markdown
## Breaking Changes (must handle)

| #   | Change   | Effort   | Approach             |
| --- | -------- | -------- | -------------------- |
| 1   | <change> | <effort> | <migration approach> |
| 2   | <change> | <effort> | <migration approach> |
```

Use AskUserQuestion:

- Approaches look good, proceed
- I want to adjust the approach for #X

### Step 4.2: Deprecations

```markdown
## Deprecations

| #   | Deprecated API | Usage Count | Effort   | Recommendation      |
| --- | -------------- | ----------- | -------- | ------------------- |
| 1   | <api>          | X uses      | <effort> | Migrate now / Defer |
```

Use AskUserQuestion for each non-trivial deprecation:

- Migrate as part of this upgrade
- Defer to a later upgrade
- Skip (accept the deprecation warning for now)

### Step 4.3: New Features

```markdown
## New Features Available

| #   | Feature   | Relevance | Effort   | Value           |
| --- | --------- | --------- | -------- | --------------- |
| 1   | <feature> | High      | <effort> | <value summary> |
| 2   | <feature> | Medium    | <effort> | <value summary> |
```

Use AskUserQuestion for each high/medium feature:

- Adopt as part of this upgrade (include in upgrade spec)
- Create separate spec for later adoption
- Skip this feature

### Step 4.4: Persist Decisions

Save triage decisions to `research/runtime-upgrades/<package-short-name>/<from>-to-<to>/triage-decisions.md`:

```markdown
# Triage Decisions

**Date**: <date>

## Included in Upgrade Spec

- [x] All breaking change migrations
- [x] <deprecation migration>
- [x] <trivial feature adoption>

## Separate Specs

- <feature name> — <brief rationale>

## Deferred

- <deprecation> — reason: <why>

## Skipped

- <feature> — reason: <why>
```

---

## Phase 5: Spec Generation

### Step 5.1: Create Upgrade Spec

This spec covers the version bump itself plus all items marked "included in upgrade spec" from triage.

Create spec via manifest-ops:

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  .claude/scripts/spec-manifest-ops.ts add \
  "<package-short-name>-upgrade-<target-version>" \
  "<package-name> Upgrade to <target-version>" \
  --status=ideation
```

Write `specs/<package-short-name>-upgrade-<target-version>/01-ideation.md`:

```markdown
# <Package Name> Upgrade: <from> → <to>

## Problem Statement

We are running <package-name> at version <from>. Version <to> is available with
<count> breaking changes, <count> deprecations, and <count> new features relevant
to our use case.

## Research

- Changelog: `research/runtime-upgrades/<package-short-name>/<from>-to-<to>/changelog.md`
- Impact assessment: `research/runtime-upgrades/<package-short-name>/<from>-to-<to>/impact-assessment.md`
- Triage decisions: `research/runtime-upgrades/<package-short-name>/<from>-to-<to>/triage-decisions.md`

## Scope

### Must Do (Breaking Changes)

<list from triage>

### Should Do (Deprecation Migrations)

<list from triage>

### Nice to Have (Trivial Feature Adoptions)

<list from triage>

## Out of Scope

<features deferred to separate specs, with links>

## Risk Assessment

<from impact assessment summary>
```

### Step 5.2: Create Feature Adoption Specs

For each feature marked "create separate spec" in triage:

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  .claude/scripts/spec-manifest-ops.ts add \
  "<feature-slug>" \
  "<Feature Title>" \
  --status=ideation
```

Write `specs/<feature-slug>/01-ideation.md` with:

- Problem statement (what this feature enables)
- Link back to the changelog entry and impact assessment
- Suggested approach from the impact analysis
- Dependencies (e.g., "requires <package-short-name>-upgrade-<target-version> to be completed first")

### Step 5.3: Link Specs

If multiple specs were created, note the dependency chain in each spec's ideation doc:

```markdown
## Dependencies

- **Blocked by**: `<package-short-name>-upgrade-<target-version>` (must upgrade first)
```

**For `plan` mode**: Stop here and display spec summary.

---

## Phase 6: Bridge to /app:upgrade (Optional)

In `interactive` mode, after specs are created:

Use AskUserQuestion:

```
Specs have been created. Would you like to:
- Execute the upgrade now → I'll run the version bump and breaking change fixes
- Run `/app:upgrade <package-name>` separately → gives you the full validation pipeline
- Stop here → specs are ready for `/spec:execute` whenever you're ready
```

If the user wants to execute now:

1. Create a branch: `git checkout -b runtime/<package-short-name>-upgrade-<target-version>`
2. Bump the version:
   ```bash
   pnpm add <package-name>@<target-version>
   ```
   Apply to all workspace packages that use it.
3. Run validation: `pnpm lint && pnpm typecheck && pnpm build && pnpm test:run`
4. If validation fails, the breaking change migrations from the spec guide the fixes
5. Commit the version bump separately from the migration fixes

---

## Output Format

### For `analyze` mode:

```
📊 Runtime Upgrade Analysis Complete

Package: <package-name>
Version: <from> → <to>
Releases: <count>

Impact Summary:
  🔴 Breaking changes: X
  🟡 Deprecations: X
  🟢 New features (relevant): X
  🔧 Relevant bug fixes: X

Documents:
  - Changelog: research/runtime-upgrades/<pkg>/<ver>/changelog.md
  - Impact: research/runtime-upgrades/<pkg>/<ver>/impact-assessment.md

Next: Run `/app:runtime-upgrade <package> plan` to generate specs.
```

### For `plan` mode:

```
📋 Runtime Upgrade Plan Complete

Package: <package-name>
Version: <from> → <to>

Specs Created:
  - specs/<upgrade-slug>/ — Version bump + breaking changes
  - specs/<feature-slug>/ — <feature name> adoption
  - specs/<feature-slug>/ — <feature name> adoption

Documents:
  - research/runtime-upgrades/<pkg>/<ver>/changelog.md
  - research/runtime-upgrades/<pkg>/<ver>/impact-assessment.md

Next: Run `/spec:create specs/<upgrade-slug>/01-ideation.md` to flesh out the upgrade spec.
```

### For `interactive` mode (completion):

```
✅ Runtime Upgrade Analysis & Planning Complete

Package: <package-name>
Version: <from> → <to>

Research:
  - Changelog: <path>
  - Impact assessment: <path>
  - Triage decisions: <path>

Specs:
  - <upgrade-spec> (upgrade + breaking changes)
  - <feature-spec> (feature adoption)

Status: [Ready for /spec:execute | Version bumped, ready for migration | Fully complete]
```

---

## Edge Cases

- **Package not in runtime-deps config**: Ask user for codebase root and abstraction info, offer to add to config
- **No changelog found from any source**: Ask user for a URL or to paste changelog content, then proceed
- **Current version already at target**: Report "Already at latest" and stop
- **Package not installed**: Report error and stop
- **No breaking changes, no relevant features**: Report "Safe to bump with `/app:upgrade`" — this command adds no value for routine patches
- **GitHub API rate limited**: Fall back to other sources, suggest user provides a token
- **Versions between current and target exceed 50**: Summarize at the major/minor level rather than per-patch
