---
description: Comprehensive dependency upgrade with security audit, prioritization, and validation
argument-hint: '[check|audit|plan|interactive] [package...] [--patch|--minor|--major] [--security] [--no-cooldown]'
allowed-tools: Bash, Read, Grep, Glob, Edit, WebSearch, WebFetch, AskUserQuestion, TodoWrite
category: application
---

# Application Upgrade

Comprehensive dependency upgrade management with security auditing, intelligent prioritization, documentation lookup, and validation.

## Arguments

Parse `$ARGUMENTS` for these options:

### Modes (mutually exclusive, default: interactive)

| Mode          | Description                                   |
| ------------- | --------------------------------------------- |
| `check`       | Show outdated packages only, no changes       |
| `audit`       | Security audit only, suggest fixes            |
| `plan`        | Generate prioritized upgrade plan, no changes |
| `interactive` | Full guided upgrade workflow (default)        |

### Flags

| Flag            | Effect                                                      |
| --------------- | ----------------------------------------------------------- |
| `--patch`       | Only patch version upgrades (x.x.PATCH)                     |
| `--minor`       | Patch + minor version upgrades (x.MINOR.x)                  |
| `--major`       | All versions including major (default for plan/interactive) |
| `--security`    | Only security-related upgrades                              |
| `--no-cooldown` | Skip 21-day cooldown check for new releases                 |
| `[package...]`  | Specific packages to upgrade                                |

### Examples

```bash
/app:upgrade                        # Full interactive upgrade
/app:upgrade check                  # Just show outdated packages
/app:upgrade audit                  # Security audit only
/app:upgrade plan                   # Generate upgrade plan
/app:upgrade react --major          # Upgrade React cluster
/app:upgrade --security             # Only security patches
/app:upgrade --patch                # Only patch updates (safest)
```

## Task

Execute phases based on the selected mode.

---

## Phase 1: Discovery & Analysis

### Step 1.1: Check Outdated Packages

```bash
pnpm outdated
```

### Step 1.2: Security Audit

```bash
pnpm audit
```

### Step 1.3: Categorize Dependencies

Analyze the output and categorize packages:

| Category              | Priority    | Description                           |
| --------------------- | ----------- | ------------------------------------- |
| **Security Critical** | Immediate   | Known CVEs with active exploits       |
| **Security High**     | This Sprint | Known CVEs without known exploits     |
| **Framework Core**    | High        | Next.js, React, Prisma, TypeScript    |
| **Breaking Changes**  | Careful     | Major version bumps                   |
| **Feature Updates**   | Normal      | Minor version bumps with new features |
| **Patches**           | Low Risk    | Bug fixes only (x.x.PATCH)            |

### Step 1.4: Identify Peer Dependency Clusters

These packages MUST upgrade together:

**React Cluster:**

- react, react-dom
- @types/react, @types/react-dom
- All @radix-ui/\* packages

**Prisma Cluster:**

- prisma
- @prisma/client
- @prisma/adapter-pg

**TanStack Cluster:**

- @tanstack/react-query
- @tanstack/react-query-devtools

**Tailwind Cluster:**

- tailwindcss
- @tailwindcss/postcss

### Step 1.5: Present Analysis

```markdown
## Dependency Analysis

### Security Issues

| Package   | Current   | Fixed In  | Severity                   | CVE      |
| --------- | --------- | --------- | -------------------------- | -------- |
| [package] | [version] | [version] | [Critical/High/Medium/Low] | [CVE-ID] |

### Outdated Packages by Category

#### Framework Core (upgrade with care)

| Package | Current | Latest | Type  | Notes                 |
| ------- | ------- | ------ | ----- | --------------------- |
| next    | 16.0.8  | 16.1.0 | minor | Check migration guide |

#### UI Layer

[...]

#### Data Layer

[...]

#### Utilities

[...]

### Peer Dependency Clusters

- React cluster: X packages need coordinated upgrade
- Prisma cluster: X packages need coordinated upgrade
```

**For `check` mode**: Stop here and display results.

---

## Phase 2: Pre-Upgrade Checks

### Step 2.1: Verify Clean Git State

```bash
git status
```

If there are uncommitted changes, warn:

```
⚠️  You have uncommitted changes. Consider committing or stashing before upgrading.
```

Use AskUserQuestion:

- Proceed anyway
- Stop and let me commit first

### Step 2.2: Run Baseline Validation

```bash
pnpm lint
pnpm typecheck
pnpm build
pnpm test:run
```

**If any check fails**: Stop and report. The codebase must be in a working state before upgrades.

### Step 2.3: Verify Lock File Integrity

```bash
pnpm install --frozen-lockfile
```

If this fails, the lock file may be corrupted or out of sync.

---

## Phase 3: Documentation Lookup (For Major Versions)

For each **major version upgrade**, fetch migration documentation:

### Step 3.1: Resolve Library ID

