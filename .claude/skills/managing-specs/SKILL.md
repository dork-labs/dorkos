---
name: managing-specs
description: Canonical rules for spec manifest management — statuses, transitions, and the manifest-ops script. Auto-loads when working with spec files.
user-invocable: false
paths: specs/**
---

# Managing the Spec Manifest

The spec manifest (`specs/manifest.json`) tracks every specification in the project. Never edit it by hand — always use the manifest-ops script.

## Running the Script

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning .claude/scripts/spec-manifest-ops.ts <command> [args] [options]
```

## Canonical Statuses

Only four statuses are valid:

| Status        | Meaning                         |
| ------------- | ------------------------------- |
| `ideation`    | Spec has `01-ideation.md`       |
| `specified`   | Spec has `02-specification.md`  |
| `implemented` | Spec has `04-implementation.md` |
| `superseded`  | Replaced by a newer spec        |

Non-canonical aliases are normalized automatically: `draft` -> `ideation`, `specification` -> `specified`, `completed` -> `implemented`.

## Status Progression

Statuses move forward only: **ideation -> specified -> implemented -> superseded**. The script rejects regressions unless `--force` is passed.

## When to Update Status

- After writing `01-ideation.md` -> set to `ideation`
- After writing `02-specification.md` -> set to `specified`
- After all implementation tasks complete -> set to `implemented`
- When replaced by a newer spec -> set to `superseded`

## Commands

### Update status

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  .claude/scripts/spec-manifest-ops.ts update-status <slug> <status>
```

### Add a new spec

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  .claude/scripts/spec-manifest-ops.ts add <slug> "Title" --status=ideation
```

Options: `--status=<s>`, `--project=<p>`, `--created=YYYY-MM-DD`.

### Other operations

| Command               | Purpose                               |
| --------------------- | ------------------------------------- |
| `get <slug>`          | Print a spec entry as JSON            |
| `list [--status=<s>]` | List specs, optionally filtered       |
| `audit [--json]`      | Audit manifest vs filesystem          |
| `fix [--dry-run]`     | Auto-fix all audit findings           |
| `remove <slug>`       | Remove a spec entry from the manifest |

## Integration Points

These slash commands should update the manifest as part of their workflow:

| Command         | Manifest action                                  |
| --------------- | ------------------------------------------------ |
| `/ideate`       | `add <slug> "Title" --status=ideation`           |
| `/spec:create`  | Ensure entry exists with status `specified`      |
| `/spec:execute` | `update-status <slug> implemented` on completion |
