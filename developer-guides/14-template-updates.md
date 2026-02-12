# Template Updates

## Overview

The template update system allows projects that cloned the Next.js starter template to selectively update with newer template versions. It follows a "hybrid manifest + file comparison" approach, combining version tracking via a manifest file with GitHub-based file fetching and Claude-guided merge for conflicts.

**Key capabilities:**

- Selective updates by component (harness, guides, all)
- Automatic detection and preservation of user-created files
- Three-way diff for intelligent conflict detection
- Marker-based updates for `CLAUDE.md` template sections
- Dependency merging for `package.json`
- Backup branch creation before any changes
- Dry-run mode for safe previews

## Key Files

| Concept | Location |
|---------|----------|
| Commands | `.claude/commands/template/check.md`, `.claude/commands/template/update.md` |
| Fetch utilities | `.claude/scripts/template-fetch.ts` |
| Manifest schema | `.claude/schemas/template-manifest.json` |
| Project manifest | `.template.json` (created on first update) |
| Version fallback | `VERSION` file |

## Quick Reference

| Command | Purpose |
|---------|---------|
| `/template:check` | Check for available updates, show changelog |
| `/template:check --json` | Output update status as JSON for scripting |
| `/template:update` | Interactive update with scope selection |
| `/template:update all` | Update everything (harness + guides + roadmap) |
| `/template:update harness` | Update `.claude/` directory only |
| `/template:update guides` | Update `developer-guides/` only |
| `/template:update selective` | Choose individual files to update |
| `/template:update --dry-run` | Preview changes without applying |
| `/template:update --verbose` | Show detailed diffs during update |
| `/template:update --dry-run --verbose` | Full preview with diffs (safest) |
| `/template:update --version v0.3.0` | Update to specific version |

## When to Use What

| Scenario | Command | Why |
|----------|---------|-----|
| Check if updates exist | `/template:check` | Quick status without changes |
| Preview before updating | `/template:update --dry-run` | See what would change |
| Full detailed preview | `/template:update --dry-run --verbose` | See all diffs before committing |
| Update all template files | `/template:update all` | Comprehensive update |
| Update commands/skills only | `/template:update harness` | Keep guides unchanged |
| Update documentation only | `/template:update guides` | Keep harness unchanged |
| Cherry-pick specific files | `/template:update selective` | Maximum control |
| Automate in CI/scripts | `/template:check --json` | Machine-readable output |

## How It Works

### Version Tracking

The system tracks template versions using `.template.json`:

```json
{
  "template": {
    "repository": "doriancollier/dorkian-next-stack",
    "version": "v0.2.0-alpha.9",
    "commit": "abc123...",
    "initialVersion": "v0.2.0-alpha.5",
    "lastUpdated": "2026-02-02T14:30:00Z"
  },
  "userAdditions": [
    ".claude/skills/my-custom-skill/",
    ".claude/commands/my-command.md"
  ],
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

If `.template.json` doesn't exist, the system falls back to the `VERSION` file and creates the manifest on first update.

### File Categories

| Category | Examples | Update Strategy |
|----------|----------|-----------------|
| **Harness Core** | `.claude/hooks/`, `.claude/scripts/` | Always replace |
| **Harness Extensible** | `.claude/commands/`, `.claude/skills/`, `.claude/agents/` | Replace (preserve user additions) |
| **Guides** | `developer-guides/*.md` | Always replace |
| **Roadmap System** | `roadmap/*.ts`, `roadmap/scripts/` | Replace |
| **Roadmap Data** | `roadmap/roadmap.json` | Never touch (user data) |
| **Gray Zone** | `CLAUDE.md`, `package.json` | Merge with guidance |
| **User Space** | `src/**`, `public/**`, `prisma/schema.prisma` | Never touch |
| **User Additions** | Files not in template | Auto-detected, never touched |

### Three-Way Merge

For files that may have user modifications, the system uses three-way diff:

```
Base:    Template at user's current version (from GitHub)
Theirs:  Template at target version (from GitHub)
Ours:    User's local file

Decision logic:
- If Base == Ours → User hasn't modified → safe to replace with Theirs
- If Base == Theirs → Template hasn't changed → keep Ours
- If all different → Conflict → Claude-guided resolution
```

## User Additions

User-created files are automatically detected and preserved:

**Detection algorithm:**

1. Fetch file list from template at current version
2. List local files in component directories
3. Files in local but NOT in template = user additions
4. Store in `manifest.userAdditions[]`
5. These files are NEVER touched during updates

**Example output:**

```markdown
### User Additions Preserved

These files were detected as user-created and not modified:
- .claude/skills/my-custom-skill/SKILL.md
- .claude/agents/my-agent.md
- developer-guides/99-my-notes.md
```

## Gray Zone Handling

### CLAUDE.md (Marker-Based Updates)

Template sections in `CLAUDE.md` are wrapped with markers:

```markdown
<!-- template-section-start: technology-stack -->
## Technology Stack
...content...
<!-- template-section-end: technology-stack -->
```

**Update behavior:**

- Content between matching markers: replaced with template version
- Content outside markers: never touched (user-owned)
- New template sections: appended at end with notification
- Removed template sections: left in place with deprecation comment

**Verbose output example:**

```
[VERBOSE] Merge analysis: CLAUDE.md
────────────────────────────────────────────────────
Strategy: Marker-based section replacement

Sections to update:
  - technology-stack: REPLACE (template has changes)
  - directory-structure: REPLACE (template has changes)
  - common-commands: SKIP (no changes)

User content preserved:
  - Lines 1-50: Project introduction (user-owned)
  - Lines 400-500: Custom notes section
────────────────────────────────────────────────────
```

### package.json (Dependency Merge)

For `package.json`, the system merges dependencies intelligently:

**Merge rules:**

- Template dependencies override if version differs
- User-added dependencies are preserved
- User scripts, name, description, etc. are preserved
- New template dependencies are added

**Verbose output example:**

```
[VERBOSE] JSON changes: package.json
────────────────────────────────────────────────────
dependencies:
  next:           "16.0.0" → "16.1.0"    (template update)
  react:          "19.0.0"               (no change)
  my-lib:         "1.0.0"                (user addition, preserved)

devDependencies:
  typescript:     "5.8.0" → "5.9.0"      (template update)
  + @types/node:  "22.0.0"               (added by template)
────────────────────────────────────────────────────
```

## Conflict Resolution

When both user and template modified the same file, Claude provides guided resolution:

**Resolution options:**

1. **Merge (Recommended)** - Combine your changes with template updates
2. **Keep yours** - Ignore template changes, keep your current version
3. **Use template** - Replace with template version (your changes will be lost)
4. **Edit manually** - View both versions side-by-side for manual editing
5. **Skip for now** - Decide later, continue with other files

**Conflict display:**

```markdown
═══════════════════════════════════════════════════════════════════
CONFLICT: .claude/commands/my-command.md
═══════════════════════════════════════════════════════════════════

WHAT YOU CHANGED (compared to base template)
───────────────────────────────────────────────────────────────────
[unified diff of your changes]

WHAT TEMPLATE CHANGED (from base to target)
───────────────────────────────────────────────────────────────────
[unified diff of template changes]

ANALYSIS & RECOMMENDATION
───────────────────────────────────────────────────────────────────
Changes are in different sections of the file.
Recommended: Merge (high confidence)
```

## Backup & Recovery

Before any changes, a backup branch is created:

```bash
# Backup branch naming
template-backup/20260202-143052

# To restore from backup
git checkout template-backup/20260202-143052
```

The backup branch contains your exact state before the update started.

## Breaking Changes

Breaking changes are detected from the changelog and highlighted:

```markdown
### Changes since v0.2.0-alpha.5

## [0.3.0] - 2026-02-15

### Changed
- BREAKING: Renamed /system:update to /system:process
- BREAKING: Changed DAL function signatures

### Migration Required
- Update all references to /system:update → /system:process
```

Breaking changes with the `BREAKING:` prefix are highlighted in the update summary.

## Anti-Patterns

```bash
# ❌ Updating without checking what changed
/template:update all

# ✅ Always preview first
/template:update --dry-run
/template:update all
```

```bash
# ❌ Ignoring backup branch info
/template:update all
# (something goes wrong)
# "I don't know how to recover!"

# ✅ Note the backup branch name
/template:update all
# Backup Created: template-backup/20260202-143052
# (if something goes wrong)
git checkout template-backup/20260202-143052
```

```bash
# ❌ Mixing user additions with template files
# Creating files like: .claude/commands/template/my-addition.md
# (This may cause conflicts if template adds a file with same name)

# ✅ Put user additions in clearly separate locations
# .claude/commands/my-custom/command.md
# .claude/skills/my-custom-skill/SKILL.md
```

```markdown
<!-- ❌ Adding content inside CLAUDE.md markers -->
<!-- template-section-start: technology-stack -->
## Technology Stack
| Tech | Version |
| My Custom Entry | 1.0 |  <!-- This will be overwritten! -->
<!-- template-section-end: technology-stack -->

<!-- ✅ Add custom content outside markers -->
## My Custom Section
| Tech | Version |
| My Custom Entry | 1.0 |
<!-- This is safe - outside markers -->
```

```bash
# ❌ Force-updating without understanding conflicts
/template:update all --force

# ✅ Review conflicts before forcing
/template:update --dry-run --verbose
# (understand what will change)
/template:update all --force  # only if you're sure
```

## Troubleshooting

### "Cannot Update: No Version Information"

**Cause**: Neither `.template.json` nor `VERSION` file exists.

**Fix**:
1. Create a `VERSION` file with your current version:
   ```bash
   echo "0.2.0-alpha.8" > VERSION
   ```
2. Run `/template:update` again

### "GitHub API Rate Limited"

**Cause**: Exceeded 60 requests/hour for unauthenticated users.

**Fix**:
1. Wait for rate limit reset (shown in error message)
2. Or wait about an hour and try again

### Update seems to overwrite my customizations

**Cause**: Customizations may be in template-owned files or inside markers.

**Fix**:
1. Check if your customizations are inside `<!-- template-section -->` markers
2. Move custom content outside markers in `CLAUDE.md`
3. For other files, consider creating user-addition files instead of modifying template files

### Conflict resolution keeps asking about same file

**Cause**: File was marked as "skipped" in previous update.

**Fix**:
1. Run `/template:update selective`
2. Explicitly select the file to update
3. Choose a resolution (don't skip again)

### Backup branch doesn't contain my changes

**Cause**: You had uncommitted changes when update started.

**Fix**:
1. Check git stash: `git stash list`
2. Your changes may be in the working directory on the backup branch
3. Next time, commit or stash changes before updating

### "Invalid Manifest" error

**Cause**: `.template.json` has syntax errors.

**Fix**:
1. Delete `.template.json`:
   ```bash
   rm .template.json
   ```
2. Run `/template:update` to regenerate

### User additions not being detected

**Cause**: Files may match template paths exactly.

**Fix**:
1. Rename user files to clearly different names
2. User additions are detected by comparing against template file list
3. If your file has the exact same path as a template file, it's treated as a modification, not an addition

## FAQ

### Q: Can I update to a specific version instead of latest?

Yes, use the `--version` flag:
```bash
/template:update --version v0.2.5
```

### Q: What happens if I modified a template file?

The three-way diff detects this. If both you and the template modified the file:
1. You'll see a conflict prompt
2. You can choose to merge, keep yours, or use template
3. Claude provides recommendations based on the changes

### Q: Can I undo an update?

Yes, restore from the backup branch:
```bash
git checkout template-backup/[timestamp]
```

### Q: How do I add my own commands/skills without conflicts?

Create them in separate directories or with unique names:
- `.claude/commands/my-custom/` (not in template)
- `.claude/skills/my-project-skill/` (unique name)
- These are auto-detected as user additions and never touched

### Q: Will my `src/` code ever be affected?

No. The `src/**`, `public/**`, and `prisma/schema.prisma` paths are in the skip list and are never modified by template updates.

### Q: How often should I update?

Recommended: Check monthly with `/template:check`. Update when:
- Security-related changes are in the changelog
- New features you want to use
- Breaking changes you need to adopt

### Q: Can I contribute changes back to the template?

Not directly through this system (that's a v2 feature). For now:
1. Fork the template repository
2. Make changes in your fork
3. Submit a PR to the upstream template

### Q: What if I want to skip certain files permanently?

Add them to `skipPatterns` in `.template.json`:
```json
{
  "skipPatterns": [
    "src/**",
    "public/**",
    ".claude/commands/template/check.md"  // Never update this file
  ]
}
```

## References

- [CLAUDE.md - Template section](../CLAUDE.md) - Commands documented in project instructions
- [Specification](../specs/template-update-system/02-specification.md) - Technical design details
- `/template:check` command - Check for updates
- `/template:update` command - Apply updates