Use Context7 MCP to get documentation:

```
mcp__context7__resolve-library-id: { libraryName: "[package-name]" }
```

### Step 3.2: Fetch Migration Guide

```
mcp__context7__query-docs: {
  context7CompatibleLibraryID: "[library-id]",
  topic: "migration guide v[current] to v[target]"
}
```

### Step 3.3: Check for Breaking Changes

For key packages, specifically look for:

| Package            | Key Migration Concerns                                 |
| ------------------ | ------------------------------------------------------ |
| **Next.js**        | App Router changes, middleware changes, config format  |
| **React**          | Hook changes, concurrent features, StrictMode behavior |
| **Prisma**         | Schema syntax, client API, migration format            |
| **TypeScript**     | Stricter type checking, removed features               |
| **Tailwind**       | Config format, class name changes                      |
| **TanStack Query** | Hook API, devtools changes                             |
| **Zod**            | Schema API, error format                               |

### Step 3.4: Identify Documentation Updates Needed

Check if upgrade will require changes to:

- `CLAUDE.md` Technology Stack table
- `contributing/` patterns
- Breaking Changes Notes section

---

## Phase 4: Prioritization

### Step 4.1: Generate Upgrade Order

Recommended order (security-first, dependencies-aware):

1. **Security Patches** — Apply immediately
2. **Peer Dependency Clusters** — Upgrade together
3. **Framework Core** (bottom-up):
   - TypeScript (affects all type checking)
   - React/React-DOM (peer dependency for many)
   - Next.js (depends on React)
4. **Data Layer** — Prisma, TanStack Query
5. **UI Layer** — Tailwind, Shadcn components, Radix
6. **Utilities** — lodash-es, date-fns, motion

### Step 4.2: Present Prioritized Plan

```markdown
## Upgrade Plan

### Recommended Order

| Priority | Package(s)                       | Current → Target | Type     | Risk   |
| -------- | -------------------------------- | ---------------- | -------- | ------ |
| 1        | [security packages]              | ...              | security | Low    |
| 2        | react, react-dom, @types/react\* | 19.2.0 → 19.3.0  | cluster  | Medium |
| 3        | next                             | 16.0.8 → 16.1.0  | minor    | Low    |
| ...      | ...                              | ...              | ...      | ...    |

### Estimated Effort

- Patches only: ~15 minutes
- Including minors: ~1 hour
- Including majors: ~2-4 hours (depends on breaking changes)

### Packages Skipped (21-day cooldown)

- [package] v2.0.0 released 5 days ago — waiting for stability
```

Use AskUserQuestion:

- Proceed with all recommended upgrades
- Upgrade security patches only
- Upgrade patches and minors only
- Select specific packages to upgrade
- Skip for now

**For `plan` mode**: Stop here and display the plan.

---

## Phase 5: Major Upgrade Decision Framework

For each **major version upgrade**, evaluate:

### Decision Matrix

| Factor               | Favor Upgrade                    | Favor Delay                  |
| -------------------- | -------------------------------- | ---------------------------- |
| **Security**         | Has CVE fixes                    | No security issues           |
| **Features**         | Need new features                | Current features sufficient  |
| **Maintenance**      | Old version EOL                  | Old version still supported  |
| **Breaking Changes** | Minimal, well-documented         | Extensive, poorly documented |
| **Ecosystem**        | Dependencies support new version | Dependencies lag behind      |
| **Cooldown**         | Release >21 days old             | Just released (<21 days)     |

### Step 5.1: For Each Major Upgrade, Present Decision

```markdown
### Major Upgrade: [package] v[current] → v[target]

**Recommendation**: [Upgrade/Defer]

| Factor             | Status                         |
| ------------------ | ------------------------------ |
| Security fixes     | [Yes/No]                       |
| Breaking changes   | [Minimal/Moderate/Extensive]   |
| Migration guide    | [Available/Incomplete/Missing] |
| Days since release | [X days]                       |
| Ecosystem ready    | [Yes/Partial/No]               |

**Key breaking changes:**

1. [change 1]
2. [change 2]

**Migration effort**: [Low/Medium/High]
```

Use AskUserQuestion for each major upgrade:

- Proceed with this upgrade
- Defer this upgrade
- Need more information

---

## Phase 6: Upgrade Execution

### Step 6.1: Create Upgrade Branch

```bash
git checkout -b deps/upgrade-$(date +%Y%m%d)
```

Or for single package:

```bash
git checkout -b deps/upgrade-[package-name]
```

### Step 6.2: Upgrade Packages by Cluster

For each approved upgrade:

**Single package:**

```bash
pnpm add [package]@[version]
```

**Cluster upgrade (example: React):**

```bash
pnpm add react@latest react-dom@latest
pnpm add -D @types/react@latest @types/react-dom@latest
```

### Step 6.3: Validate After Each Upgrade

```bash
pnpm lint
pnpm typecheck
```

