#!/usr/bin/env python3
"""
test_changelog_backfill.py - tests for the changelog fragment gate (DOR-387).

The gate these cover (`changelog_backfill.py --check`) used to decide coverage by
word overlap between a commit subject and a fragment's prose, so curating a
fragment for a human — the thing fragments exist for — was the most common way to
turn CI red. Coverage is now a declared fact (`covers:` frontmatter), with word
overlap surviving only as a fallback. These tests pin both halves of that
contract, plus the invariant that matters most: a user-facing commit with no
fragment at all still fails.

Every case builds a REAL throwaway git repo in a temp dir and runs the analyzer
against it as a subprocess, exactly as CI does — no mocked git, no monkeypatched
internals.

**Hermetic by requirement.** Nothing here reads this repo's real
`changelog/unreleased/` or commit history. This suite runs in CI on every PR
including `skip-changelog` ones, so a test that depended on live repo state could
red-light an unrelated PR that is meant to be unblockable. `REPO_ROOT` is used
only to locate the analyzer and the hook. A one-time migration proof against the
real fragment set belongs in the PR body, not in a permanent gate.

Run:
    python3 .claude/scripts/__tests__/test_changelog_backfill.py

Also runs in CI (.github/workflows/changelog-fragment-check.yml), so the gate is
guarded by its own tests. Pure stdlib: no install step.
"""

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / ".claude" / "scripts" / "changelog_backfill.py"

# A deterministic git identity + environment, so the tests never depend on the
# machine's git config or on a global hooks path that would fire our own hooks.
GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.com",
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_SYSTEM": os.devnull,
}


class Repo:
    """A throwaway git repo with a changelog/unreleased/ directory."""

    def __init__(self, path: Path):
        self.path = path
        self.unreleased = path / "changelog" / "unreleased"
        self.unreleased.mkdir(parents=True)
        self.git("init", "-q", "-b", "main")
        self.write("README.md", "seed\n")
        self.git("add", "-A")
        self.git("commit", "-qm", "chore: seed")
        self.base = self.rev_parse("HEAD")

    def git(self, *args: str) -> str:
        result = subprocess.run(
            ["git", *args],
            cwd=self.path,
            env=GIT_ENV,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AssertionError(f"git {' '.join(args)} failed:\n{result.stderr}")
        return result.stdout

    def rev_parse(self, ref: str) -> str:
        return self.git("rev-parse", ref).strip()

    def write(self, relative: str, content: str) -> None:
        target = self.path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def commit(self, subject: str, touch: str = "src/app.ts") -> str:
        """Commit a real file change under `subject`. Returns the new SHA."""
        self.write(touch, f"// {subject}\n")
        self.git("add", "-A")
        self.git("commit", "-qm", subject)
        return self.rev_parse("HEAD")

    def subject(self, ref: str = "HEAD") -> str:
        """HEAD's subject as git renders it (%s folds a wrapped subject)."""
        return self.git("log", "-1", "--pretty=%s", ref).strip()

    def fragment(self, name: str, content: str) -> Path:
        path = self.unreleased / name
        path.write_text(content)
        return path

    def commit_fragment(self, name: str, content: str, subject: str) -> Path:
        """Write a fragment and commit it, so `git diff base..HEAD` can see it.

        `--changed-only` compares committed state, which is what CI has.
        """
        path = self.fragment(name, content)
        self.git("add", "-A")
        self.git("commit", "-qm", subject)
        return path

    def validate(self, *extra: str) -> subprocess.CompletedProcess:
        """Run the validity-only check, as CI's always-on step does."""
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--since", self.base, "--validate", *extra],
            cwd=self.path,
            env=GIT_ENV,
            capture_output=True,
            text=True,
        )

    def check(self, *extra: str) -> subprocess.CompletedProcess:
        """Run `changelog_backfill.py --check --since <base>` as CI does."""
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--since",
                self.base,
                "--check",
                *extra,
            ],
            cwd=self.path,
            env=GIT_ENV,
            capture_output=True,
            text=True,
        )

    def analyze(self, *extra: str) -> dict:
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--since", self.base, "--json", *extra],
            cwd=self.path,
            env=GIT_ENV,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AssertionError(f"analyzer failed:\n{result.stderr}")
        return json.loads(result.stdout)


