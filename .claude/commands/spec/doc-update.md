---
description: Review documentation for updates needed based on a spec file
allowed-tools: Agent, Read, Glob
argument-hint: '<path-to-spec-file>'
category: workflow
---

# Documentation Update Review Based on Spec

Review all documentation for updates needed because of the specification at `$ARGUMENTS`.

## Step 1: Read the Specification

Read the spec and identify what it **deprecates/removes**, what it **changes**, and what it **adds** — these are the three lenses every doc gets reviewed through.

## Step 2: Gather Documentation Files

Glob root-level `*.md` and `contributing/*.md`.

## Step 3: Review Each Doc Against the Spec

For a handful of docs, review them inline. For a larger set, dispatch **general-purpose agents in parallel** (batch several docs per agent; launch all agents in a single message). Give each agent a 3-5 sentence summary of the spec's key changes plus its doc list, and have it report per file:

- **Deprecated content** — sections documenting functionality the spec removes; quote the doc text, cite the spec section, and mark severity: CRITICAL (following the doc would break) vs WARNING (merely outdated)
- **Content requiring updates** — quote the current text, explain what changed per the spec, suggest updated wording
- **Missing content** — new functionality that belongs in this doc, with suggested placement and draft text
- Or simply: "No updates required."

## Step 4: Consolidate and Act

1. Aggregate into a per-file summary table with priority counts: P0 deprecated-but-documented, P1 misleading, P2 missing new features, P3 minor.
2. Present detailed findings ordered by priority across all files.
3. Recommend which files need attention first and the rough effort for each.
4. Ask whether to implement the suggested updates now.

## Usage

```bash
/spec:doc-update specs/<slug>/02-specification.md
```
