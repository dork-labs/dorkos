# Package.json Three-Way Merge

Intelligent merging of package.json dependencies using three-way diff logic.

## Quick Start

```bash
npx tsx .claude/scripts/template-fetch.ts merge-pkg base.json ours.json theirs.json
```

Where:
- `base.json` - package.json at user's current template version
- `ours.json` - Local package.json (user's current state)
- `theirs.json` - package.json at target template version

## Merge Rules

| Base | Ours | Theirs | Action | Icon |
|------|------|--------|--------|------|
| A@1 | A@1 | A@2 | Update to A@2 | ⬆️ |
| A@1 | A@2 | A@1 | Keep A@2 (user changed) | ✓ |
| A@1 | A@2 | A@3 | Conflict - keep A@2, flag | ⚠️ |
| - | - | A@1 | Add A@1 (new in template) | ➕ |
| A@1 | A@1 | - | Remove A (template removed) | ➖ |
| - | A@1 | - | Keep A@1 (user added) | ✓ |

## TypeScript Usage

```typescript
import { mergePackageJson, type PackageJsonMergeResult } from '.claude/scripts/template-fetch'

const base = JSON.parse(fs.readFileSync('base.json', 'utf-8'))
const ours = JSON.parse(fs.readFileSync('ours.json', 'utf-8'))
const theirs = JSON.parse(fs.readFileSync('theirs.json', 'utf-8'))

const result: PackageJsonMergeResult = mergePackageJson(base, ours, theirs)

// Check for conflicts
if (result.conflicts.length > 0) {
  console.log('⚠️  Conflicts requiring review:')
  for (const conflict of result.conflicts) {
    console.log(`  ${conflict.name}: ${conflict.reason}`)
  }
}

// Apply merged dependencies
fs.writeFileSync('package.json', JSON.stringify(result.merged, null, 2))
```

## Output Format

```
📦 Package.json Three-Way Merge

Dependencies:
  ⬆️ react: ^18.0.0 → ^19.0.0
     Template updated version
  ⚠️ lodash: ^4.18.0 → ^4.20.0
     Both modified: user set ^4.18.0, template set ^4.20.0
  ➕ next: ^15.0.0
     New dependency in template

⚠️  Conflicts requiring review:
  - lodash: Both modified: user set ^4.18.0, template set ^4.20.0

Merged package.json:
{ ... }
```

## Important Notes

- **Scripts are NEVER modified** - always kept from "ours"
- **Other config fields** (name, version, etc.) - kept from "ours"
- **Only dependencies and devDependencies are merged**
- **Conflicts keep user's version** but flag for review
- **Returns full change list** for display/logging

## Implementation Details

**Types:**
- `DepChange` - Individual dependency change
- `PackageJsonMergeResult` - Complete merge result with changes and conflicts

**Functions:**
- `mergeDependencies()` - Helper for merging a single dependency section
- `mergePackageJson()` - Main entry point for full package.json merge

**Location:** `.claude/scripts/template-fetch.ts`
