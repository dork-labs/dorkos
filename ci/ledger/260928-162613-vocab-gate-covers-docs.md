---
id: 260928-162613
title: check-vocab-gate.ts covers docs/**/*.mdx prose
kind: hygiene
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
ratchet-release: []
field-changes: []
---

DOR-2508's connections-health audit found `docs/connections/**` had drifted from the
shipped product (a stale Notifications control path, the in-chat request card
missing from the write-up, a threat-model claim that was false for two of the
four routes) and that `docs/**/*.mdx` carried the four nouns ADR 260804-021140
retired — "integration", "connector", "adapter", "provider" — with nothing to
catch the next one, because `check-vocab-gate.ts`'s own header had docs/ marked
"prose, not a render path, swept by hand".

`check-vocab-gate.ts` now also scans `.mdx` files under `docs/` (a line-based
pass after blanking fenced code, inline code and link/href targets — MDX isn't
TypeScript, so it can't use the parser walk `scanSource` uses), scoped to wave 4
only: wave 1's "connection" is ordinary prose everywhere a docs page talks about
a network connection (SSE, tunnels, the reverse-proxy guide), and sweeping that
wave is a separate, unscoped effort this change does not take on. `docs/api/**`
(generated from `openapi.json`) and the two compiled changelog files are
excluded, the same carve-outs `check-banned-words.sh` already documented for
wave 2.

Four rounds of code review on this change caught real defects before any of
them landed, each verified against ground truth rather than taken on faith:

1. **Fence detection.** The tracker mis-parsed a fenced block that Prettier
   collapses onto one line (`docs/contributing/testing.mdx`'s shape), which
   would have blanked every remaining line in the file as "still fenced."
   Fixed with a same-line open+close case treated as inline code, and closers
   tracked by character AND length so a shorter nested fence of the same
   character never closes an outer one. A LATER round found the fix's closer
   check was still unanchored (`fenceChar{fenceLen,}` matched anywhere on a
   line, not just a line that IS the closer alone) — confirmed wrong against
   the real `@mdx-js/mdx` compiler, not just reasoned about: compiling
   `docs/self-hosting/deployment.mdx`'s actual closer-trails-content line
   showed the real parser does NOT close the fence there either. That turned
   out to be a real, live site bug, not just a hypothetical: the "Interactive
   Setup" tab on that page never rendered, silently absorbed into the
   "Environment Variables" code block. Anchored to
   `^\s*${fenceChar}{${fenceLen},}\s*$` — CommonMark's real rule — so a
   fence-character run in the middle of a content line, or one that merely
   ends a line of real content, is never mistaken for a closer. Fixed the
   page directly (a real multi-line fence, closer alone on its own line) in
   the same change, and swept every other file under `docs/**/*.mdx` for the
   same shape — a content line ending in a fence-character run, with no
   opener earlier on that same line — plus an EOF-unclosed-fence check across
   all 313 docs files; deployment.mdx was the only instance of either.
2. **`vocab-allow` marker syntax.** Written as an HTML comment
   (`<!-- vocab-allow: reason -->`) in four files, which reads as an ordinary
   comment in plain Markdown but breaks MDX compilation outright: MDX parses
   `<` as the start of a JSX tag, and `<!--` is not a valid tag name. Caught
   by actually compiling the touched files with `@mdx-js/mdx` (the same
   compiler `apps/site`'s build uses), not by inspection — four files
   (`docs/concepts/relay.mdx`, `docs/guides/relay-messaging.mdx`,
   `docs/guides/workspaces.mdx`, `docs/marketplace/index.mdx`) would have
   failed the site build. Switched every marker to the JSX-comment form
   (`{/* vocab-allow: reason */}`) MDX actually supports, and added
   `scripts/__tests__/docs-mdx-markers-compile.test.ts`, which compiles every
   docs `.mdx` file carrying the marker on every run — resolving `@mdx-js/mdx`
   by walking pnpm's real dependency graph from `apps/site`'s own declared
   `fumadocs-mdx` dependency, since the package isn't directly reachable from
   `scripts/`.
3. **Whole-file `allowlist.json` entries still too wide.** A file-scoped entry
   (no `contains`) exempts every matching line in that file, which is right
   for a whole-page developer guide (`docs/integrations/`) but wrong for a
   narrow, single-purpose entry covering one real code-identifier key or one
   Card title — a NEW, unrelated use of the same term anywhere else in that
   file would have been silently suppressed too. Added an optional `contains`
   field to `AllowlistEntry`, checked against the violation's own snippet in
   `isAllowlisted`, and converted every single-purpose docs entry to it (kept
   4 directory/whole-page entries for genuinely developer-only sections
   unchanged, since they cover dozens of legitimate lines each with no one
   substring to name). Verified with the exact mutations review proposed —
   a new `### Connectors` heading in `configuration.mdx`, `Pick a provider
for your workspace.` in `workspaces.mdx`, `First, add a Telegram adapter.`
   in `agent-coordination.mdx` — each still gets caught now, each was
   silently swallowed before.

The `vocab-allow` marker placement itself needed a second correction mid-review
too: Prettier always moves a trailing `//`/JSX comment on a multi-property
object's or multi-child `<Card>`'s opening line onto its own following line,
breaking the same-line requirement the marker depends on — confirmed by
committing, letting the format hook run, and re-scanning (8 markers moved).
Replaced those specific spots with `contains`-scoped allowlist entries instead
of fighting Prettier; markers stay everywhere they demonstrably survive (plain
prose, headings, list items).

The docs sweep itself — the false/stale lines the audit found, rewording most
of an initial 24-entry allowlist sweep down to 4 directory/file entries for
genuinely developer-only sections (`docs/integrations/`,
`docs/marketplace/publishing.mdx`, `docs/contributing/architecture.mdx`,
`docs/guides/flow/`) — is content work, not a pipeline change; this entry
covers only the gate extension mechanism (docs scanning, fence detection, the
marker convention, `contains` scoping, MDX-compile verification).

No new workflow step, job or required check: the docs scan rides the existing
`Retired-vocabulary gate` step in `typecheck` (renamed to say so), the
existing real-repo canary in `scripts/__tests__/check-vocab-gate.test.ts`
(`runVocabGate(repoRoot)` now walks both `apps/{client,site,server}/src` and
`docs/`), and the new `docs-mdx-markers-compile.test.ts` — same step, same
`scripts` vitest project, no new job. That suite gained fixture and
mutation-style tests for the new mechanism: fence detection (both original
defects as pinned regressions, the corrected closer-anchoring behavior against
the real compiler, a 4-backtick/3-backtick nested-fence case, and a mid-line
``` that must never be mistaken for a closer), the `vocab-allow` marker and
its `contains` scoping (including the exact mutations review proposed, with
`configuration.mdx`'s pinned as its own fixture test against the real shipped
file), and two tests that drive a seeded docs violation through `runVocabGate`
itself (never `scanMdx` directly) specifically so a future change that
disables or drops the docs half of that function fails a test — verified by
hand every time: deleting the relevant code reds exactly the tests naming it,
restoring it goes green again.
`kind: hygiene` — this closes a coverage gap the tool already existed to
close, it does not change what "passing" means for any surface that was
already scanned. Revert if the docs scan produces false positives faster than
the allowlist and the marker convention can absorb them (nothing observed in
this change: the real-repo canary and a full
`pnpm exec tsx scripts/check-vocab-gate.ts .` both run clean).