class GateTestCase(unittest.TestCase):
    """Base class handing each test a fresh throwaway repo."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="changelog-gate-")
        self.repo = Repo(Path(self._tmp.name) / "repo")
        self.addCleanup(self._tmp.cleanup)


class TestDeclaredCoverage(GateTestCase):
    """A fragment that declares what it covers is believed, whatever its prose."""

    def test_subject_claim_covers_its_commit(self):
        subject = "feat(chat): stream replies without dropping the last token"
        self.repo.commit(subject)
        self.repo.fragment(
            "260725-000000-streaming.md",
            "---\n"
            "covers:\n"
            f'  - "{subject}"\n'
            "---\n"
            "\n"
            "### Added\n"
            "\n"
            "- Replies arrive whole now, right to the final word\n",
        )
        result = self.repo.check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_prose_sharing_no_words_with_the_subject_still_passes(self):
        """The regression this whole change exists for.

        The bullet is rewritten for a human and shares no significant word with
        the commit subject, so word overlap cannot match it. The declaration can.
        """
        subject = "refactor(mesh): hoist unified-scanner traversal into a generator"
        self.repo.commit(subject)
        self.repo.fragment(
            "260725-000001-faster-startup.md",
            "---\n"
            "covers:\n"
            f'  - "{subject}"\n'
            "---\n"
            "\n"
            "### Changed\n"
            "\n"
            "- Opening a big vault feels quicker\n",
        )
        analysis = self.repo.analyze()
        self.assertEqual(analysis["missing_entries"], [])
        self.assertEqual(analysis["coverage"][0]["by"], "declared")

    def test_short_and_full_sha_claims_both_cover(self):
        sha = self.repo.commit("fix(server): return 404 for a deleted session")
        for name, claim in (("short.md", sha[:7]), ("full.md", sha)):
            with self.subTest(claim=name):
                self.repo.fragment(
                    f"260725-000002-{name}",
                    f"---\ncovers:\n  - {claim}\n---\n\n### Fixed\n\n- Nothing to see here\n",
                )
                self.assertEqual(self.repo.check().returncode, 0)
                (self.repo.unreleased / f"260725-000002-{name}").unlink()

    def test_inline_flow_sequence_is_accepted(self):
        sha = self.repo.commit("fix(cli): honour --port on the dogfood command")
        self.repo.fragment(
            "260725-000003-inline.md",
            f"---\ncovers: [{sha[:8]}]\n---\n\n### Fixed\n\n- Ports behave\n",
        )
        self.assertEqual(self.repo.check().returncode, 0)

    def test_one_fragment_can_claim_several_commits(self):
        first = "feat(tasks): schedule a task from the composer"
        second = "fix(tasks): keep the next-run column sorted"
        self.repo.commit(first)
        self.repo.commit(second)
        self.repo.fragment(
            "260725-000004-tasks.md",
            "---\n"
            "covers:\n"
            f'  - "{first}"\n'
            f'  - "{second}"\n'
            "---\n"
            "\n"
            "### Added\n"
            "\n"
            "- Schedule a task straight from the message box\n",
        )
        self.assertEqual(self.repo.check().returncode, 0)

    def test_a_subject_containing_a_double_quote_round_trips(self):
        subject = 'fix(chat): stop rendering "undefined" in the status strip'
        self.repo.commit(subject)
        escaped = subject.replace('"', '\\"')
        self.repo.fragment(
            "260725-000005-quotes.md",
            f'---\ncovers:\n  - "{escaped}"\n---\n\n### Fixed\n\n- The strip stays quiet\n',
        )
        self.assertEqual(self.repo.check().returncode, 0, self.repo.check().stderr)


class TestLegacyFallback(GateTestCase):
    """Fragments already on disk carry no declaration and must keep working."""

    def test_undeclared_fragment_is_still_matched_by_word_overlap(self):
        self.repo.commit("feat(agents): show a runtime badge on every agent row")
        self.repo.fragment(
            "260725-000010-legacy.md",
            "### Added\n\n- Show a runtime badge on every agent row\n",
        )
        analysis = self.repo.analyze()
        self.assertEqual(analysis["missing_entries"], [])
        self.assertEqual(analysis["coverage"][0]["by"], "word-overlap")

    def test_a_declaration_that_matches_nothing_keeps_the_fallback(self):
        """Stale declarations must not cost a fragment its old behaviour.

        A rebase rewrites every SHA and an amended subject changes the subject,
        so a declaration can go stale on a branch that was passing. When none of
        a fragment's claims resolve, it degrades to exactly an undeclared
        fragment instead of turning the gate red.
        """
        self.repo.commit("feat(agents): show a runtime badge on every agent row")
        self.repo.fragment(
            "260725-000011-stale.md",
            "---\n"
            "covers:\n"
            '  - "feat(agents): a subject that was rebased away"\n'
            "---\n"
            "\n"
            "### Added\n"
            "\n"
            "- Show a runtime badge on every agent row\n",
        )
        analysis = self.repo.analyze()
        self.assertEqual(analysis["missing_entries"], [])
        self.assertEqual(analysis["coverage"][0]["by"], "word-overlap")
        self.assertEqual(len(analysis["unresolved_claims"]), 1)

    def test_a_resolved_declaration_removes_that_fragment_from_the_fuzzy_pool(self):
        """A fragment that claims one commit does not silently cover a second.

        This is the "do not weaken the gate" half: once a declaration resolves,
        the fragment's prose stops being a fuzzy wildcard, so a second commit
        needs its own claim (or its own fragment).
        """
        claimed = "feat(agents): show a runtime badge on every agent row"
        self.repo.commit(claimed)
        self.repo.commit("feat(agents): show a runtime badge on every agent card")
        self.repo.fragment(
            "260725-000012-partial.md",
            "---\n"
            "covers:\n"
            f'  - "{claimed}"\n'
            "---\n"
            "\n"
            "### Added\n"
            "\n"
            "- Show a runtime badge on every agent row\n",
        )
        result = self.repo.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("agent card", result.stderr)


class TestGateStillBites(GateTestCase):
    """The gate must keep failing the cases it was built to catch."""

    def test_a_user_facing_commit_with_no_fragment_fails(self):
        self.repo.commit("feat(client): add a keyboard shortcut for the composer")
        result = self.repo.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("changelog gate FAILED", result.stderr)

    def test_an_empty_unreleased_dir_fails_a_user_facing_commit(self):
        for fragment in self.repo.unreleased.glob("*.md"):
            fragment.unlink()
        self.repo.commit("fix(server): stop leaking a session lock on disconnect")
        self.assertEqual(self.repo.check().returncode, 1)

    def test_non_user_facing_commits_never_fail(self):
        self.repo.commit("chore(deps): bump vite")
        self.repo.commit("docs(readme): fix a typo")
        self.repo.commit("ci: pin the runner image")
        self.assertEqual(self.repo.check().returncode, 0)

    def test_frontmatter_list_items_are_not_mistaken_for_entry_bullets(self):
        """A `covers:` item must never leak into the word-overlap pool.

        Frontmatter items start with "- " like an entry bullet does. If they were
        collected as entries, a fragment declaring subject X would fuzzily cover
        every commit resembling X — a false green.
        """
        self.repo.commit("feat(client): add a keyboard shortcut for the composer")
        self.repo.fragment(
            "260725-000020-elsewhere.md",
            "---\n"
            "covers:\n"
            '  - "feat(client): add a keyboard shortcut for the composer"\n'
            "---\n"
            "\n"
            "### Added\n"
            "\n"
            "- Something unrelated\n",
        )
        # Sanity: the declaration covers it.
        self.assertEqual(self.repo.check().returncode, 0)
        # Now break only the declaration. Nothing else may cover the commit.
        self.repo.fragment(
            "260725-000020-elsewhere.md",
            "---\n"
            "covers:\n"
            '  - "feat(client): a totally different subject"\n'
            "---\n"
            "\n"
            "### Added\n"
            "\n"
            "- Something unrelated\n",
        )
        self.assertEqual(self.repo.check().returncode, 1)


class TestMalformedFragments(GateTestCase):
    """A broken declaration must fail loudly, never become a fuzzy wildcard.

    When the frontmatter delimiters are wrong, the claim lines land in the body.
    A raw commit subject sitting there as a bullet matches almost any similar
    commit under word overlap, so the gate would pass on a change nobody wrote
    about — and Prettier reformats the typo into something that looks deliberate,
    making the wildcard permanent.
    """

    # Two subjects one word apart: word overlap cannot tell them apart.
    FIRST = "feat(server): enforce capability tiers with approval gating"
    SECOND = "feat(server): enforce capability tiers without approval gating"

    def commit_both(self) -> None:
        self.repo.commit(self.FIRST, touch="apps/server/src/a.ts")
        self.repo.commit(self.SECOND, touch="apps/server/src/b.ts")

    def test_well_formed_fragment_covers_only_what_it_claims(self):
        """The control: with the closing `---` present, the gate is correct."""
        self.commit_both()
        self.repo.fragment(
            "260725-000050-tiers.md",
            f'---\ncovers:\n  - "{self.FIRST}"\n---\n\n### Added\n\n- Tiers gate what agents may do\n',
        )
        result = self.repo.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("without approval gating", result.stderr)

    def test_a_missing_closing_delimiter_fails_instead_of_covering_everything(self):
        """The false green ARGUS built: omit the closing `---` and both pass."""
        self.commit_both()
        self.repo.fragment(
            "260725-000051-tiers.md",
            f'---\ncovers:\n  - "{self.FIRST}"\n\n### Added\n\n- Tiers gate what agents may do\n',
        )
        result = self.repo.check()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("malformed fragment", result.stderr)
        self.assertIn("260725-000051-tiers.md", result.stderr)
        # And the stranded claim never reached the word-overlap pool, so the
        # commit it named is reported uncovered rather than silently covered.
        analysis = self.repo.analyze()
        self.assertEqual(analysis["coverage"], [])
        self.assertEqual(len(analysis["missing_entries"]), 2)

    def test_a_covers_key_in_the_body_fails(self):
        self.repo.commit(self.FIRST, touch="apps/server/src/a.ts")
        self.repo.fragment(
            "260725-000052-tiers.md",
            f'### Added\n\ncovers:\n  - "{self.FIRST}"\n\n- Tiers gate what agents may do\n',
        )
        result = self.repo.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("appears in the body", result.stderr)

    def test_a_bare_sha_bullet_in_the_body_fails(self):
        sha = self.repo.commit(self.FIRST, touch="apps/server/src/a.ts")
        self.repo.fragment(
            "260725-000053-tiers.md",
            f"### Added\n\n- {sha[:9]}\n- Tiers gate what agents may do\n",
        )
        result = self.repo.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("stranded in", result.stderr)

    def test_an_invalid_heading_fails_the_gate(self):
        """DOR-1635: `### Docs` is not an allowed heading. Third sighting of
        this exact mistake in one program; the gate must catch it, not a
        careful reader at release time.
        """
        self.repo.commit(self.FIRST, touch="apps/server/src/a.ts")
        self.repo.fragment(
            "260725-000055-tiers.md",
            "### Docs\n\n- Tiers gate what agents may do\n",
        )
        result = self.repo.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "not a heading release.md's compile step knows to merge", result.stderr
        )

    def test_the_established_upgrading_note_heading_passes_the_gate(self):
        """DOR-1635 should-fix: `### Note for people upgrading` is not a Keep
        a Changelog category, but established repo practice (it has shipped
        in CHANGELOG.md three times) — it must not be treated the same as an
        invented heading like `### Docs` above.
        """
        sha = self.repo.commit(self.FIRST, touch="apps/server/src/a.ts")
        self.repo.fragment(
            "260725-000056-tiers.md",
            f'---\ncovers:\n  - "{self.FIRST}"\n---\n\n'
            "### Added\n\n- Tiers gate what agents may do\n\n"
            "### Note for people upgrading\n\n"
            "- Nothing changes until you turn tiers on\n",
        )
        result = self.repo.validate()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_a_malformed_fragment_fails_even_when_nothing_is_uncovered(self):
        """Nothing to cover, but the wildcard is still on disk. Fail anyway."""
        self.repo.commit("chore: nothing user-facing here")
        self.repo.fragment(
            "260725-000054-broken.md",
            f'---\ncovers:\n  - "{self.FIRST}"\n\n### Added\n\n- A thing\n',
        )
        result = self.repo.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("malformed fragment", result.stderr)
        self.assertIn("0 uncovered", result.stdout)

    def test_a_leading_bom_or_blank_line_is_tolerated_not_broken(self):
        """These are invisible in an editor, so parse them rather than fail."""
        for name, prefix in (("bom", "﻿"), ("blank", "\n")):
            with self.subTest(prefix=name):
                subject = f"feat(client): tolerate a {name} prefix"
                self.repo.commit(subject, touch=f"apps/client/src/{name}.ts")
                self.repo.fragment(
                    f"260725-000055-{name}.md",
                    f'{prefix}---\ncovers:\n  - "{subject}"\n---\n\n### Added\n\n- Something\n',
                )
        result = self.repo.check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_prettier_normalized_output_is_still_refused(self):
        """Hermetic twin of the test below, for CI, which has no node_modules.

        This is byte-for-byte what `prettier --write` makes of the malformed
        fragment: the delimiter becomes a thematic break, `covers:` becomes a
        paragraph, and the claim becomes a top-level bullet. It renders as clean
        markdown and Prettier then reports it formatted, which is exactly how the
        mistake would become permanent. It must still be refused.
        """
        self.commit_both()
        self.repo.fragment(
            "260725-000057-tiers.md",
            "---\n"
            "\n"
            "covers:\n"
            "\n"
            f'- "{self.FIRST}"\n'
            "\n"
            "### Added\n"
            "\n"
            "- Tiers gate what agents may do\n",
        )
        result = self.repo.check()
        self.assertEqual(result.returncode, 1)
        self.assertIn("malformed fragment", result.stderr)
        self.assertEqual(self.repo.analyze()["coverage"], [])

    def test_prettier_does_not_launder_the_mistake_past_the_gate(self):
        """The live version of the test above: run real Prettier, then re-check.

        Skips where Prettier is not installed (CI runs this workflow without a
        `pnpm install`), which is why the hermetic twin exists.
        """
        self.commit_both()
        path = self.repo.fragment(
            "260725-000056-tiers.md",
            f'---\ncovers:\n  - "{self.FIRST}"\n\n### Added\n\n- Tiers gate what agents may do\n',
        )
        prettier = subprocess.run(
            ["npx", "--no-install", "prettier", "--write", str(path)],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        if prettier.returncode != 0:
            self.skipTest(f"prettier unavailable: {prettier.stderr.strip()[:120]}")
        result = self.repo.check()
        self.assertEqual(result.returncode, 1, path.read_text())
        self.assertIn("malformed fragment", result.stderr)


class TestValidityScope(GateTestCase):
    """Validity is scoped to the PR's own diff; coverage keeps its own bypass.

    The two questions have different audiences. A broken `covers:` block is the
    defect of whoever wrote it and must be caught even on a PR that owes no
    changelog entry, because its declaration is ignored and it therefore claims
    nothing — contagious if it lands. But a stray broken fragment already on main
    must never fail an author who did not touch it. Running validity and coverage
    as one step forced one scope on both: the `skip-changelog` bypass let the
    defect in, and the repo-wide read then charged the next innocent PR for it.
    """

    BROKEN = '---\ncovers:\n  - "feat(server): a claim with no closing delimiter"\n\n### Added\n\n- A thing\n'

    def test_a_pr_that_touches_a_malformed_fragment_fails_the_validity_step(self):
        """Edge one: the skip-changelog door is closed.

        This is the step CI runs with no label guard, so this failure happens even
        for a PR that owes no changelog entry.
        """
        self.repo.commit_fragment(
            "260725-000080-broken.md", self.BROKEN, "chore: add a broken fragment"
        )
        result = self.repo.validate("--changed-only")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("malformed fragment", result.stderr)
        self.assertIn("260725-000080-broken.md", result.stderr)

    def test_a_pr_touching_no_fragment_passes_despite_a_stray_and_names_it(self):
        """Edge two: an innocent PR is not charged for someone else's file.

        The stray is committed BEFORE the branch point, so it is on "main" as far
        as this PR is concerned.
        """
        self.repo.commit_fragment(
            "260725-000081-stray.md", self.BROKEN, "chore: a stray from an earlier PR"
        )
        # Re-base the comparison: everything above is now "already on main".
        self.repo.base = self.repo.rev_parse("HEAD")
        self.repo.commit("docs(readme): tidy a sentence", touch="docs/readme.md")

        result = self.repo.validate("--changed-only")
        self.assertEqual(result.returncode, 0, result.stderr)
        # Silence would be worse than failing, so it is still named.
        self.assertIn("NOTE:", result.stdout)
        self.assertIn("260725-000081-stray.md", result.stdout)
        self.assertIn("did not write", result.stdout)

    def test_the_coverage_step_is_not_failed_by_a_stray_either(self):
        """The same scoping applies to `--check`, or the shared red comes back."""
        self.repo.commit_fragment(
            "260725-000082-stray.md", self.BROKEN, "chore: a stray from an earlier PR"
        )
        self.repo.base = self.repo.rev_parse("HEAD")
        subject = "feat(client): a well-covered change"
        self.repo.commit(subject, touch="apps/client/src/x.ts")
        self.repo.commit_fragment(
            "260725-000083-good.md",
            f'---\ncovers:\n  - "{subject}"\n---\n\n### Added\n\n- Something nice\n',
            "chore: add the fragment",
        )
        result = self.repo.check("--changed-only")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("260725-000082-stray.md", result.stdout)

    def test_a_bare_local_run_still_validates_everything_on_disk(self):
        """The local signal stays strict: no --changed-only means no exemptions."""
        self.repo.commit_fragment(
            "260725-000084-stray.md", self.BROKEN, "chore: a stray from an earlier PR"
        )
        self.repo.base = self.repo.rev_parse("HEAD")
        self.repo.commit("docs(readme): tidy a sentence", touch="docs/readme.md")

        self.assertEqual(self.repo.validate("--changed-only").returncode, 0)
        strict = self.repo.validate()
        self.assertEqual(strict.returncode, 1, strict.stdout)
        self.assertIn("260725-000084-stray.md", strict.stderr)

    def test_validate_ignores_coverage_entirely(self):
        """An uncovered commit is not this step's business."""
        self.repo.commit("feat(client): a change with no fragment at all")
        self.assertEqual(self.repo.check().returncode, 1)
        result = self.repo.validate("--changed-only")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("validity", result.stdout)

    def test_a_malformed_fragment_claims_nothing_while_broken(self):
        """Why a stray is contagious, and why the NOTE says so.

        Its declaration is ignored, so the commit it meant to claim reads as
        uncovered. That is the failure the next author would otherwise inherit with
        no explanation.
        """
        subject = "feat(server): a claim with no closing delimiter"
        self.repo.commit(subject, touch="apps/server/src/x.ts")
        self.repo.fragment("260725-000085-broken.md", self.BROKEN)
        analysis = self.repo.analyze()
        self.assertEqual(analysis["coverage"], [])
        self.assertEqual(len(analysis["missing_entries"]), 1)


