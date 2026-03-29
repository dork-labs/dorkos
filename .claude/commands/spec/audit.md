---
allowed-tools: Bash(node:*), AskUserQuestion
description: Audit spec manifest against filesystem and fix issues
---

## Audit the Spec Manifest

Run the manifest audit to check for non-canonical statuses, status mismatches, orphan directories, and missing directories.

!`node --experimental-strip-types --disable-warning=ExperimentalWarning .claude/scripts/spec-manifest-ops.ts audit`

If the audit reports zero issues, say so and stop.

If issues are found, ask the user:

> The audit found issues. Would you like me to auto-fix them?

If the user declines, stop.

If the user agrees, first show what would change with a dry run:

```
node --experimental-strip-types --disable-warning=ExperimentalWarning .claude/scripts/spec-manifest-ops.ts fix --dry-run
```

Then apply the fix:

```
node --experimental-strip-types --disable-warning=ExperimentalWarning .claude/scripts/spec-manifest-ops.ts fix
```

After fixing, run the audit once more to confirm all issues are resolved:

```
node --experimental-strip-types --disable-warning=ExperimentalWarning .claude/scripts/spec-manifest-ops.ts audit
```

Report the final state to the user.
