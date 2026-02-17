---
description: Update project from upstream template with selective file updates and conflict resolution
argument-hint: '[all|harness|guides|selective] [--dry-run] [--verbose] [--force] [--version <tag>]'
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion, Task
---

# Template Update Command

Update your project with changes from the upstream template repository. Supports selective updates by component, preserves user additions, and provides Claude-guided conflict resolution.

## Arguments

Parse `$ARGUMENTS` for these options:

### Scope (mutually exclusive, default: interactive selection)

| Scope       | Description                                    |
| ----------- | ---------------------------------------------- |
| _(none)_    | Interactive scope selection                    |
| `all`       | Update everything (harness + guides + roadmap) |
| `harness`   | Update `.claude/` directory only               |
| `guides`    | Update `contributing/` only                          |
| `selective` | Choose individual files to update              |

### Flags

| Flag              | Effect                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `--dry-run`       | Show what would change without applying (no files written, no git operations, no manifest updates) |
| `--verbose`       | Show detailed diffs for each file, before/after for JSON, merge reasoning                          |
| `--force`         | Skip confirmation prompts                                                                          |
| `--version <tag>` | Update to specific version (default: latest)                                                       |

**Flag combinations:**

- `--dry-run` alone: Shows summary of planned changes
- `--verbose` alone: Shows diffs while making changes
- `--dry-run --verbose`: Shows detailed diffs without making any changes (safest preview)

### Examples

```bash
/template:update                              # Interactive scope selection
/template:update all                          # Update everything
/template:update harness                      # Update .claude/ only
/template:update guides                       # Update contributing/ only
/template:update selective                    # Choose individual files
/template:update --dry-run                    # Preview changes (no modifications)
/template:update --verbose                    # Show detailed diffs during update
/template:update --dry-run --verbose          # Full preview with diffs (safest)
/template:update --version v0.3.0             # Update to specific version
/template:update harness --verbose            # Show diffs for harness update
/template:update all --dry-run --verbose      # Preview all changes with full diffs
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MAIN CONTEXT (Orchestrator)              │
│                                                             │
│  Phase 1: Parse arguments, detect current version           │
│  Phase 2: Pre-flight checks (git status, branch)            │
│  Phase 3: Fetch target version, compare                     │
│  Phase 4: Scope selection (if not provided)                 │
│  Phase 5: Create backup branch                              │
│  Phase 6: Categorize files for update                       │
│  Phase 7: Execute updates by strategy                       │
│  Phase 8: Handle conflicts (gray zone)                      │
│  Phase 9: Update manifest, report results                   │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼ (for conflict resolution)
┌─────────────────────────────────────────────────────────────┐
│              SUBAGENT: Conflict Resolver                    │
│              (context-isolator)                             │
│                                                             │
│  - Perform 3-way diff analysis                              │
│  - Suggest merge resolutions                                │
│  - Handle CLAUDE.md marker-based updates                    │
└─────────────────────────────────────────────────────────────┘
```

---

## Flag Behavior Reference

### Dry-Run Mode (`--dry-run`)

When `--dry-run` is present, **NO changes are made to the filesystem or git**. All analysis and planning steps execute normally, but actions are simulated.

**What dry-run DOES:**

- Fetches and analyzes template files (read-only)
- Detects version differences
- Categorizes files by update strategy
- Calculates what would be updated/preserved/conflicted
- Displays comprehensive summary of planned changes

**What dry-run DOES NOT:**

- Create backup branches
- Write any files to disk
- Update `.template.json` manifest
- Create git commits
- Modify working directory in any way

**Output language in dry-run:**

- Use "Would update..." instead of "Updating..."
- Use "Would create..." instead of "Creating..."
- Use "Would remove..." instead of "Removing..."
- Use "Would preserve..." instead of "Preserving..."

### Verbose Mode (`--verbose`)

When `--verbose` is present, show detailed information about each operation.

**Verbose output includes:**

1. **File diffs** (unified diff format):

   ```diff
   --- a/.claude/commands/template/check.md
   +++ b/.claude/commands/template/check.md
   @@ -15,7 +15,9 @@
    existing line
   -old line to remove
   +new line added
   +another new line
    unchanged line
   ```

2. **JSON file changes** (before/after):

   ```
   [VERBOSE] JSON changes: package.json
   ─────────────────────────────────────
   dependencies:
     next: "16.0.0" → "16.1.0"
     @prisma/client: (unchanged)

   devDependencies:
     typescript: "5.8.0" → "5.9.0"
     + @types/node: "22.0.0" (added)
   ```

3. **Merge decision reasoning**:

   ```
   [VERBOSE] Merge analysis: CLAUDE.md
   ─────────────────────────────────────
   Strategy: Marker-based section replacement

   Sections to update:
   - technology-stack: Template changed, will replace
   - common-commands: No changes
   - directory-structure: Template changed, will replace

   Preserved user content:
   - Lines 1-50: User's project-specific intro
   - Lines 200-250: Custom "My Project Notes" section
   ```

4. **File metadata**:
   ```
   [VERBOSE] File: .claude/scripts/template-fetch.ts
   ─────────────────────────────────────
   Local:    2.4 KB, modified 2026-01-15
   Template: 3.1 KB, modified 2026-02-01
   Action:   Replace (+700 bytes)
   ```

### Combined Mode (`--dry-run --verbose`)

The safest preview mode. Shows exactly what would happen with full detail:

```
═══════════════════════════════════════════════════════════════════
  DRY RUN MODE - No changes will be made
═══════════════════════════════════════════════════════════════════

Analyzing update from v0.2.0-alpha.5 → v0.2.0-alpha.9...

───────────────────────────────────────────────────────────────────
  WOULD UPDATE: 5 files
───────────────────────────────────────────────────────────────────

[1/5] .claude/commands/template/check.md
[VERBOSE] Diff:
--- a/.claude/commands/template/check.md
+++ b/.claude/commands/template/check.md
@@ -10,6 +10,8 @@
 existing content
+new feature documentation
+additional examples

[2/5] .claude/scripts/template-fetch.ts
[VERBOSE] Diff:
--- a/.claude/scripts/template-fetch.ts
+++ b/.claude/scripts/template-fetch.ts
@@ -50,4 +50,12 @@
-old function
+improved function with better error handling
+async function newHelper() {
+  // ...
+}

... (remaining files)

───────────────────────────────────────────────────────────────────
  WOULD PRESERVE: 3 user additions (never touched)
───────────────────────────────────────────────────────────────────

- .claude/skills/my-custom-skill/SKILL.md
- .claude/agents/my-agent.md
- contributing/99-my-notes.md

───────────────────────────────────────────────────────────────────
  WOULD FLAG: 1 conflict for review
───────────────────────────────────────────────────────────────────

[VERBOSE] Conflict: package.json
─────────────────────────────────────
Reason: Both template and user modified since base version

Template wants:
  "next": "16.1.0"

User has:
  "next": "16.0.5"

Suggested resolution: Use template version (16.1.0)

═══════════════════════════════════════════════════════════════════
  DRY RUN SUMMARY
═══════════════════════════════════════════════════════════════════

| Action              | Count | Details                    |
|---------------------|-------|----------------------------|
| Would update        | 5     | Template files changed     |
| Would preserve      | 3     | User additions detected    |
| Would skip          | 8     | Unchanged files            |
| Would flag conflict | 1     | Needs manual review        |

To apply these changes, run:
  /template:update [scope]

To apply without prompts:
  /template:update [scope] --force
```

---

## Phase 1: Parse Arguments & Detect Version

### Step 1.1: Parse Arguments

Extract from `$ARGUMENTS`:

- **Scope**: `all`, `harness`, `guides`, `selective`, or none (interactive)
- **Flags**: `--dry-run`, `--verbose`, `--force`, `--version <tag>`

### Step 1.2: Detect Current Version

**Option A: Read from `.template.json` manifest**

```bash
cat .template.json 2>/dev/null
```

If exists, parse to extract:

- `template.repository` (e.g., "doriancollier/dorkian-next-stack")
- `template.version` (e.g., "v0.2.0-alpha.8")
- `template.commit` (SHA of current version)
- `userAdditions[]` (user-created files to preserve)

**Option B: Fall back to VERSION file**

```bash
cat VERSION 2>/dev/null
```

If VERSION exists but no `.template.json`:

- Version is the content of VERSION file (prepend "v" if not present)
- Repository defaults to "doriancollier/dorkian-next-stack"
- First-time mode: will create manifest after update

**Option C: No version info**

If neither file exists:

```markdown
## Cannot Update: No Version Information

Could not determine current template version:

- No `.template.json` manifest found
- No `VERSION` file found

**To initialize template tracking:**

1. Create a `VERSION` file with your current version (e.g., `0.2.0-alpha.8`)
2. Run `/template:update` again

Or run `/template:check` to verify your setup.
```

**STOP** if no version can be determined.

---

## Phase 2: Pre-flight Checks

### Step 2.1: Verify Git Status

```bash
git status --porcelain
```

If there are uncommitted changes:

```markdown
## Warning: Uncommitted Changes

You have uncommitted changes in the working directory:
[list files]

Template updates create a backup branch and modify files.
It's recommended to commit or stash changes first.
```

Use AskUserQuestion (unless `--force`):

- "Proceed anyway" - Continue with update
- "Stop and let me commit first" - Exit

### Step 2.2: Verify Git Branch

```bash
git branch --show-current
```

Note the current branch for backup naming.

### Step 2.3: Check Remote Connection

```bash
git remote -v
```

Verify `origin` remote exists for backup push.

---

## Phase 3: Fetch Target Version

### Step 3.1: Determine Target Version

If `--version <tag>` provided:

- Use specified tag as target

Otherwise:

- Fetch latest version from GitHub

```bash
npx tsx .claude/scripts/template-fetch.ts tags [repository]
```

Parse output to find latest semver tag.

### Step 3.2: Compare Versions

If current version equals target:

```markdown
## Already Up-to-Date

**Current version:** v0.2.0-alpha.9
**Target version:** v0.2.0-alpha.9

Your template is already at the target version. No updates needed.

To check for newer versions: `/template:check`
```

**STOP** if already at target version.

### Step 3.3: Fetch Changelog Preview

```bash
npx tsx .claude/scripts/template-fetch.ts changelog [repository] [current] [target]
```

Display changelog summary to inform user of what's changing:

```markdown
## Update Available

**Current version:** v0.2.0-alpha.5
**Target version:** v0.2.0-alpha.9

### Changes in this Update

[Changelog content between versions]

---

Proceeding to scope selection...
```

---

## Phase 4: Scope Selection