class TestSquashMergedSubjects(GateTestCase):
    """GitHub appends " (#123)" when it squashes, so compare without it."""

    def test_a_claim_still_matches_after_the_pr_number_is_appended(self):
        self.repo.commit("feat(server): capability registry core (DOR-440) (#436)")
        self.repo.fragment(
            "260725-000060-registry.md",
            '---\ncovers:\n  - "feat(server): capability registry core (DOR-440)"\n---\n'
            "\n### Added\n\n- Browse everything DorkOS can do\n",
        )
        result = self.repo.check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_it_matches_in_the_other_direction_too(self):
        self.repo.commit("feat(server): capability registry core (DOR-440)")
        self.repo.fragment(
            "260725-000061-registry.md",
            '---\ncovers:\n  - "feat(server): capability registry core (DOR-440) (#436)"\n---\n'
            "\n### Added\n\n- Browse everything DorkOS can do\n",
        )
        self.assertEqual(self.repo.check().returncode, 0)


class TestClaimsOnSkippedCommits(GateTestCase):
    """Claiming a chore commit costs the fragment its fallback. Say so."""

    def test_the_diagnostic_names_the_claim_that_caused_the_red(self):
        self.repo.commit("chore(deps): bump vite")
        chore = self.repo.subject()
        self.repo.commit("feat(client): remember the last panel you had open")
        self.repo.fragment(
            "260725-000070-oops.md",
            f'---\ncovers:\n  - "{chore}"\n---\n'
            "\n### Added\n"
            "\n- Remember the last panel you had open\n",
        )
        result = self.repo.check()
        # Red, because the fragment is declared (so no word-overlap fallback) and
        # its declaration points at a commit this gate ignores.
        self.assertEqual(result.returncode, 1)
        self.assertIn("resolved against a commit", result.stderr)
        self.assertIn("260725-000070-oops.md", result.stderr)
        analysis = self.repo.analyze()
        self.assertEqual(len(analysis["claims_on_skipped_commits"]), 1)


