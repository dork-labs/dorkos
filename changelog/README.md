# Changelog fragments

Unreleased changelog entries live here as **one file per change**, not as a shared
`[Unreleased]` block in `CHANGELOG.md`. This is the same coordination-free idea behind
timestamp-id ADRs (ADR-0312): give every change its own uniquely-named file so parallel
branches never touch the same lines.

## Why

DorkOS runs many coding agents in parallel worktrees. A single `[Unreleased]` section in
`CHANGELOG.md` was edited by nearly every branch (255 commits touched it in one three-month
window), so almost every merge collided there — and a `post-commit` hook re-appended entries,
compounding it. Distinct per-change files can never add/add-conflict (verified empirically in
`.claude/scripts/__tests__/merge-behavior.test.ts`). As a bonus, `CHANGELOG.md` stops growing
without bound: only the release process writes it, and old versions are archived out.

See `decisions/260707-231641-changelog-fragments.md` for the full decision record.

## Layout

```
changelog/
├── README.md              # this file
├── unreleased/            # one fragment per change (compiled + deleted at release)
│   └── <id>-<slug>.md
└── archive/               # released version sections aged out of CHANGELOG.md
    └── CHANGELOG-vA-to-vB.md
```

## Fragment filename

```
<YYMMDD-HHMMSS>-<kebab-slug>.md
```

- **`<YYMMDD-HHMMSS>`** — a UTC timestamp id (`.claude/scripts/id.ts`). It orders fragments
  chronologically and, because two branches stamp their own clocks, keeps filenames unique
  without any shared counter.
- **`<kebab-slug>`** — a short (2–6 word) human-readable description, lowercase with hyphens.

Example: `260707-231643-fragment-based-changelog.md`.

## Fragment body

Optional `covers:` frontmatter (see below), then one or more
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) category headings: `### Added`,
`### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security`, each followed by
markdown bullets. One fragment may carry more than one category. Write bullets per the
`writing-changelogs` skill: imperative, user-focused, with references like `(DOR-123)` or
`(#42)` where they exist.

One heading outside Keep a Changelog is also allowed: `### Note for people upgrading`, for a
bullet that is not a change so much as something an upgrader needs to know before or after
applying one (an established repo practice — it has shipped in CHANGELOG.md's v0.57.0 notes and
in several PRs since). `.claude/scripts/changelog_backfill.py --validate` accepts exactly these
seven headings and rejects any other; a typo'd or invented heading (`### Improved`, `### Docs`)
is not automatically merged at release, so it fails the gate instead of depending on whoever
compiles the release to notice it by hand.

<!-- The double quotes below are load-bearing: verbatim what the post-commit hook writes.
     Prettier rewrites quotes inside an embedded fence, hence the ignore. -->
<!-- prettier-ignore -->
```markdown
---
covers:
  - "feat(notify): Telegram notification on turn completion (DOR-123)"
  - "fix(chat): drop of final streamed token (#42)"
---

### Added

- Get a Telegram message when your agent finishes a turn (DOR-123)

### Fixed

- Stop dropping the final token of a streamed reply (#42)
```

## `covers:` — which commits this fragment covers

The PR check (`.claude/scripts/changelog_backfill.py --check`, run by the
`changelog-fragment-check` workflow) has to answer one question: does every user-facing commit
on this branch have a fragment? `covers:` is how a fragment answers it, as a plain statement of
fact.

This matters because the two things we ask of a fragment used to fight each other. A fragment's
bullets are meant to be rewritten for a person, while commit subjects are developer shorthand.
The check used to guess at coverage by comparing the two word for word, so polishing a bullet
was the most common way to turn CI red. With `covers:` the two are independent: **rewrite the
prose however you like, and leave the frontmatter alone.**

Each item under `covers:` is one of three things, told apart by its shape:

| Item           | Means                                           |
| -------------- | ----------------------------------------------- |
| `"feat(x): …"` | a commit, named by its exact subject line       |
| `a1b2c3d`      | a commit, named by its SHA (7 to 40 characters) |
| `"#412"`       | every commit in pull request 412                |

Quote subjects and `#` items. A commit subject contains `: `, which YAML would otherwise read
as a key, and `#` starts a YAML comment. A bare SHA needs no quotes.

**You usually write none of this.** The `post-commit` hook fills in `covers:` with the commit's
subject when it mints the fragment. Things worth knowing:

- **One fragment, several commits.** List every subject. This is the normal shape for a feature
  that landed over three commits and deserves one entry.
- **A whole PR.** `- "#412"` covers every commit in PR 412. Use it when a PR is one change from
  a user's point of view and splitting it per commit would be noise. Two things to know. Only
  the CI run knows the PR number, so a local `--check` ignores `#` items: local runs are the
  stricter ones. And a PR-level claim is never silent. The passing check names every commit that
  rode in on it, because a blanket claim asserts those changes need no changelog prose at all.
  If what you actually want is "this whole PR needs no changelog", the honest tool is the
  `skip-changelog` label, not a blanket claim.
