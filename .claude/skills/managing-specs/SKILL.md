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

| Command               | Purpose                                                    |
| --------------------- | ---------------------------------------------------------- |
| `get <slug>`          | Print a spec entry as JSON                                 |
| `list [--status=<s>]` | List specs, optionally filtered                            |
| `audit [--json]`      | Audit manifest vs filesystem                               |
| `fix [--dry-run]`     | Auto-fix all audit findings                                |
| `remove <slug>`       | Remove a spec entry from the manifest (leaves files)       |
| `archive <slug>`      | Retire a spec: move to `specs/archive/` and drop the entry |

## Archiving Retired Specs

`specs/` is append-only by default: implemented specs stay listed forever. To
retire one, archive it. This mirrors the `decisions/archive/` lifecycle: the
spec directory is MOVED to `specs/archive/<slug>/` and its entry is REMOVED from
`specs/manifest.json`, so the active manifest only ever lists live specs.

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  .claude/scripts/spec-manifest-ops.ts archive <slug>
```

`archive` vs `superseded`: `superseded` is a manifest **status** for a spec that
is still tracked; **archiving** removes the spec from the manifest entirely. A
spec can be archived from any status (usually `implemented` or `superseded`).

When to archive (policy, not an automated rule): a spec that is `implemented` and
shipped more than ~6 months ago, or one that is `superseded` by a shipped
replacement, or an abandoned direction. When in doubt, leave it in place. Before
archiving, grep for inbound `specs/<slug>` references and re-point any you move.
The full policy and recovery steps live in
[`specs/archive/README.md`](../../../specs/archive/README.md). Bulk-migrating the
existing backlog is a separate, deliberate follow-up, not something this command
does in one sweep.

## Identifiers (timestamp ids)

New specs get a coordination-free timestamp `id` (`YYMMDD-HHMMSS`), which `add`
stamps from the local clock via `.claude/scripts/id.ts` — no shared counter, so
two branches can never allocate the same id (spec #271 / DOR-184). The ~260
existing specs are frozen and keep their legacy `number`; `list`, `audit`, and
`fix` display each entry by its key (the timestamp id, or a zero-padded legacy
number, which sorts before timestamp ids). There is no `nextNumber` field to
maintain — `add` and `fix` self-allocate ids, and archiving or removing an entry
is always safe because ids are never reused.

## Integration Points

These slash commands should update the manifest as part of their workflow:

| Command         | Manifest action                                  |
| --------------- | ------------------------------------------------ |
| `/flow:ideate`  | `add <slug> "Title" --status=ideation`           |
| `/flow:specify` | Ensure entry exists with status `specified`      |
| `/flow:execute` | `update-status <slug> implemented` on completion |