class TestUnresolvableDeclarations(GateTestCase):
    """A declaration naming a commit that does not exist is a note, never a red.

    Declarations go stale for legitimate reasons all the time: fragments from
    already-merged PRs sit in `changelog/unreleased/` until release, and their
    claims name commits behind the merge-base. Failing on them would reintroduce
    exactly the probabilistic red this change removes. They are reported, not
    enforced.
    """

    def test_a_nonexistent_sha_claim_does_not_fail_the_gate(self):
        self.repo.commit("feat(client): add a keyboard shortcut for the composer")
        self.repo.fragment(
            "260725-000030-real.md",
            "---\n"
            "covers:\n"
            '  - "feat(client): add a keyboard shortcut for the composer"\n'
            "---\n"
            "\n"
            "### Added\n"
            "\n"
            "- Press a key, get a composer\n",
        )
        self.repo.fragment(
            "260725-000031-ghost.md",
            "---\ncovers:\n  - deadbeefdeadbeef\n---\n\n### Fixed\n\n- From an earlier PR\n",
        )
        result = self.repo.check()
        self.assertEqual(result.returncode, 0, result.stderr)
        analysis = self.repo.analyze()
        self.assertEqual(
            analysis["unresolved_claims"],
            [{"fragment": "260725-000031-ghost.md", "claim": "deadbeefdeadbeef"}],
        )


