---
description: Check for available template updates from the upstream repository
argument-hint: [--json]
allowed-tools: Bash, Read, Write, Glob
---

# Template Check Command

Check if there are newer versions of the template available and display a changelog summary of what has changed since the current version.

## Arguments

- `$ARGUMENTS` - Optional flags:
  - `--json` - Output in JSON format for scripting

## Process

### Step 1: Detect Current Version

First, determine the current template version from one of these sources (in order of priority):

**Option A: Read from `.template.json` manifest**

```bash
cat .template.json 2>/dev/null
```

If the file exists, parse JSON to extract:
- `template.repository` (e.g., "doriancollier/dorkian-next-stack")
- `template.version` (e.g., "v0.2.0-alpha.8")
- `template.lastUpdated` (optional)

**Option B: Fall back to VERSION file**

```bash
cat VERSION 2>/dev/null
```

If VERSION exists but no `.template.json`:
- Version is the content of VERSION file (prepend "v" if not present)
- Repository defaults to "doriancollier/dorkian-next-stack" (the canonical upstream)
- Note: First-time detection mode

**Option C: No version info available**

If neither file exists, report:

```markdown
## Template Version Unknown

Could not determine current template version:
- No `.template.json` manifest found
- No `VERSION` file found

**To initialize template tracking:**
1. Create a `VERSION` file with your current version (e.g., `0.2.0-alpha.8`)
2. Run `/template:update` to create the manifest

Or if this is a fresh clone, run `/template:update --init` to set up tracking.
```

**STOP** if no version can be determined.

---

### Step 2: Fetch Latest Version from GitHub

Use the template-fetch.ts script to get available tags:

```bash
npx tsx .claude/scripts/template-fetch.ts tags [repository]
```

Parse the JSON output to find the latest version:
- Filter tags that match semver pattern (`v?X.Y.Z` or `v?X.Y.Z-prerelease`)
- Sort by version (descending)
- Take the first (latest) tag

If fetch fails, report the error:

```markdown
## Cannot Check for Updates

Failed to fetch tags from GitHub: [error message]

**Possible causes:**
- Network connectivity issue
- GitHub API rate limit exceeded (resets at [time])
- Repository not found or private

**To retry later:** `/template:check`
```

---

### Step 3: Compare Versions

Compare current version with latest available:

**If current version equals latest:**

```markdown
## Template Up-to-Date

**Current version:** v0.2.0-alpha.9
**Latest version:** v0.2.0-alpha.9

Your template is up to date. No updates available.
```

**If current version is newer than latest (edge case):**

```markdown
## Template Ahead of Upstream

**Current version:** v0.3.0-beta.1
**Latest upstream:** v0.2.0-alpha.9

Your version is newer than the latest upstream release. This may happen if:
- You're developing on a fork ahead of the main template
- Version was manually bumped

No action needed unless you want to sync with upstream.
```

**If update is available, proceed to Step 4.**

---

### Step 4: Fetch and Display Changelog

Fetch the changelog content between the two versions:

```bash
npx tsx .claude/scripts/template-fetch.ts changelog [repository] [current-version] [latest-version]
```

If changelog fetch succeeds, display the update summary:

```markdown
## Template Update Available

**Current version:** v0.2.0-alpha.5
**Latest version:** v0.2.0-alpha.9

---

### Changes since v0.2.0-alpha.5

## [0.2.0-alpha.9] - 2026-02-02

### Added
- Enhance system landing page with world-class design

## [0.2.0-alpha.8] - 2026-02-01

### Added
- Add GitHub link to system sidebar

## [0.2.0-alpha.7] - 2026-02-01

### Added
- Render developer guides as HTML pages at /system/guides

## [0.2.0-alpha.6] - 2026-02-01

### Added
- Add roadmap clearing functionality
- Add autonomous roadmap execution system

### Changed
- Add roadmap:clear command to documentation
- Add comprehensive documentation for autonomous roadmap execution

---

**To update:** Run `/template:update` to selectively apply these changes.

**Note:** Updates will preserve your customizations and user-created files.
```

If changelog fetch fails (e.g., CHANGELOG.md not found in repo):

```markdown
## Template Update Available

**Current version:** v0.2.0-alpha.5
**Latest version:** v0.2.0-alpha.9

---

### Changelog Not Available

Could not fetch changelog details. The update is still available.

View changes on GitHub:
https://github.com/[repository]/compare/v0.2.0-alpha.5...v0.2.0-alpha.9

---

**To update:** Run `/template:update` to selectively apply changes.
```

---

### Step 5: JSON Output Mode

If `--json` flag is present in `$ARGUMENTS`, output structured JSON instead of markdown:

```json
{
  "status": "update_available",
  "current": {
    "version": "v0.2.0-alpha.5",
    "source": "template.json",
    "repository": "doriancollier/dorkian-next-stack"
  },
  "latest": {
    "version": "v0.2.0-alpha.9",
    "commit": "abc123def456...",
    "publishedAt": "2026-02-02T12:00:00Z"
  },
  "changelog": {
    "available": true,
    "content": "## [0.2.0-alpha.9] - 2026-02-02\n\n### Added\n- ...",
    "versionsIncluded": ["0.2.0-alpha.9", "0.2.0-alpha.8", "0.2.0-alpha.7", "0.2.0-alpha.6"]
  },
  "compareUrl": "https://github.com/doriancollier/dorkian-next-stack/compare/v0.2.0-alpha.5...v0.2.0-alpha.9"
}
```

Possible `status` values:
- `"up_to_date"` - Current version matches latest
- `"update_available"` - Newer version exists
- `"ahead"` - Current version is newer than latest (fork scenario)
- `"unknown"` - Could not determine current version
- `"error"` - Failed to check (include `error` field)

---

## First-Time Detection Mode

When `.template.json` doesn't exist but VERSION does, include additional guidance:

```markdown
## Template Update Available

**Current version:** v0.2.0-alpha.5 *(from VERSION file)*
**Latest version:** v0.2.0-alpha.9

> **First-time setup:** You don't have a `.template.json` manifest yet.
> Running `/template:update` will create one and enable selective updates.

---

[changelog content...]

---

**To update:** Run `/template:update` to set up tracking and apply changes.
```

---

## Error Handling

### GitHub API Rate Limit

```markdown
## GitHub API Rate Limited

You've exceeded the GitHub API rate limit for unauthenticated requests.

**Rate limit resets at:** [time from X-RateLimit-Reset header]

**Options:**
1. Wait until the rate limit resets
2. Authenticate with a GitHub token for higher limits (coming in v2)

**Tip:** The rate limit is 60 requests/hour for unauthenticated users.
```

### Network Error

```markdown
## Network Error

Could not connect to GitHub: [error message]

Please check your internet connection and try again.
```

### Invalid Repository

```markdown
## Repository Not Found

Could not find repository: [repository]

**Possible causes:**
- Repository name is incorrect
- Repository is private (authentication not supported in v1)
- Repository was deleted or renamed

**To fix:** Update the `template.repository` field in `.template.json`.
```

---

## Related Commands

- `/template:update` - Apply available updates selectively
- `/system:release` - Create a new release of your project

## Related Files

- `.template.json` - Template manifest (created by /template:update)
- `VERSION` - Current version (fallback if no manifest)
- `.claude/scripts/template-fetch.ts` - GitHub API utilities
- `.claude/schemas/template-manifest.json` - Manifest schema