If scope not provided in arguments, prompt user:

Use AskUserQuestion:

```
header: "Update Scope"
question: "What would you like to update?"
options:
  - label: "All (Recommended)"
    description: "Update harness, guides, and roadmap system"
  - label: "Harness only"
    description: "Update .claude/ directory (commands, skills, agents, hooks)"
  - label: "Guides only"
    description: "Update contributing/ documentation"
  - label: "Selective"
    description: "Choose individual files or directories"
  - label: "Cancel"
    description: "Exit without making changes"
```

### For Selective Scope

If user chooses "Selective", fetch file tree and present categorized list:

```bash
npx tsx .claude/scripts/template-fetch.ts tree [repository] [target-version]
```

Filter to updateable files and present grouped by component:

```markdown
## Select Files to Update

### Harness (.claude/)

- [ ] .claude/commands/template/check.md
- [ ] .claude/scripts/template-fetch.ts
- [x] .claude/hooks/pre-tool-use/...
      ...

### Guides (contributing/)

- [ ] contributing/project-structure.md
- [ ] contributing/02-environment-variables.md
      ...

### Roadmap (roadmap/)

- [ ] roadmap/app/...
- [ ] roadmap/scripts/...
```

Use AskUserQuestion to confirm selection.

---

## Phase 5: Create Backup Branch

**IMPORTANT: Skip this phase entirely if `--dry-run` is present.**

If `--dry-run`:

```markdown
[DRY RUN] Would create backup branch: template-backup/[timestamp]
[DRY RUN] Skipping git operations...
```

Otherwise, before making any changes, create a backup branch:

```bash
# Generate backup branch name
BACKUP_BRANCH="template-backup/$(date +%Y%m%d-%H%M%S)"

# Create backup branch from current state
git checkout -b "$BACKUP_BRANCH"

# Return to original branch
git checkout -
```

Report (normal mode):

````markdown
## Backup Created

Branch `template-backup/20260202-143052` created.

If anything goes wrong, you can restore with:

```bash
git checkout template-backup/20260202-143052
```
````

Proceeding with update...

````

---

## Phase 6: Categorize Files

### Step 6.1: Fetch Template File Tree