class TestPullRequestClaims(GateTestCase):
    """`#N` claims cover a whole PR, but only when the PR number is supplied."""

    def test_pr_claim_covers_every_commit_when_pr_matches(self):
        self.repo.commit("feat(server): capability registry core")
        self.repo.commit("feat(client): capability browser")
        self.repo.commit("fix(server): tighten the capability schema")
        self.repo.fragment(
            "260725-000040-registry.md",
            '---\ncovers:\n  - "#460"\n---\n\n### Added\n'
            "\n- Browse everything DorkOS can do, in one place\n",
        )
        self.assertEqual(self.repo.check("--pr", "460").returncode, 0)

    def test_pr_claim_is_inert_without_the_pr_flag(self):
        self.repo.commit("feat(server): capability registry core")
        self.repo.fragment(
            "260725-000041-registry.md",
            '---\ncovers:\n  - "#460"\n---\n\n### Added\n\n- Browse capabilities\n',
        )
        self.assertEqual(self.repo.check().returncode, 1)

    def test_a_different_pr_number_does_not_cover(self):
        self.repo.commit("feat(server): capability registry core")
        self.repo.fragment(
            "260725-000042-registry.md",
            '---\ncovers:\n  - "#460"\n---\n\n### Added\n\n- Browse capabilities\n',
        )
        self.assertEqual(self.repo.check("--pr", "461").returncode, 1)

    def test_a_blanket_claim_names_every_commit_it_swept_up(self):
        """A blanket pass is allowed, but never silent.

        ARGUS's case: three unrelated user-facing changes, one fragment describing
        only the first, `covers: ["#999"]`. The gate passes by design, so the
        passing summary must name the two commits that shipped with no prose and
        point at the honest tool for a whole-PR opt-out.
        """
        self.repo.commit("feat(client): a slash command palette")
        self.repo.commit("feat(server): delete every session on logout")
        self.repo.commit("fix(billing): charge the right card")
        self.repo.fragment(
            "260725-000043-palette.md",
            '---\ncovers:\n  - "#999"\n---\n\n### Added\n\n- Run any command from one box\n',
        )
        result = self.repo.check("--pr", "999")
        self.assertEqual(result.returncode, 0)
        self.assertIn("PR-level claim", result.stdout)
        self.assertIn("delete every session on logout", result.stdout)
        self.assertIn("charge the right card", result.stdout)
        self.assertIn("skip-changelog", result.stdout)

    def test_a_specific_claim_wins_attribution_over_a_blanket(self):
        """Specific claims resolve first, so the blanket report is precise."""
        named = "feat(client): a slash command palette"
        self.repo.commit(named)
        self.repo.commit("fix(billing): charge the right card")
        self.repo.fragment(
            "260725-000044-palette.md",
            f'---\ncovers:\n  - "{named}"\n---\n\n### Added\n\n- Run any command from one box\n',
        )
        self.repo.fragment(
            "260725-000045-rest.md",
            '---\ncovers:\n  - "#999"\n---\n\n### Fixed\n\n- Assorted billing repairs\n',
        )
        result = self.repo.check("--pr", "999")
        self.assertEqual(result.returncode, 0, result.stderr)
        analysis = self.repo.analyze("--pr", "999")
        blanket = analysis["blanket_claims"]
        self.assertEqual(len(blanket), 1)
        self.assertEqual([c["subject"] for c in blanket[0]["commits"]],
                         ["fix(billing): charge the right card"])


