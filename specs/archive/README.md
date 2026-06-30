# Archived Specs

This directory holds retired specifications. It mirrors the `decisions/archive/`
pattern: an archived spec is physically MOVED into `specs/archive/<slug>/` and
its entry is REMOVED from `specs/manifest.json`. The active manifest therefore
only ever lists live specs, which keeps `audit`, `list`, and the manifest's
`nextNumber` focused on work that still matters.

Archived specs stay on disk for provenance (inbound links from other specs,
research notes, and ADRs continue to resolve), they just leave the manifest.

## What "archived" means vs. "superseded"

These are orthogonal:

- `superseded` is a manifest **status** for a spec that is still tracked but has
  been replaced by a newer spec. It stays in `specs/manifest.json`.
- **Archived** means the spec has left the manifest entirely and its directory
  now lives under `specs/archive/`. A spec can be archived from any status.

Most specs are archived after they have been `implemented` (or `superseded`) for
long enough that nobody is iterating on them.

## When to archive (policy, not an automated rule)

Archiving is a deliberate, human-triggered judgment call, not something a cron
runs. Archive a spec when at least one of these holds and you are confident the
spec is no longer a live reference:

- It is `implemented` and the work shipped more than ~6 months ago, and the spec
  is not actively cited as the current design of record for an evolving area.
- It is `superseded` by a newer spec and the replacement is itself shipped.
- It documents an abandoned or cancelled direction that was never built.

When in doubt, leave it in place. The cost of an over-long manifest is low; the
cost of archiving a spec that is still someone's source of truth is high. Bias
toward keeping specs in the manifest until their irrelevance is obvious.

## How to archive (the supported procedure)

Use the manifest-ops script. The `archive` subcommand moves the directory and
drops the manifest entry in one step:

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  .claude/scripts/spec-manifest-ops.ts archive <slug>
```

This is equivalent to the manual steps (kept here for reference / recovery):

1. `git mv specs/<slug> specs/archive/<slug>`
2. Remove the `<slug>` entry from the `specs` array in `specs/manifest.json`
   (or run `... spec-manifest-ops.ts remove <slug>` before the move).

Either way, commit the move and the manifest change together so history stays
coherent.

### Before you move: check inbound references

Other specs, research files, ADRs, and plans frequently link to a spec by its
`specs/<slug>/...` path. Before archiving, grep the repo for inbound references
and update any that you move:

```bash
grep -rn "specs/<slug>" . --include='*.md' --include='*.mdx' --include='*.json' \
  --include='*.ts' --include='*.mjs'
```

Re-point the surviving references at `specs/archive/<slug>/...`.

## Recovering an archived spec

Reverse the move and re-add the manifest entry:

```bash
git mv specs/archive/<slug> specs/<slug>
node --experimental-strip-types --disable-warning=ExperimentalWarning \
  .claude/scripts/spec-manifest-ops.ts add <slug> "Title" --status=<status>
```

`nextNumber` is never decremented by archiving, so a recovered spec is given a
fresh number unless you restore its original entry by hand.

## Bulk migration of the existing backlog is a separate follow-up

This directory establishes the lifecycle; it does not migrate the hundreds of
already-implemented specs. Sweeping the historical backlog into the archive is an
explicit, separate piece of work and should be done deliberately, spec by spec,
with the inbound-reference check above.
