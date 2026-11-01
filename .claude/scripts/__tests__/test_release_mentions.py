#!/usr/bin/env python3
"""Tests for the bare-mention check on release notes.

Hermetic like its neighbour: every file lives in a temp dir, and nothing reads
this repo's real changelog. Run with:

    python3 .claude/scripts/__tests__/test_release_mentions.py
"""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

# No __pycache__ in .claude/scripts/: it is not gitignored.
sys.dont_write_bytecode = True
SCRIPT = Path(__file__).resolve().parent.parent / "release_mentions.py"
sys.path.insert(0, str(SCRIPT.parent))

import changelog_backfill  # noqa: E402 — sys.path must be set up first
import release_mentions  # noqa: E402 — sys.path must be set up first


def handles(text: str) -> list[str]:
    """Return the handles found in a markdown string."""
    return [m.handle for m in release_mentions.find_mentions(text.split("\n"))]


class TestRefused(unittest.TestCase):
    """The shapes GitHub turns into a real ping."""

    def test_the_v0_129_0_wording_is_refused(self):
        self.assertEqual(handles("- Say cc @ana @bo to copy them, or every @name."), ["ana", "bo", "name"])

    def test_punctuation_around_a_handle_does_not_hide_it(self):
        for text in ("(@ana)", "**@ana**", '"@ana"', "@ana.", "@ana,", ".@ana", "> @ana", "[@ana](#x)"):
            with self.subTest(text=text):
                self.assertEqual(handles(text), ["ana"])

    def test_a_hyphenated_handle_is_named_whole(self):
        self.assertEqual(handles("thanks @some-person"), ["some-person"])

    def test_an_unmatched_backtick_protects_nothing(self):
        self.assertEqual(handles("a ` stray tick and @ana"), ["ana"])

    def test_outside_the_backticks_on_a_line_with_code_is_still_refused(self):
        self.assertEqual(handles("`@safe` but @ana"), ["ana"])

    def test_after_a_closed_fence_is_refused_again(self):
        self.assertEqual(handles("```\n@safe\n```\n@ana"), ["ana"])


class TestAllowed(unittest.TestCase):
    """The shapes GitHub leaves alone."""

    def test_inline_code(self):
        for text in ("`cc @ana`", "``@ana ` here``", "use `@ana` and `@bo`"):
            with self.subTest(text=text):
                self.assertEqual(handles(text), [])

    def test_fenced_blocks(self):
        for text in (
            "```\n@ana\n```",
            "~~~md\n@ana\n~~~",
            "  ```\n  @ana\n  ```",
            "````\n```\n@ana\n````",
            "```\n@ana never closed",
            "~~~\n```\n@ana\n~~~",
        ):
            with self.subTest(text=text):
                self.assertEqual(handles(text), [])

    def test_npm_scopes_emails_versions_urls_and_escapes(self):
        for text in (
            "@dork-labs/cloud-api",
            "bump @anthropic-ai/claude-agent-sdk to 1.0",
            "write to me@example.com",
            "first.last+tag@example.com",
            "npm i dorkos@latest",
            "dorkos@1.2.3",
            "https://www.npmjs.com/package/@dork-labs/ui",
            "https://example.com/@ana",
            r"\@ana",
            "a lone @ sign",
        ):
            with self.subTest(text=text):
                self.assertEqual(handles(text), [])


class TestLineNumbers(unittest.TestCase):
    def test_the_line_is_reported(self):
        found = release_mentions.find_mentions(["fine", "", "cc @ana"])
        self.assertEqual(found, [release_mentions.Mention(3, "ana")])

    def test_the_message_names_the_line_and_the_fix(self):
        message = release_mentions.describe(release_mentions.Mention(3, "ana"))
        self.assertIn("line 3", message)
        self.assertIn("`@ana`", message)
        self.assertIn("backticks", message)


class TestCommandLine(unittest.TestCase):
    """The form `/system:release` actually runs."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)

    def run_script(self, text: str, *args: str) -> subprocess.CompletedProcess:
        path = self.dir / "notes.md"
        path.write_text(text, encoding="utf-8")
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPT), str(path), *args],
            capture_output=True,
            text=True,
        )

    def test_clean_notes_pass_silently(self):
        result = self.run_script("# v1\n\n- Use `@ana` to ask\n")
        self.assertEqual((result.returncode, result.stderr), (0, ""))

    def test_a_mention_fails_and_says_where(self):
        result = self.run_script("# v1\n\n- cc @ana\n")
        self.assertEqual(result.returncode, 1)
        self.assertIn("line 3", result.stderr)
        self.assertIn("backticks", result.stderr)

    def test_section_checks_only_that_version_with_real_line_numbers(self):
        changelog = "## [2.0.0]\n\n- fine\n\n## [1.0.0]\n\n- old @ana\n"
        self.assertEqual(self.run_script(changelog, "--section", "2.0.0").returncode, 0)
        result = self.run_script(changelog, "--section", "1.0.0")
        self.assertEqual(result.returncode, 1)
        self.assertIn("line 7", result.stderr)

    def test_a_missing_section_is_an_error_never_a_pass(self):
        result = self.run_script("## [1.0.0]\n", "--section", "9.9.9")
        self.assertEqual(result.returncode, 2)
        self.assertIn("9.9.9", result.stderr)

    def test_a_missing_file_is_an_error_never_a_pass(self):
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), str(self.dir / "nope.md")],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 2)


class TestFragmentGate(unittest.TestCase):
    """The PR-time half: a fragment with a mention fails `--validate`."""

    def test_a_mention_is_a_problem_that_keeps_the_covers_claim(self):
        problems = changelog_backfill.classify_fragment_problems(["### Added", "", "- cc @ana"])
        self.assertEqual(len(problems), 1)
        self.assertIn("`@ana`", problems[0].message)
        self.assertIn("backticks", problems[0].message)
        # The declaration is fine; only the prose needs fixing.
        self.assertFalse(problems[0].suppresses_claims)

    def test_backticks_clear_it(self):
        self.assertEqual(
            changelog_backfill.classify_fragment_problems(["### Added", "", "- cc `@ana`"]),
            [],
        )


if __name__ == "__main__":
    unittest.main()