class TestFailureMessage(GateTestCase):
    """The failure must be fixable by pasting, with no thinking required."""

    def test_it_names_the_commit_the_claim_line_and_the_file_to_create(self):
        subject = "feat(client): add a keyboard shortcut for the composer"
        self.repo.commit(subject)
        stderr = self.repo.check().stderr

        self.assertIn(subject, stderr)
        # The exact line to paste into an existing fragment.
        self.assertIn(f'- "{subject}"', stderr)
        # A concrete path for a new fragment, plus its ready-made frontmatter.
        self.assertIn("changelog/unreleased/", stderr)
        self.assertIn("add-a-keyboard-shortcut-for-the-compo", stderr)
        self.assertIn("covers:", stderr)
        self.assertIn("### Added", stderr)
        # And the escape hatch, named.
        self.assertIn("skip-changelog", stderr)

    def test_check_keeps_stdout_to_a_one_line_summary(self):
        self.repo.commit("feat(client): add a keyboard shortcut for the composer")
        result = self.repo.check()
        self.assertEqual(len(result.stdout.strip().split("\n")), 1)
        self.assertIn("changelog gate:", result.stdout)


class TestApplyWritesDeclarations(GateTestCase):
    """`--apply` must mint fragments that already satisfy the gate."""

    def test_applied_fragments_pass_the_gate_and_survive_a_prose_rewrite(self):
        self.repo.commit("feat(client): add a keyboard shortcut for the composer")
        subprocess.run(
            [sys.executable, str(SCRIPT), "--since", self.repo.base, "--apply"],
            cwd=self.repo.path,
            env=GIT_ENV,
            capture_output=True,
            text=True,
            check=True,
        )
        written = list(self.repo.unreleased.glob("*.md"))
        self.assertEqual(len(written), 1)
        self.assertIn("covers:", written[0].read_text())
        self.assertEqual(self.repo.check().returncode, 0)

        # Now do the thing that used to break the gate: rewrite the prose.
        text = written[0].read_text()
        head, _, _ = text.partition("### ")
        written[0].write_text(head + "### Added\n\n- Reach the message box from anywhere\n")
        self.assertEqual(self.repo.check().returncode, 0, self.repo.check().stderr)


