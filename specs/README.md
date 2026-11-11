# Specifications

`manifest.json` indexes the specifications retained in this checkout. Each entry
names a folder and its current stage. A folder may also contain its own manifest;
the status must agree with the index.

## Keep current work

Keep unfinished work and any specification referenced by an open issue, project,
or pull request. Check those references before removing a completed or superseded
specification. Update the manifest and surviving links in the same commit.

## Recover historical work

Completed or abandoned specifications leave the checkout once the reference check
clears them. Git history keeps their contents. Links from surviving documents use
a commit permalink so the historical design remains readable.

Find a removed specification with:

```bash
git log --all -- specs/<slug>
git show <commit-before-removal>:specs/<slug>/02-specification.md
```

Code comments may name a historical specification by its original path. Use the
same history lookup to recover it. Existing files in `archive/` predate this
policy; new cleanup batches remove files instead of moving them there.