- **The hook declares the subject, not the SHA,** because it amends the fragment into the commit
  and that changes the commit's SHA. A commit can never contain its own SHA, and a rebase would
  rewrite it anyway. Subjects survive both. Write a SHA yourself when you are covering a commit
  that already exists.
- **A squash-merge does not break a subject claim.** GitHub appends ` (#412)` when it squashes,
  so a trailing PR reference is ignored on both sides of the comparison. The claim you wrote
  before merging still matches the commit that landed.
- **A stale declaration is not an error.** If nothing in `covers:` matches a commit on the
  branch (after a rebase, say, or once the PR has merged and the fragment is waiting for
  release), the fragment falls back to the old word-comparison behaviour. Declarations only ever
  add coverage, so a stale one can never turn a passing check red.
- **A fragment with no `covers:` still works.** Every fragment written before this existed keeps
  passing on the word-comparison fallback.
- **Do not claim a commit this check ignores.** Once any of a fragment's claims matches
  something, that fragment stops falling back to word comparison. So a `covers:` line pointing
  at a `chore:` or `docs:` commit quietly costs the fragment its fallback, and the change it was
  really written for can end up reported as uncovered. The failure message calls this out when
  it happens.
- **A broken `covers:` block fails the check.** Get the delimiters wrong (no closing `---`, for
  instance) and the claim lines land in the fragment body, where a raw commit subject would
  match almost any similar commit and pass this check forever. So a malformed fragment is
  refused outright, with the file name and what to correct, rather than guessed at. A
  well-formed fragment starts on line 1 with `---`, then `covers:` and its items, then a closing
  `---`, then the `### Category` body. See "who gets blamed" below for which run refuses it.

When the check fails, it prints the commit it could not account for, the exact line to paste
into an existing fragment, and the exact file and frontmatter for a new one. Follow it
literally. If the change genuinely is not user-facing, label the PR `skip-changelog` instead.

### Who gets blamed for a broken fragment

The PR job asks two separate questions, on purpose, because they have different answers and
different owners:

| Question                                        | Scope                       | `skip-changelog`? |
| ----------------------------------------------- | --------------------------- | ----------------- |
| **Validity**: is each `covers:` block readable? | only fragments the PR wrote | no bypass         |
| **Coverage**: is every commit claimed?          | the PR's whole commit range | bypassed          |

A broken fragment is a defect whether or not your PR owes a changelog entry, so `skip-changelog`
does not wave it through: its declaration gets ignored, meaning it claims nothing, so leaving it
on main would hand the next author a red they cannot explain. Equally, a broken fragment
someone else already merged is **not your problem**. The check only fails on fragments your own
branch touched. A stray one is named as a `NOTE:` on the passing run, so it still gets noticed
without charging you for it.

**Locally, a bare `python3 .claude/scripts/changelog_backfill.py --check` (or `--validate`)
deliberately checks everything on disk.** That is the stricter, more useful signal when you are
the one looking. So if a local run flags a fragment you did not write, that is expected and CI
will not repeat it: CI narrows validity to your diff. Note also that the narrowing compares
committed state, so a fragment you have written but not yet committed reads as untouched.

## How fragments get created

- **Automatically.** The `post-commit` hook (`.claude/git-hooks/changelog-populator.py`,
  installed via `.claude/scripts/install-git-hooks.sh`) derives a fragment from your
  conventional-commit subject: `feat:` → `### Added`, `fix:` → `### Fixed`,
  `refactor:`/`perf:` → `### Changed`. `docs:`/`style:`/`test:`/`build:`/`ci:`/`chore:`/
  `Merge`/`Revert` are skipped — not user-facing by default (hand-author a fragment when
  such a change genuinely affects users). It also fills in `covers:` with the commit's subject.
  The fragment is written and staged into the same commit; it dedupes so an amend or rebase
  never doubles an entry.
- **By hand.** For anything the hook can't phrase well — or a change that spans multiple
  categories — write the fragment yourself. Curate the hook's fragment before opening a PR:
  rewrite it for a user, split or merge categories, add a reference. A good curated fragment
  is worth more than a raw commit-subject line. Rewriting the prose is always safe; when you
  merge two fragments into one, move the losing fragment's `covers:` items across so the
  commits stay accounted for.