class TestPopulatorHook(GateTestCase):
    """End to end: the hook mints a fragment that already satisfies the gate.

    This is the common path — a developer commits, the post-commit hook writes and
    amends in the fragment, CI checks the branch. It must need zero human effort,
    and it must keep passing after the fragment's prose is curated for a human.
    """

    HOOK = REPO_ROOT / ".claude" / "git-hooks" / "changelog-populator.py"

    def assert_declares(self, text: str, subject: str) -> None:
        """Assert the fragment declares `subject`, whichever way it is quoted.

        The hook renders double quotes and then hands the file to Prettier, whose
        config prefers single ones (DOR-485). Pinning one style here would pin the
        wrong one the moment Prettier is reachable: these cases build a throwaway
        repo in a temp dir, where `pnpm exec prettier` cannot resolve, so the hook's
        best-effort format step silently no-ops. Both quotings mean the same YAML
        scalar, and `read_yaml_scalar` reads both.
        """
        self.assertRegex(text, r"  - ([\"'])" + re.escape(subject) + r"\1")

    def install_hook(self) -> None:
        hooks_dir = self.repo.path / ".git" / "hooks"
        hooks_dir.mkdir(parents=True, exist_ok=True)
        target = hooks_dir / "post-commit"
        target.write_text(self.HOOK.read_text())
        target.chmod(0o755)

    def test_hook_declares_the_commit_it_covers(self):
        self.install_hook()
        subject = "feat(client): keep the composer reachable from every page"
        # The hook only fires for project paths, so touch one.
        self.repo.commit(subject, touch="apps/client/src/composer.tsx")

        fragments = list(self.repo.unreleased.glob("*.md"))
        self.assertEqual(len(fragments), 1, "the hook should mint exactly one fragment")
        text = fragments[0].read_text()
        self.assert_declares(text, subject)
        # The fragment landed inside the commit, so the gate sees it.
        self.assertIn("changelog/unreleased/", self.repo.git("show", "--name-only", "HEAD"))

        result = self.repo.check()
        self.assertEqual(result.returncode, 0, result.stderr)

        # Curate the prose into something a person would want to read. The gate
        # must not notice.
        fragments[0].write_text(
            text.split("### ")[0] + "### Added\n\n- The message box is one key away, anywhere\n"
        )
        self.repo.git("add", "-A")
        self.repo.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "docs: curate the fragment")
        result = self.repo.check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_hook_declares_a_wrapped_subject_the_way_git_folds_it(self):
        """`%s` folds a subject that wraps without a blank line; so must the hook.

        Taking the first raw line instead would write a declaration that can never
        match its own commit.
        """
        self.install_hook()
        self.repo.write("apps/client/src/wrapped.tsx", "// x\n")
        self.repo.git("add", "-A")
        self.repo.git(
            "commit",
            "-qm",
            "feat(client): keep the composer reachable\nfrom every page in the app",
        )
        folded = self.repo.subject()
        self.assertIn("from every page", folded, "git should fold the wrapped subject")

        fragments = list(self.repo.unreleased.glob("*.md"))
        self.assertEqual(len(fragments), 1)
        self.assert_declares(fragments[0].read_text(), folded)
        result = self.repo.check()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_hook_does_not_double_up_on_a_replay(self):
        """A cherry-pick of a committed change must not mint a second fragment."""
        self.install_hook()
        subject = "fix(server): release the session lock when a client disconnects"
        self.repo.commit(subject, touch="apps/server/src/session.ts")
        self.assertEqual(len(list(self.repo.unreleased.glob("*.md"))), 1)

        original = self.repo.rev_parse("HEAD")
        self.repo.git("reset", "-q", "--hard", self.repo.base)
        self.repo.git("cherry-pick", original)
        self.assertEqual(len(list(self.repo.unreleased.glob("*.md"))), 1)


def load_analyzer():
    """Import the analyzer module for direct unit assertions."""
    # No __pycache__ in .claude/scripts/: it is not gitignored, and a stray
    # untracked directory there is noise in a repo full of concurrent agents.
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(SCRIPT.parent))
    import changelog_backfill  # noqa: PLC0415 — sys.path must be set up first

    return changelog_backfill