If validation fails:

- Stop and report the error
- Provide specific fix suggestions
- Ask if user wants to continue or rollback

### Step 6.4: Commit Each Upgrade Separately

```bash
git add package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
chore(deps): upgrade [package] from [old] to [new]

[Brief description of why/what changed]

Generated with Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Phase 7: Post-Upgrade Validation

### Step 7.1: Full Validation Suite

Run all checks sequentially:

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm build
```

```bash
pnpm test:run
```

### Step 7.2: Security Re-Audit

```bash
pnpm audit
```

Verify no new vulnerabilities were introduced.

### Step 7.3: Manual Smoke Test Suggestion

````markdown
## Manual Testing Recommended

Start the dev server and verify:

```bash
pnpm dev
```
````

Check these critical paths:

- [ ] Home page loads
- [ ] Authentication flows (if applicable)
- [ ] Form submissions work
- [ ] API routes respond correctly
- [ ] No console errors in browser

Check for visual regressions if UI libraries were upgraded.

````

---

## Phase 8: Documentation Updates

### Step 8.1: Update Technology Stack (if versions changed)

If major versions changed, update `CLAUDE.md` Technology Stack table:

```markdown
| Technology | Version | Purpose |
|------------|---------|---------|
| Next.js | [new version] | React framework (App Router) |
````

### Step 8.2: Update Breaking Changes Notes (if needed)

If new breaking changes were discovered, add to CLAUDE.md.

### Step 8.3: Update Developer Guides (if patterns changed)

Note which developer guides need updates based on API changes.

### Step 8.4: Commit Documentation

```bash
git add CLAUDE.md contributing/
git commit -m "$(cat <<'EOF'
docs: update for dependency upgrades

- Updated Technology Stack versions
- Added breaking changes notes for [package]

Generated with Claude Code
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

---

## Phase 9: Rollback Strategy

### If Upgrades Need to Be Reverted

**Full rollback:**

```bash
git checkout main -- package.json pnpm-lock.yaml
pnpm install
```

**Specific package rollback:**

```bash
git log --oneline -- package.json  # Find the commit before the upgrade
git checkout [commit-hash] -- package.json pnpm-lock.yaml
pnpm install
```

**Or revert specific commit:**

```bash
git revert [upgrade-commit-hash]
pnpm install
```

### Rollback Checklist

- [ ] Identify which upgrade caused the issue
- [ ] Revert the specific commit(s)
- [ ] Run `pnpm install` to restore lock file
- [ ] Verify `pnpm lint && pnpm typecheck && pnpm build && pnpm test:run`
- [ ] Document the issue for future reference

---

## Output Format

### For `check` mode:

```
📦 Dependency Check

Outdated Packages: X total
  - Security issues: X
  - Major updates: X
  - Minor updates: X
  - Patches: X

Run `/app:upgrade plan` for prioritized upgrade recommendations.
Run `/app:upgrade audit` for security details.
```

### For `audit` mode:

```
🔒 Security Audit

Vulnerabilities Found: X
  - Critical: X
  - High: X
  - Moderate: X
  - Low: X

[Detailed vulnerability table]

Run `pnpm audit fix` for automatic fixes (patch/minor only).
Run `/app:upgrade --security` to address all security issues.
```

### For `plan` mode:

```
📋 Upgrade Plan

[Prioritized upgrade table]

Total packages to upgrade: X
Estimated effort: [time estimate]

Run `/app:upgrade` to execute this plan interactively.
```

### For `interactive` mode (completion):

```
✅ Dependency Upgrade Complete

Upgraded:
  - [package]: [old] → [new]
  - [package]: [old] → [new]

Validation:
  ✅ Lint passed
  ✅ Typecheck passed
  ✅ Build passed
  ✅ Tests passed
  ✅ No new vulnerabilities

Branch: deps/upgrade-[date]
Commits: X

Next steps:
  - Review changes with `git diff main`
  - Run manual smoke tests
  - Merge to main when ready
```

---

## Edge Cases

- **No outdated packages**: Report "All dependencies are up to date!"
- **Lock file conflicts**: Suggest `rm pnpm-lock.yaml && pnpm install`
- **Peer dependency warnings**: List them and suggest resolution
- **Build fails after upgrade**: Stop, report error, suggest rollback
- **Test fails after upgrade**: Stop, provide failing test details, offer rollback
- **Network issues with Context7**: Fall back to WebSearch for migration guides
- **Package not in Context7**: Use WebSearch to find official migration docs
- **Circular dependencies**: Warn and suggest manual resolution

---

## Notes

- Always upgrade in a dedicated branch
- Commit each upgrade separately for easy rollback
- Major upgrades should be done one at a time
- Check the 21-day cooldown for new releases (supply chain security)
- Use `--no-cooldown` flag only for urgent security patches
- Keep CLAUDE.md Technology Stack table in sync with actual versions
