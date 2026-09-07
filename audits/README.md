# `audits/` — charters and run logs

This directory holds **audit charters**, one per domain, plus the **run logs** the audits produce.
A charter is the standing contract for auditing one domain of this repo: what gets looked at,
through which lenses, what counts as a valid finding, and how findings get ranked.

```
audits/
├── README.md            # this file — the preamble every charter inherits
├── ui.md                # the UI/UX charter (apps/client)
└── runs/
    └── <domain>/
        └── <date>/      # one run: report, per-lens diff stamps, rotation state, ledger
```

Today there is one charter (`ui.md`). The convention exists so the next one (`docs.md`,
`adrs.md`, `harness.md`) has an obvious home instead of contending for a single root file.

## The charter skeleton

Any domain charter reuses the same six sections. Copy the shape, not the content:

1. **Scope** — what is inside the domain and what is explicitly outside.
2. **Ground truth** — the docs an auditor must read before forming an opinion. Repo-specific;
   keep it in its own clearly-marked section so the generic half stays portable.
3. **Lenses** — the audit's decomposition. One lens is one auditor. A finding belongs to
   exactly one lens; the synthesizer resolves cross-lens overlap.
4. **Rubric** — severity and effort, defined so two auditors rank the same finding the same way.
5. **Validity rules** — what makes a finding real rather than an opinion. Every charter needs
   a citation rule and a "don't relitigate settled decisions" rule at minimum.
6. **Standing directives** — the operator's durable preferences for that domain, dated.

## Standing directives (all domains)

These are true of every audit this repo runs. A domain charter may sharpen them; none may
contradict them.

- **Simplify first.** When two valid recommendations exist, the one that removes, merges, or
  shortens wins. Prefer deleting over restyling, one thing over two, a short label over a
  sentence. An audit that only adds has failed.
- **No walls of text.** Nothing this repo produces for a human, on screen or on a page, may be
  a large undifferentiated block of prose. Lead with the gist in as few words as possible
  (generally under five for a headline), then offer a path to more detail only when it genuinely
  matters. "Learn more" names the **pattern**, never the literal text: pick the affordance that
  fits (info icon, tooltip, expandable section, contextual link, hover card), and if the gist is
  enough, use no affordance at all. This is progressive disclosure applied to copy.
- **Sample honestly.** An auditor that cannot cover its domain exhaustively says what it
  covered and what it skipped, in the report, every time. A silent gap is worse than a stated
  one, because the reader believes the audit is complete.
- **Cite or drop it.** A finding names a real `file:line` the auditor actually opened.
  Inferences from file names are not findings.
- **The audit writes zero code.** Findings only. Fixing happens in a separate, reviewed pass.

## Rules for this directory

- **Committed, never gitignored.** Worktrees only carry tracked files, so a gitignored charter
  would not exist where batch agents actually run. Per-lens diff stamps have to survive across
  checkouts and machines, and when no tracker is configured the run-log ledger _is_ the tracker
  of record.
- **Lean markdown only.** No screenshots, videos, or other heavy artifacts inside `audits/`.
  Capture them in the session scratchpad and reference them by description. Run logs stay
  readable in a diff.
- **Create if absent, never overwrite.** A tool scaffolding a charter creates the file when it
  is missing and leaves it alone when it exists. This README in particular is shared: it accretes
  directives from every domain, and no single audit may clobber another's additions.
- **Guard-safe prose.** `audits/` is not in the scan list of the banned-words guard
  (`scripts/check-banned-words.sh`) today, but write as if it were: any retired vocabulary named
  here needs the same inline `vocab-allow` marker plus a reason the guard asks for elsewhere.

## Prior art

The September 2026 UI/UX audit ran before this convention existed; its charter, findings, and
execution plan stay where they are, as history: `plans/ui-ux-audit-202609/`. `audits/ui.md` is
that charter generalized. Run logs start at the next run.