class TestParserUnits(unittest.TestCase):
    """Direct unit coverage of the frontmatter parser and claim classifier."""

    @classmethod
    def setUpClass(cls):
        cls.mod = load_analyzer()

    def test_no_frontmatter_means_no_claims_and_a_whole_body(self):
        frontmatter, body = self.mod.split_frontmatter("### Added\n\n- A thing\n")
        self.assertEqual(frontmatter, [])
        self.assertIn("- A thing", body)
        self.assertEqual(self.mod.parse_covers(frontmatter), [])

    def test_an_unterminated_delimiter_yields_no_frontmatter_but_is_flagged(self):
        """The claim lines land in the body, which is why they must be flagged.

        Left unflagged, `- abc1234` and a raw commit subject become word-overlap
        wildcards.
        """
        frontmatter, body = self.mod.split_frontmatter("---\ncovers:\n  - abc1234\n")
        self.assertEqual(frontmatter, [])
        self.assertIn("  - abc1234", body)
        problems = self.mod.find_fragment_problems(body)
        self.assertEqual(len(problems), 2, problems)

    def test_a_real_changelog_bullet_is_never_mistaken_for_a_claim(self):
        body = [
            "### Added",
            "",
            "- Get a Telegram message when your agent finishes a turn (DOR-123)",
            "- Fixed: the composer no longer eats the last word",
            "- **BREAKING**: the old endpoint is gone",
            "- covers your whole fleet now",
            # A fully-quoted bullet quoting a UI string. Reads as "word: text",
            # so a `\\w+:` pattern would flag it as a stranded claim.
            '- "Sort: nothing after it"',
            '- "Cannot be reached"',
            # Eight of the eleven conventional types are ordinary English words
            # that open a quoted label, so a case-INSENSITIVE match would flag
            # these. The false red would be repo-wide and its advice wrong.
            '- "Fix: sign in again"',
            '- "Test: connection failed"',
            '- "Build: 42 succeeded"',
            '- "Style: compact"',
        ]
        self.assertEqual(self.mod.find_fragment_problems(body), [])

    def test_an_invalid_category_heading_is_flagged(self):
        """DOR-1635: a heading outside the allowed set is invisible to
        release.md's compile step, which names its headings explicitly — so
        nothing automatically merges a bullet under any other one, and it
        depends on whoever compiles the release noticing by hand. `### Improved`
        and `### Docs` are both real sightings of this mistake.
        """
        for heading in ("Improved", "Docs", "Security Fixes", "added"):
            with self.subTest(heading=heading):
                problems = self.mod.find_fragment_problems(
                    [f"### {heading}", "", "- Something happened"]
                )
                self.assertEqual(len(problems), 1, problems)
                self.assertIn(f"### {heading}", problems[0])
                self.assertIn(
                    "not a heading release.md's compile step knows to merge",
                    problems[0],
                )

    def test_every_real_category_heading_passes(self):
        for heading in (
            "Added",
            "Changed",
            "Deprecated",
            "Removed",
            "Fixed",
            "Security",
        ):
            with self.subTest(heading=heading):
                problems = self.mod.find_fragment_problems(
                    [f"### {heading}", "", "- Something happened"]
                )
                self.assertEqual(problems, [])

    def test_the_established_upgrading_note_heading_passes(self):
        """Not a Keep a Changelog category, but established repo practice: it
        has shipped in CHANGELOG.md three times (PRs #621, #493, #606) and is
        documented as allowed in changelog/README.md.
        """
        problems = self.mod.find_fragment_problems(
            ["### Note for people upgrading", "", "- Something to know before upgrading"]
        )
        self.assertEqual(problems, [])

    def test_a_real_claim_line_is_still_caught_in_the_body(self):
        """The narrowings above must not blunt the detector itself."""
        for line in (
            '- "feat(server): capability registry core"',
            '- "fix: stop dropping the last token"',
            '- "chore(deps): bump vite"',
            "- deadbeef1234",
            '- "#412"',
        ):
            with self.subTest(line=line):
                self.assertEqual(len(self.mod.find_fragment_problems([line])), 1)

    def test_normalize_subject_strips_only_a_trailing_pr_ref(self):
        self.assertEqual(
            self.mod.normalize_subject("feat(x): a thing (DOR-1) (#436)"),
            "feat(x): a thing (DOR-1)",
        )
        self.assertEqual(
            self.mod.normalize_subject("feat(x): a thing (#436) and more"),
            "feat(x): a thing (#436) and more",
        )

    def test_comments_and_blank_lines_inside_the_list_are_ignored(self):
        frontmatter, _ = self.mod.split_frontmatter(
            "---\ncovers:\n  # why\n\n  - abc1234\n---\n\n### Fixed\n\n- x\n"
        )
        self.assertEqual(self.mod.parse_covers(frontmatter), ["abc1234"])

    def test_claim_shapes_are_classified_by_shape(self):
        self.assertEqual(self.mod.classify_claim("#412"), ("pr", 412))
        self.assertEqual(self.mod.classify_claim("ABC1234".lower()), ("sha", "abc1234"))
        self.assertEqual(
            self.mod.classify_claim("feat(x): a thing"), ("subject", "feat(x): a thing")
        )
        # Too short to be a SHA, so it reads as a subject rather than matching
        # every commit by prefix.
        self.assertEqual(self.mod.classify_claim("abc12"), ("subject", "abc12"))

    def test_quoting_round_trips(self):
        for value in ('a "quoted" subject', "back\\slash", "plain"):
            with self.subTest(value=value):
                self.assertEqual(
                    self.mod.unquote_yaml_scalar(self.mod.quote_yaml_scalar(value)),
                    value,
                )

    def test_inline_items_split_on_commas_outside_quotes(self):
        self.assertEqual(
            self.mod.split_inline_items('abc1234, "feat(x): a, b"'),
            ["abc1234", '"feat(x): a, b"'],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