**A PR with user-facing changes should include a fragment.** "User-facing" means someone
_operating_ DorkOS notices — a change only a DorkOS _builder_ notices (harness, CI, tests,
contributor docs, internal refactors) takes the `skip-changelog` label instead, even when it
lands as `feat:` or `fix:` (the `writing-changelogs` skill's audience test). Never edit
`CHANGELOG.md`'s `[Unreleased]` section — it no longer holds entries.

### Seeded fragments

A hook-minted fragment's entry is not a changelog bullet yet — it is the commit subject reshaped
just enough to look like one. Nobody has read it, and a technical subject ("Watch the relay's
runtime too, and regenerate the API spec") reads fine to the agent that wrote the commit and badly
to everyone else. Once, that shipped almost verbatim; only a human reviewer caught it, and nothing
structural stopped it (PR #1409).

So every fragment `changelog-populator.py` writes carries an HTML comment above its entry:

```markdown
<!-- dorkos-changelog:seeded — rewrite this bullet for a human, then delete this comment. If the
     change needs no changelog entry, delete the whole fragment instead. See
     changelog/README.md#seeded-fragments. -->
```

`.claude/scripts/changelog_backfill.py --validate` fails on any fragment that still contains it —
no `skip-changelog` bypass, the same as any other malformed fragment (see "Who gets blamed"
above). `--check` (the coverage gate) fails on it too, though it reports the commit as covered
(the marker does not blank out the `covers:` claim it sits below) — it is the malformed-fragment
report that reds, not a manufactured "uncovered commit" one. `--validate` is the one that matters:
it is the step CI runs unconditionally, with no `skip-changelog` door. Fix it one of two ways:

- **Rewrite the bullet for a human, then delete the comment.** The `covers:` declaration needs no
  changes — it is correct as written and stays byte-identical to the commit subject on purpose.
- **Delete the whole fragment** if the change turns out not to be user-facing after all. The hook
  cannot know that; it only pattern-matches the commit prefix.

This is the normal shape of the workflow, not an edge case: commit, let the hook seed a fragment,
then curate it before opening the PR — exactly what "By hand" above already asks for. The marker
just makes skipping that step loud instead of silent.

**The guard's real limit.** This is a comment, not a lock: deleting the marker line without
touching the entry below it defeats the guard completely, and nothing else notices. That is a
deliberate honor-system boundary, not an oversight — the alternative is inspecting prose for
"has a human actually read this," which no tool can do. The guard's job is narrower and
achievable: make skipping the rewrite step loud (a stray marker) instead of silent (nothing).
One more edge worth knowing: because the check matches the marker by a literal substring, a
fragment that quotes the token `dorkos-changelog:seeded` itself — describing this very guard, say
— would trip the check on prose that was, in fact, written by a human. Rare enough to live with.

## Embedding product media

A fragment or release note may embed real product media (the same seeded-from-the-real-UI
screenshots and loops the marketing site and docs use) via an **absolute URL**:

- **Current** (always the latest capture): `https://dorkos.ai/product/<file>` — e.g.
  `https://dorkos.ai/product/topology-light.png` or `…/topology-dark.webm`.
- **Frozen at a release** (immutable, safe for a note that must not drift): archive the
  release's shots first (`pnpm --filter @dorkos/e2e capture:archive <version> --shots …`),
  then link `https://dorkos.ai/product/archive/<version>/<file>`.

The shot ids and file names are the ones in the shot registry (`apps/e2e/capture/shots.ts`,
published in `apps/site/public/product/manifest.json`). See the
`capturing-product-media` skill for the full media system.

**GitHub renders PNG/GIF inline but not `.webm`.** A GitHub Release or any markdown that
GitHub renders should embed a shot's poster PNG (`<shot-id>-dark.png` for a loop's poster, or
`<shot-id>-light.png` for a still-only shot) and link the caption to a docs page or `/features`
section for the motion version — never link a bare `.webm` URL as the "see it move" affordance.

`/system:release` automates the archive-at-release step (its media phase, Phase 6.6): it checks
manifest freshness against recent UI-affecting commits, selects the shots a release's notes
embed, and runs `capture:archive` for exactly those before the release commit.

## What happens at release

`/system:release` compiles every fragment in `unreleased/` into the new version section:

1. Collect all fragments, sorted by filename (chronological).
2. For each category in standard order (Added, Changed, Deprecated, Removed, Fixed,
   Security), merge every bullet from every fragment under a single heading. Fixes to
   bugs introduced since the last tag are dropped here (or folded into the feature's own
   entry) — no user ever saw those bugs, so the feature simply ships working (rule and
   rationale: the `writing-changelogs` skill). `covers:` frontmatter is build metadata
   for the PR check: it never reaches `CHANGELOG.md`.
3. Write that as `## [X.Y.Z] - YYYY-MM-DD` at the top of `CHANGELOG.md`.
4. Delete the compiled fragment files in the release commit.
5. Keep the 10 most recent versions in `CHANGELOG.md`; move any older section (with its
   link-reference) into a file under `archive/`.

Only the release process writes `CHANGELOG.md`.
