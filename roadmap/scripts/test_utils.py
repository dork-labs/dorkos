#!/usr/bin/env python3
"""Unit tests for roadmap utility scripts.

Compatible with Python 3.8+.
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from typing import List, Dict, Optional
from unittest.mock import patch, MagicMock

# Add script directory to path for imports
script_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(script_dir))

from slugify import slugify, get_slug_for_item
from find_by_title import find_by_title
from update_status import validate_transition, VALID_STATUSES, VALID_TRANSITIONS


class TestSlugify(unittest.TestCase):
    """Tests for slugify function."""

    def test_simple_text(self):
        """Simple text converts correctly."""
        self.assertEqual(slugify("Hello World"), "hello-world")

    def test_lowercase(self):
        """Text is converted to lowercase."""
        self.assertEqual(slugify("UPPERCASE"), "uppercase")
        self.assertEqual(slugify("MixedCase"), "mixedcase")

    def test_special_characters_removed(self):
        """Special characters are removed."""
        self.assertEqual(slugify("Hello, World!"), "hello-world")
        self.assertEqual(slugify("Test @#$% chars"), "test-chars")

    def test_underscores_to_hyphens(self):
        """Underscores become hyphens."""
        self.assertEqual(slugify("hello_world"), "hello-world")

    def test_multiple_spaces(self):
        """Multiple spaces become single hyphen."""
        self.assertEqual(slugify("hello   world"), "hello-world")

    def test_multiple_hyphens(self):
        """Multiple hyphens collapse to one."""
        self.assertEqual(slugify("hello---world"), "hello-world")

    def test_leading_trailing_hyphens_removed(self):
        """Leading and trailing hyphens are removed."""
        self.assertEqual(slugify("-hello world-"), "hello-world")
        self.assertEqual(slugify("---test---"), "test")

    def test_realistic_titles(self):
        """Real-world roadmap titles convert correctly."""
        self.assertEqual(
            slugify("Transaction sync and storage"),
            "transaction-sync-and-storage"
        )
        self.assertEqual(
            slugify("Plaid Link: Initial Setup"),
            "plaid-link-initial-setup"
        )
        self.assertEqual(
            slugify("User Auth (OAuth 2.0)"),
            "user-auth-oauth-20"
        )

    def test_empty_string(self):
        """Empty string returns empty string."""
        self.assertEqual(slugify(""), "")

    def test_only_special_chars(self):
        """String with only special chars returns empty."""
        self.assertEqual(slugify("!@#$%^&*()"), "")


class TestValidateTransition(unittest.TestCase):
    """Tests for status transition validation."""

    def test_not_started_transitions(self):
        """Not-started can go to in-progress or on-hold."""
        self.assertTrue(validate_transition('not-started', 'in-progress'))
        self.assertTrue(validate_transition('not-started', 'on-hold'))
        self.assertFalse(validate_transition('not-started', 'completed'))

    def test_in_progress_transitions(self):
        """In-progress can go to completed, on-hold, or back to not-started."""
        self.assertTrue(validate_transition('in-progress', 'completed'))
        self.assertTrue(validate_transition('in-progress', 'on-hold'))
        self.assertTrue(validate_transition('in-progress', 'not-started'))

    def test_completed_transitions(self):
        """Completed can only reopen to in-progress."""
        self.assertTrue(validate_transition('completed', 'in-progress'))
        self.assertFalse(validate_transition('completed', 'not-started'))
        self.assertFalse(validate_transition('completed', 'on-hold'))

    def test_on_hold_transitions(self):
        """On-hold can go to not-started or in-progress."""
        self.assertTrue(validate_transition('on-hold', 'not-started'))
        self.assertTrue(validate_transition('on-hold', 'in-progress'))
        self.assertFalse(validate_transition('on-hold', 'completed'))

    def test_same_status(self):
        """Same status transition is always allowed."""
        for status in VALID_STATUSES:
            self.assertTrue(validate_transition(status, status))

    def test_force_overrides(self):
        """Force flag allows any transition."""
        # This would normally be invalid
        self.assertFalse(validate_transition('not-started', 'completed'))
        self.assertTrue(validate_transition('not-started', 'completed', force=True))

    def test_all_valid_statuses_have_transitions(self):
        """All valid statuses have defined transitions."""
        for status in VALID_STATUSES:
            self.assertIn(status, VALID_TRANSITIONS)


class TestFindByTitle(unittest.TestCase):
    """Tests for find_by_title function."""

    def setUp(self):
        """Create mock roadmap data."""
        self.mock_roadmap = {
            "items": [
                {"id": "uuid-1", "title": "Transaction sync", "status": "not-started", "moscow": "must-have"},
                {"id": "uuid-2", "title": "User Authentication", "status": "in-progress", "moscow": "must-have"},
                {"id": "uuid-3", "title": "Transaction history view", "status": "completed", "moscow": "should-have"},
            ]
        }

    @patch('find_by_title.load_roadmap')
    def test_exact_match(self, mock_load):
        """Exact title match returns correct item."""
        mock_load.return_value = self.mock_roadmap
        matches = find_by_title("Transaction sync")
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]['id'], 'uuid-1')

    @patch('find_by_title.load_roadmap')
    def test_partial_match(self, mock_load):
        """Partial match returns correct items."""
        mock_load.return_value = self.mock_roadmap
        matches = find_by_title("Transaction")
        self.assertEqual(len(matches), 2)
        ids = [m['id'] for m in matches]
        self.assertIn('uuid-1', ids)
        self.assertIn('uuid-3', ids)

    @patch('find_by_title.load_roadmap')
    def test_case_insensitive(self, mock_load):
        """Search is case-insensitive."""
        mock_load.return_value = self.mock_roadmap
        matches = find_by_title("TRANSACTION SYNC")
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]['id'], 'uuid-1')

    @patch('find_by_title.load_roadmap')
    def test_no_match(self, mock_load):
        """No match returns empty list."""
        mock_load.return_value = self.mock_roadmap
        matches = find_by_title("Nonexistent feature")
        self.assertEqual(len(matches), 0)

    @patch('find_by_title.load_roadmap')
    def test_empty_roadmap(self, mock_load):
        """Empty roadmap returns empty list."""
        mock_load.return_value = {"items": []}
        matches = find_by_title("anything")
        self.assertEqual(len(matches), 0)

    @patch('find_by_title.load_roadmap')
    def test_roadmap_load_failure(self, mock_load):
        """Failed roadmap load returns empty list."""
        mock_load.return_value = None
        matches = find_by_title("anything")
        self.assertEqual(len(matches), 0)

    @patch('find_by_title.load_roadmap')
    def test_returned_fields(self, mock_load):
        """Matches include expected fields."""
        mock_load.return_value = self.mock_roadmap
        matches = find_by_title("Transaction sync")
        match = matches[0]
        self.assertIn('id', match)
        self.assertIn('title', match)
        self.assertIn('status', match)
        self.assertIn('moscow', match)


class TestGetSlugForItem(unittest.TestCase):
    """Tests for get_slug_for_item function."""

    def setUp(self):
        """Create mock roadmap data."""
        self.mock_roadmap = {
            "items": [
                {"id": "550e8400-e29b-41d4-a716-446655440000", "title": "Transaction Sync"},
            ]
        }

    @patch('slugify.load_roadmap')
    def test_valid_item_id(self, mock_load):
        """Valid item ID returns correct slug."""
        mock_load.return_value = self.mock_roadmap
        slug = get_slug_for_item("550e8400-e29b-41d4-a716-446655440000")
        self.assertEqual(slug, "transaction-sync")

    @patch('slugify.load_roadmap')
    def test_invalid_item_id(self, mock_load):
        """Invalid item ID returns None."""
        mock_load.return_value = self.mock_roadmap
        slug = get_slug_for_item("invalid-uuid")
        self.assertIsNone(slug)

    @patch('slugify.load_roadmap')
    def test_roadmap_load_failure(self, mock_load):
        """Failed roadmap load returns None."""
        mock_load.return_value = None
        slug = get_slug_for_item("550e8400-e29b-41d4-a716-446655440000")
        self.assertIsNone(slug)


class TestStatusConstants(unittest.TestCase):
    """Tests for status-related constants."""

    def test_valid_statuses(self):
        """Valid statuses list is correct."""
        expected = ['not-started', 'in-progress', 'completed', 'on-hold']
        self.assertEqual(VALID_STATUSES, expected)

    def test_transition_keys_match_statuses(self):
        """All valid statuses have transition rules."""
        for status in VALID_STATUSES:
            self.assertIn(status, VALID_TRANSITIONS)

    def test_transition_targets_are_valid(self):
        """All transition targets are valid statuses."""
        for source, targets in VALID_TRANSITIONS.items():
            for target in targets:
                self.assertIn(target, VALID_STATUSES,
                    f"Invalid transition target: {source} -> {target}")


if __name__ == '__main__':
    unittest.main(verbosity=2)