```bash
npx tsx .claude/scripts/template-fetch.ts tree [repository] [target-version]
````

### Step 6.2: List Local Files

```bash
find .claude -type f 2>/dev/null
find developer-guides -type f 2>/dev/null
find roadmap -type f 2>/dev/null
```

### Step 6.3: Detect User Additions

Files that exist locally but NOT in template repository = user additions.

Algorithm:

```
1. Get template files at target version
2. Get local files in component directories
3. Local files NOT in template = user additions
4. Store in manifest.userAdditions[]
5. These files are NEVER touched during updates
```

### Step 6.4: Categorize by Strategy

| Category               | Files                                                     | Strategy                          |
| ---------------------- | --------------------------------------------------------- | --------------------------------- |
| **Harness Core**       | `.claude/hooks/`, `.claude/scripts/`                      | Replace                           |
| **Harness Extensible** | `.claude/commands/`, `.claude/skills/`, `.claude/agents/` | Replace (preserve user additions) |
| **Guides**             | `contributing/*.md`                                             | Replace                           |
| **Roadmap System**     | `roadmap/*.ts`, `roadmap/scripts/`                        | Replace                           |
| **Roadmap Data**       | `roadmap/roadmap.json`                                    | Skip (user data)                  |
| **Gray Zone**          | `CLAUDE.md`, `package.json`                               | Merge (Phase 8)                   |
| **User Space**         | `src/**`, `public/**`, `prisma/schema.prisma`             | Never touch                       |
| **User Additions**     | Files not in template                                     | Never touch                       |

### Step 6.5: Present Categorization

**If `--verbose` is present**, show detailed categorization with file metadata:

```markdown
## File Categorization

### Will Replace (12 files)

- .claude/commands/template/check.md
- .claude/scripts/template-fetch.ts
- contributing/project-structure.md
  ...

### Will Merge (2 files)

- CLAUDE.md (template sections only)
- package.json (template dependencies)

### Will Skip - User Additions (3 files)

- .claude/skills/my-custom-skill/
- .claude/commands/my-command.md
- contributing/99-my-notes.md

### Will Skip - User Space

- src/\*\* (always excluded)
- public/\*\* (always excluded)
```

---

## Phase 7: Execute Updates

### Step 7.1: Apply Replace Strategy

For files categorized as "Replace":

```bash
# Fetch file content from template
npx tsx .claude/scripts/template-fetch.ts file [repository] [path] [target-version]
```

**Normal mode** (no `--dry-run`):

For each file:

1. Fetch template version content
2. Read local file content (for comparison/diff)
3. If `--verbose`: Display unified diff before writing
4. Write to local path (overwrite)
5. Track in update report

**Verbose output format** (when `--verbose` and NOT `--dry-run`):

```
Updating [1/12]: .claude/commands/template/check.md
[VERBOSE] Diff:
────────────────────────────────────────────────────
--- local
+++ template
@@ -10,6 +10,8 @@
 existing content
+new feature documentation
+additional examples
────────────────────────────────────────────────────
✓ Updated .claude/commands/template/check.md
```

**Dry-run mode** (`--dry-run` present):

For each file:

1. Fetch template version content (read-only)
2. Read local file content
3. Compare contents
4. If different:
   - Report: "Would update: [path]"
   - If `--verbose`: Display unified diff
5. If same:
   - Report: "Would skip (unchanged): [path]"
6. **DO NOT write any files**

**Dry-run output format**:

```
[DRY RUN] Would update [1/12]: .claude/commands/template/check.md
```

**Dry-run + verbose output format**:

```
[DRY RUN] Would update [1/12]: .claude/commands/template/check.md
[VERBOSE] Diff (proposed changes):
────────────────────────────────────────────────────
--- local (current)
+++ template (proposed)
@@ -10,6 +10,8 @@
 existing content
+new feature documentation
+additional examples
────────────────────────────────────────────────────
```

### Step 7.2: Generate Diffs

When `--verbose` is present (in either mode), generate human-readable diffs:

**For text files** (unified diff format):

```bash
# Conceptually (Claude generates this output, not a real command):
diff -u local_content template_content
```

Display with:

- File path header
- Line numbers and context
- `-` prefix for removed lines (red if terminal supports)
- `+` prefix for added lines (green if terminal supports)

**For JSON files** (structured comparison):

```
[VERBOSE] JSON changes: package.json
────────────────────────────────────────────────────
dependencies:
  next:           "16.0.0" → "16.1.0"    (changed)
  react:          "19.0.0"               (unchanged)
  + lodash-es:    "4.17.21"              (added by template)

devDependencies:
  typescript:     "5.8.0" → "5.9.0"      (changed)
  - old-package:  (removed by template)
────────────────────────────────────────────────────
```

### Step 7.3: Track Statistics

Maintain counters:

- `filesUpdated` - Successfully replaced (or "would replace" in dry-run)
- `filesSkipped` - User additions, excluded
- `filesUnchanged` - Template matches local (no update needed)
- `conflicts` - Sent to merge resolution

---

## Phase 8: Handle Gray Zone (Conflicts)

**IMPORTANT: In `--dry-run` mode, show what merge WOULD produce without writing files.**

### CLAUDE.md Marker-Based Update

Template sections in CLAUDE.md are wrapped with markers:

```markdown
<!-- template-section-start: technology-stack -->

## Technology Stack

...

<!-- template-section-end: technology-stack -->
```

Update behavior:

1. Parse local CLAUDE.md for markers
2. Fetch template CLAUDE.md
3. For each template section:
   - If markers exist locally: replace content between markers
   - If markers don't exist: append section at end with notification
4. Content OUTSIDE markers: never touch (user-owned)

**Verbose output for CLAUDE.md** (when `--verbose`):

```
[VERBOSE] Merge analysis: CLAUDE.md
────────────────────────────────────────────────────
Strategy: Marker-based section replacement

Template sections found:
- technology-stack (lines 45-120)
- common-commands (lines 125-180)
- directory-structure (lines 185-250)

Actions:
- technology-stack: REPLACE (template has changes)
  [VERBOSE DIFF]
  --- local section
  +++ template section
  @@ -5,3 +5,5 @@
   | Next.js | 16.0.0 | React framework |
  -| TypeScript | 5.8.0 | Type safety |
  +| TypeScript | 5.9.0 | Type safety |
  +| Tailwind CSS | 4.1 | Styling |

- common-commands: SKIP (no changes)
- directory-structure: REPLACE (template has changes)

User content preserved:
- Lines 1-44: Project introduction (user-owned)
- Lines 300-400: Custom "My Project Notes" section
────────────────────────────────────────────────────
```

**Dry-run + verbose for CLAUDE.md**:

```
[DRY RUN] Would merge: CLAUDE.md
[VERBOSE] Merge preview:
────────────────────────────────────────────────────
Would update 2 template sections:
- technology-stack: +2 lines, -1 line
- directory-structure: +5 lines

Would preserve all user content outside markers.
────────────────────────────────────────────────────
```

### package.json Dependency Merge

For package.json (if in scope):

1. Fetch template package.json
2. Merge template dependencies with local:
   - Template deps override if version differs
   - User-added deps preserved
3. Preserve user scripts, name, etc.

**Verbose output for package.json** (when `--verbose`):

```
[VERBOSE] Merge analysis: package.json
────────────────────────────────────────────────────
Strategy: Dependency merge (preserve user additions)

dependencies:
  next:        "16.0.0" → "16.1.0"    (template update)
  react:       "19.0.0"               (no change)
  my-lib:      "1.0.0"                (user addition, preserved)

devDependencies:
  typescript:  "5.8.0" → "5.9.0"      (template update)
  vitest:      "3.0.0"                (no change)
  + @types/lodash-es: "4.17.12"       (added by template)

scripts:
  (all user scripts preserved)

User-added fields preserved:
  - name: "my-project"
  - description: "My custom project"
  - author, license, repository, etc.
────────────────────────────────────────────────────
```

**Dry-run + verbose for package.json**:

```
[DRY RUN] Would merge: package.json
[VERBOSE] Proposed changes:
────────────────────────────────────────────────────
Dependencies to update:
  next:       "16.0.0" → "16.1.0"
  typescript: "5.8.0" → "5.9.0"

Dependencies to add:
  @types/lodash-es: "4.17.12"

User additions preserved:
  my-lib: "1.0.0"

No files will be modified (dry run).
────────────────────────────────────────────────────
```

### Three-Way Diff for Other Gray Zone Files

For files that need merging:

```
Base:    Template file at user's current version
Theirs:  Template file at target version
Ours:    User's local file

If Base == Ours:
  → User hasn't modified, safe to replace with Theirs
If Base == Theirs:
  → Template hasn't changed, keep Ours
If all different:
  → Conflict, invoke Claude-guided merge
```

### Claude-Guided Conflict Resolution

When `threeWayDiff()` returns `action: 'conflict'` (reason: 'both-modified'), invoke interactive conflict resolution.

**IMPORTANT: In `--dry-run` mode, show what conflicts WOULD require resolution without applying any changes.**

#### Step 1: Display Conflict Context

For each conflict, display a comprehensive context block:

```markdown
═══════════════════════════════════════════════════════════════════
CONFLICT: [file path]
═══════════════════════════════════════════════════════════════════

**Base Version**: Template v[baseRef] (your starting point)
**Your Current Version**: Local file
**Target Version**: Template v[targetRef]

───────────────────────────────────────────────────────────────────
WHAT YOU CHANGED (compared to base template)
───────────────────────────────────────────────────────────────────

[Generate unified diff between base and ours]

--- base (template v[baseRef])
+++ yours (local)
@@ -line,count +line,count @@
context line
-removed by you
+added by you
context line

───────────────────────────────────────────────────────────────────
WHAT TEMPLATE CHANGED (from v[baseRef] to v[targetRef])
───────────────────────────────────────────────────────────────────

[Generate unified diff between base and theirs]

--- base (template v[baseRef])
+++ template (v[targetRef])
@@ -line,count +line,count @@
context line
-old template line
+new template line
context line

───────────────────────────────────────────────────────────────────
ANALYSIS & RECOMMENDATION
───────────────────────────────────────────────────────────────────

[Provide recommendation based on analysis - see recommendation logic below]
```

#### Step 2: Analyze Changes for Recommendation

Analyze the conflict to determine the best recommendation:

**Change Classification:**

| Factor                                             | Classification           | Recommendation                            |
| -------------------------------------------------- | ------------------------ | ----------------------------------------- |
| User changes < 10 lines, non-overlapping sections  | Minor customization      | Merge: Apply user changes to new template |
| User changes > 10 lines or structural              | Significant modification | Keep yours: Highlight template additions  |
| Changes in different file sections                 | Non-overlapping          | Merge automatically (safe)                |
| Changes overlap on same lines                      | True conflict            | Show both, ask user                       |
| Template removed section user modified             | Deprecation conflict     | Keep yours: Add deprecation note          |
| User added new content, template updated elsewhere | Additive                 | Merge: User additions + template updates  |
| Template refactored file structure                 | Structural change        | Manual review recommended                 |

**Recommendation Logic Implementation:**

```typescript
// Pseudo-code for recommendation logic
function getRecommendation(base: string, ours: string, theirs: string): Recommendation {
  const userChanges = diffLines(base, ours);
  const templateChanges = diffLines(base, theirs);

  // Count meaningful changes (excluding whitespace)
  const userLineChanges = userChanges.filter((c) => c.type !== 'unchanged');
  const templateLineChanges = templateChanges.filter((c) => c.type !== 'unchanged');

  // Check for overlap
  const userChangedLines = new Set(userLineChanges.map((c) => c.lineNumber));
  const templateChangedLines = new Set(templateLineChanges.map((c) => c.lineNumber));
  const overlappingLines = intersection(userChangedLines, templateChangedLines);

  if (overlappingLines.size === 0) {
    // Non-overlapping changes - safe to auto-merge
    return {
      action: 'merge',
      reason: 'Changes are in different sections of the file',
      confidence: 'high',
    };
  }

  if (userLineChanges.length < 10 && overlappingLines.size < 5) {
    // Minor user customization with small overlap
    return {
      action: 'merge',
      reason: 'User changes are minor and can be applied to new template',
      confidence: 'medium',
    };
  }

  if (userLineChanges.length > 10) {
    // Significant user modification
    return {
      action: 'keep-yours',
      reason: 'Significant user modifications - review template changes manually',
      confidence: 'medium',
    };
  }

  // True conflict - cannot auto-resolve
  return {
    action: 'ask-user',
    reason: 'Both sides made overlapping changes',
    confidence: 'low',
  };
}
```

#### Step 3: Present Resolution Options

Use AskUserQuestion to present resolution options:

```
header: "Resolve Conflict: [file path]"
question: "[Recommendation text based on analysis]"
options:
  - label: "1. Merge (Recommended)"
    description: "Combine your changes with template updates"
  - label: "2. Keep yours"
    description: "Ignore template changes, keep your current version"
  - label: "3. Use template"
    description: "Replace with template version (your changes will be lost)"
  - label: "4. Edit manually"
    description: "View both versions side-by-side for manual editing"
  - label: "5. Skip for now"
    description: "Decide later, continue with other files"
```

**For each option, show a preview:**

**Option 1 - Merge Preview:**

```markdown
[PREVIEW] Merged result:
────────────────────────────────────────────────────
[Show the intelligently merged content]
────────────────────────────────────────────────────

Changes applied:

- Your modifications in lines X-Y: Preserved
- Template updates in lines A-B: Applied
- Auto-resolved: [count] non-overlapping changes
```

**Option 2 - Keep Yours Preview:**

```markdown
[PREVIEW] Your version (no changes)
────────────────────────────────────────────────────
Note: The following template improvements will NOT be applied:

- [List template changes that would be skipped]
  ────────────────────────────────────────────────────
```

**Option 3 - Use Template Preview:**

```markdown
[PREVIEW] Template version
────────────────────────────────────────────────────
⚠️ WARNING: Your changes will be lost:

- [List user changes that would be overwritten]
  ────────────────────────────────────────────────────
```

**Option 4 - Manual Edit:**

```markdown
Opening file for manual editing...

YOUR VERSION:
════════════════════════════════════════════════════
[Full content of ours]
════════════════════════════════════════════════════

TEMPLATE VERSION:
════════════════════════════════════════════════════
[Full content of theirs]
════════════════════════════════════════════════════

Edit the file to combine changes, then confirm when done.
```

**Option 5 - Skip:**

```markdown
Skipping [file path] for now.
This file will remain unchanged and be noted in the summary.
You can manually update it later.
```

#### Step 4: Apply Resolution

Based on user choice, apply the resolution:

**For "Merge":**

1. Generate merged content using intelligent diff algorithm
2. For non-overlapping changes: Apply both automatically
3. For overlapping changes: Use template version with user additions preserved where possible
4. Write merged content to file (unless `--dry-run`)
5. Track: `{ file, resolution: 'merged', reason: 'User selected merge' }`

**For "Keep yours":**

1. Do not modify the file
2. Track: `{ file, resolution: 'kept-user', reason: 'User chose to keep their version' }`

**For "Use template":**

1. Write template content to file (unless `--dry-run`)
2. Track: `{ file, resolution: 'used-template', reason: 'User chose template version' }`

**For "Edit manually":**

1. Display both versions for reference
2. Use AskUserQuestion to confirm when editing is complete
3. Read the file again to verify changes
4. Track: `{ file, resolution: 'manual', reason: 'User manually edited' }`

**For "Skip":**

1. Do not modify the file
2. Track: `{ file, resolution: 'skipped', reason: 'User deferred decision' }`

#### Step 5: Resolution Tracking

Maintain a list of conflict resolutions throughout the update:

```typescript
interface ConflictResolution {
  file: string;
  resolution: 'merged' | 'kept-user' | 'used-template' | 'manual' | 'skipped';
  reason: string;
  templateChanges?: string[]; // What template changed (for record)
  userChanges?: string[]; // What user changed (for record)
}

// Track all resolutions
const resolutions: ConflictResolution[] = [];
```

#### Special Case: CLAUDE.md Conflicts

For CLAUDE.md files with marker sections, use a hybrid approach:

1. **Parse markers** using `parseMarkerSections()` from template-fetch.ts
2. **Identify section-level conflicts:**
   - Template section changed AND user modified same section
   - User added content within a template section

3. **Per-section resolution:**

   ```markdown
   CLAUDE.md Conflict - Section: [section-name]

   This template section was modified by both you and the template.

   Your changes to this section:
   [Show user changes within section]

   Template changes to this section:
   [Show template changes to section]

   Choose resolution for this section:

   1. Use template section (recommended if template has important updates)
   2. Keep your section
   3. Merge (template base + your additions)
   ```

4. **Non-conflicting sections:** Update automatically using `updateClaudeMdMarkers()`

5. **User content outside markers:** Always preserved (never touched)

#### Special Case: package.json Conflicts

For package.json dependency version conflicts (when `mergePackageJson()` returns conflicts):

```markdown
package.json Dependency Conflict
═══════════════════════════════════════════════════════════════════

The following dependencies have conflicting versions:

| Package | Your Version | Template Version | Base Version |
| ------- | ------------ | ---------------- | ------------ |
| next    | 16.0.5       | 16.1.0           | 16.0.0       |
| prisma  | 6.5.0        | 7.0.0            | 6.0.0        |

For each conflict, choose:

1. Use template version (recommended for security updates)
2. Keep your version
3. Specify a different version

───────────────────────────────────────────────────────────────────
```

Use AskUserQuestion for each conflicting dependency, or offer batch options:

- "Use all template versions"
- "Keep all your versions"
- "Resolve each individually"

#### Dry-Run Mode for Conflicts

When `--dry-run` is present:

1. **Show all conflicts** that would require resolution
2. **Display recommendations** for each conflict
3. **Do NOT prompt for resolution** (no AskUserQuestion)
4. **Summarize** the conflicts in the dry-run report:

```markdown
───────────────────────────────────────────────────────────────────
CONFLICTS REQUIRING RESOLUTION (3 files)
───────────────────────────────────────────────────────────────────

[1/3] .claude/commands/my-command.md
Both you and the template modified this file.
Recommended: Merge (changes are in different sections)

[2/3] CLAUDE.md
2 template sections have conflicting changes: - technology-stack: You added custom entries - common-commands: Both modified
Recommended: Per-section resolution needed

[3/3] package.json
2 dependency version conflicts: - next: 16.0.5 (yours) vs 16.1.0 (template) - prisma: 6.5.0 (yours) vs 7.0.0 (template)
Recommended: Use template versions (security updates)

To resolve these conflicts, run without --dry-run:
/template:update [scope]
```

#### Conflict Resolution Summary

After all conflicts are resolved, display a summary:

```markdown
───────────────────────────────────────────────────────────────────
CONFLICT RESOLUTION SUMMARY
───────────────────────────────────────────────────────────────────

| File                           | Resolution    | Action Taken                        |
| ------------------------------ | ------------- | ----------------------------------- |
| .claude/commands/my-command.md | Merged        | Combined your changes with template |
| CLAUDE.md                      | Mixed         | 2 sections updated, 1 kept yours    |
| package.json                   | Used template | Updated to latest versions          |
| .claude/skills/custom/SKILL.md | Skipped       | Deferred for later                  |

Conflicts resolved: 3
Conflicts skipped: 1 (will need manual attention)
```

#### Error Handling for Conflicts

**If merge fails:**

```markdown
⚠️ Merge Error

The automatic merge for [file] failed:
[error details]

Falling back to manual options:

1. Keep your version (safest)
2. Use template version
3. Try manual edit
```

**If file cannot be read:**

```markdown
⚠️ File Read Error

Cannot read [file]: [error message]

This file will be skipped. Please check file permissions and try again.
```

**If user cancels resolution:**
Track as skipped and continue with remaining files. Don't abort the entire update.

---

## Phase 9: Finalize Update

**IMPORTANT: Skip manifest update and commit steps if `--dry-run` is present.**

### Step 9.1: Update Manifest

**If `--dry-run`**: Skip this step entirely. Show:

```
[DRY RUN] Would update .template.json with new version info
[DRY RUN] Skipping manifest update...
```

**Otherwise**, create or update `.template.json`:

```json
{
  "template": {
    "repository": "doriancollier/dorkian-next-stack",
    "version": "v0.2.0-alpha.9",
    "commit": "[sha from tag]",
    "initialVersion": "v0.2.0-alpha.5",
    "lastUpdated": "2026-02-02T14:30:00Z"
  },
  "components": {
    "harness": {
      "path": ".claude/",
      "strategy": "replace",
      "preserveUserAdditions": true
    },
    "guides": {
      "path": "contributing/",
      "strategy": "replace"
    },
    "roadmap": {
      "path": "roadmap/",
      "strategy": "replace",
      "exclude": ["roadmap.json"]
    }
  },
  "skipPatterns": ["src/**", "public/**", "prisma/schema.prisma", ".env*"],
  "userAdditions": [".claude/skills/my-custom-skill/", ".claude/commands/my-command.md"],
  "updateHistory": [
    {
      "from": "v0.2.0-alpha.5",
      "to": "v0.2.0-alpha.9",
      "date": "2026-02-02T14:30:00Z",
      "filesUpdated": 12,
      "filesSkipped": 3,
      "conflicts": 0
    }
  ]
}
```

### Step 9.2: Commit Changes (Optional)

**If `--dry-run`**: Skip this step entirely. Do not offer to commit.

**Otherwise**, offer to commit:

Use AskUserQuestion:

```
header: "Commit Changes"
question: "Commit the template update?"
options:
  - label: "Yes, commit now"
    description: "Creates a commit with all template changes"
  - label: "No, I'll commit later"
    description: "Leave changes staged for manual review"
```

If yes:

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: update from template v[old] to v[new]

Updated components:
- Harness: [count] files
- Guides: [count] files

User additions preserved: [count] files

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

### Step 9.3: Report Results

````markdown
## Template Update Complete

**Previous version:** v0.2.0-alpha.5
**New version:** v0.2.0-alpha.9
**Backup branch:** template-backup/20260202-143052

### Summary

| Category                 | Count |
| ------------------------ | ----- |
| Files updated            | 12    |
| Files unchanged          | 5     |
| User additions preserved | 3     |
| Conflicts resolved       | 0     |

### Updated Components

**Harness (.claude/)**

- commands/template/check.md
- scripts/template-fetch.ts
- hooks/pre-tool-use/...

**Guides (contributing/)**

- 01-project-structure.md
- 02-environment-variables.md

### User Additions Preserved

These files were detected as user-created and not modified:

- .claude/skills/my-custom-skill/
- .claude/commands/my-command.md

### Next Steps

1. Review changes: `git diff HEAD~1`
2. Test your project: `pnpm dev`
3. Check for breaking changes in the changelog

If something went wrong, restore from backup:

```bash
git checkout template-backup/20260202-143052
```
````

````

---

## Dry Run Mode Summary

When `--dry-run` is present, the command operates in **read-only simulation mode**.

### Behavior by Phase

| Phase | Normal Mode | Dry-Run Mode |
|-------|-------------|--------------|
| Phase 1: Parse & Detect | Runs normally | Runs normally |
| Phase 2: Pre-flight | Checks git status | Checks git status (warnings still shown) |
| Phase 3: Fetch Version | Fetches from GitHub | Fetches from GitHub (read-only) |
| Phase 4: Scope Selection | Interactive prompt | Interactive prompt |
| Phase 5: Backup Branch | **Creates branch** | **SKIPPED** - shows what would be created |
| Phase 6: Categorize | Analyzes files | Analyzes files |
| Phase 7: Execute Updates | **Writes files** | **SKIPPED** - shows what would change |
| Phase 8: Merge Conflicts | **Resolves & writes** | **SKIPPED** - shows proposed merges |
| Phase 9: Finalize | **Updates manifest, commits** | **SKIPPED** - shows summary only |

### Dry-Run Output Template

```markdown
═══════════════════════════════════════════════════════════════════
  DRY RUN COMPLETE - No changes were made
═══════════════════════════════════════════════════════════════════

**Would update from:** v0.2.0-alpha.5
**Would update to:** v0.2.0-alpha.9

───────────────────────────────────────────────────────────────────
  FILES THAT WOULD BE UPDATED (12)
───────────────────────────────────────────────────────────────────

.claude/commands/template/check.md
.claude/commands/template/update.md
.claude/scripts/template-fetch.ts
.claude/hooks/pre-tool-use/check-any.md
contributing/project-structure.md
contributing/02-environment-variables.md
contributing/03-database-prisma.md
... (5 more files)

───────────────────────────────────────────────────────────────────
  FILES THAT WOULD BE MERGED (2)
───────────────────────────────────────────────────────────────────

CLAUDE.md - Marker-based section update (3 sections)
package.json - Dependency merge (2 deps updated, 1 added)

───────────────────────────────────────────────────────────────────
  USER ADDITIONS PRESERVED (3)
───────────────────────────────────────────────────────────────────

.claude/skills/my-custom-skill/SKILL.md
.claude/agents/my-agent.md
contributing/99-my-notes.md

───────────────────────────────────────────────────────────────────
  SUMMARY
───────────────────────────────────────────────────────────────────

| Action              | Count |
|---------------------|-------|
| Would update        | 12    |
| Would merge         | 2     |
| Would preserve      | 3     |
| Would skip          | 8     |
| Conflicts           | 0     |

───────────────────────────────────────────────────────────────────

To apply these changes:
  /template:update [scope]

To apply without prompts:
  /template:update [scope] --force
````

### Dry-Run + Verbose Output

When both `--dry-run` and `--verbose` are present, include detailed diffs inline:

```markdown
═══════════════════════════════════════════════════════════════════
DRY RUN COMPLETE - No changes were made (verbose)
═══════════════════════════════════════════════════════════════════

**Would update from:** v0.2.0-alpha.5
**Would update to:** v0.2.0-alpha.9

───────────────────────────────────────────────────────────────────
FILES THAT WOULD BE UPDATED (12)
───────────────────────────────────────────────────────────────────

[1/12] .claude/commands/template/check.md

[VERBOSE] Diff:
--- local (current)
+++ template (proposed)
@@ -10,6 +10,10 @@

## Check for Updates

+### New Feature

- +This section was added in the template.
- Run `/template:check` to see available updates.

────────────────────────────────────────────────────

[2/12] .claude/scripts/template-fetch.ts

[VERBOSE] Diff:
--- local (current)
+++ template (proposed)
@@ -45,8 +45,12 @@
async function fetchTags(repo: string) {

- const response = await fetch(`${API}/repos/${repo}/tags`)

* const response = await fetch(`${API}/repos/${repo}/tags`, {
* headers: getHeaders(),
* })
  return response.json()
  }
* +function getHeaders() {
* // ... new helper function
  +}

────────────────────────────────────────────────────

... (remaining files with diffs)

───────────────────────────────────────────────────────────────────
FILES THAT WOULD BE MERGED (2)
───────────────────────────────────────────────────────────────────

[1/2] CLAUDE.md

[VERBOSE] Merge preview:
Strategy: Marker-based section replacement

Sections to update:

- technology-stack (+5 lines)
- directory-structure (+12 lines)

User content preserved:

- Lines 1-50: Project introduction
- Lines 400-500: Custom notes section

────────────────────────────────────────────────────

[2/2] package.json

[VERBOSE] JSON changes:
dependencies:
next: "16.0.0" → "16.1.0"

devDependencies:
typescript: "5.8.0" → "5.9.0"

- @types/node: "22.0.0" (added)

────────────────────────────────────────────────────

... (rest of summary)
```

### Safety Guarantees

**In dry-run mode, Claude MUST NOT:**

1. **Call Write tool** - No file writes allowed
2. **Call Edit tool** - No file modifications allowed
3. **Run git checkout** - No branch creation
4. **Run git commit** - No commits
5. **Run git add** - No staging
6. **Modify .template.json** - No manifest updates

**These guarantees are absolute** - dry-run is a safety feature for previewing changes before committing to them.

---

## Error Handling

### GitHub API Rate Limit

```markdown
## GitHub API Rate Limited

You've exceeded the GitHub API rate limit for unauthenticated requests.

**Rate limit resets at:** [time]

Options:

1. Wait until the rate limit resets
2. Try again later

**Tip:** The rate limit is 60 requests/hour for unauthenticated users.
```

### Network Error

```markdown
## Network Error

Could not connect to GitHub: [error message]

Please check your internet connection and try again.
```

### File Write Error

````markdown
## File Write Error

Could not write to: [path]
Error: [message]

Your backup branch is safe at: template-backup/[timestamp]

To restore:

```bash
git checkout template-backup/[timestamp]
```
````

````

### Invalid Manifest

```markdown
## Invalid Manifest

The `.template.json` file is malformed:
[validation errors]

To fix:
1. Delete `.template.json`
2. Run `/template:update` to regenerate

Or manually fix the JSON syntax errors.
````

---

## Related Commands

- `/template:check` - Check for available updates without applying
- `/git:commit` - Commit changes after update
- `/system:release` - Create a release after updating

## Related Files

- `.template.json` - Template manifest (created/updated by this command)
- `VERSION` - Current version (fallback if no manifest)
- `.claude/scripts/template-fetch.ts` - GitHub API utilities
- `.claude/schemas/template-manifest.json` - Manifest schema
