# Specifications

`manifest.json` indexes the specifications retained in this checkout. Each entry
names a folder and its current stage. A folder may also contain its own manifest;
the status must agree with the index.

## Keep current work

Keep unfinished work. Keep any specification named by an open issue, an active
project brief or an open pull request. Keep a completed specification that a
script or test reads, together with the specifications it depends on.

A completed specification that is only cited (by instructions, developer guides,
ADRs, docs or source comments) can leave the checkout. Rewrite each of those
citations to a permalink pinned to an exact commit, never to `main`, so the
design stays one click away. Update the manifest and every surviving link in the
same commit.

Each removal batch lists the folders it removes and shows that a search for
`specs/<slug>` finds no local paths left outside the permalinks.

## Recover historical work

Completed or abandoned specifications leave the checkout once the reference check
clears them. Git history keeps their contents. Links from surviving documents use
a commit permalink so the historical design remains readable.

Find a removed specification with:

```bash
git log --all -- specs/<slug>
git show <commit-before-removal>:specs/<slug>/02-specification.md
```

Older code comments may still name a removed specification by its original path.
Use the same history lookup to recover it. Existing files in `archive/` predate this
policy; new cleanup batches remove files instead of moving them there.
