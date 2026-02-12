#!/usr/bin/env python3
"""
Link all spec directories to their corresponding roadmap items.

This script finds all specs in the specs/ directory and attempts to link them
to roadmap items by matching:
1. Exact specSlug match (if linkedArtifacts.specSlug already set)
2. Title similarity using fuzzy matching
3. roadmapId in spec frontmatter

Use this to backfill linkedArtifacts for existing specs that were created
before roadmap integration was added.

Usage:
    python3 roadmap/scripts/link_all_specs.py [--dry-run]

Options:
    --dry-run    Show what would be linked without making changes
"""

import sys
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Add parent directory to path for utils import
sys.path.insert(0, str(Path(__file__).parent))
from utils import load_roadmap, save_roadmap, get_project_root


def slugify(text: str) -> str:
    """Convert text to URL-safe slug."""
    text = text.lower()
    text = re.sub(r'[^a-z0-9\s-]', '', text)
    text = re.sub(r'[\s_]+', '-', text)
    text = re.sub(r'-+', '-', text)
    return text.strip('-')


def extract_roadmap_id_from_spec(spec_dir: Path) -> Optional[str]:
    """Extract roadmapId from spec files (ideation or specification)."""
    uuid_pattern = r'[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'

    for filename in ['01-ideation.md', '02-specification.md']:
        filepath = spec_dir / filename
        if not filepath.exists():
            continue

        try:
            content = filepath.read_text()

            # Check YAML frontmatter (proper format)
            frontmatter_match = re.match(r'^---\s*\n(.*?)\n---', content, re.DOTALL)
            if frontmatter_match:
                frontmatter = frontmatter_match.group(1)
                id_match = re.search(rf'roadmapId:\s*({uuid_pattern})', frontmatter, re.IGNORECASE)
                if id_match:
                    return id_match.group(1)

            # Fallback: check markdown body for legacy formats
            # e.g., **roadmapId:** uuid or **Roadmap ID:** uuid
            legacy_match = re.search(
                rf'\*\*(?:roadmapId|Roadmap ID):\*\*\s*({uuid_pattern})',
                content,
                re.IGNORECASE
            )
            if legacy_match:
                return legacy_match.group(1)

            # Also check for Related: ... (uuid) format
            related_match = re.search(
                rf'\*\*Related:\*\*.*?\(({uuid_pattern})\)',
                content
            )
            if related_match:
                return related_match.group(1)

        except IOError:
            continue

    return None


def find_matching_item(items: list, spec_slug: str, roadmap_id: Optional[str]) -> Optional[dict]:
    """Find the roadmap item that matches this spec."""
    # Priority 1: Match by roadmapId from spec file
    if roadmap_id:
        for item in items:
            if item.get('id') == roadmap_id:
                return item

    # Priority 2: Match by existing specSlug
    for item in items:
        linked = item.get('linkedArtifacts', {})
        if linked.get('specSlug') == spec_slug:
            return item

    # Priority 3: Fuzzy match by title -> slug
    slug_from_title_map = {}
    for item in items:
        title_slug = slugify(item.get('title', ''))
        slug_from_title_map[title_slug] = item

    # Direct slug match
    if spec_slug in slug_from_title_map:
        return slug_from_title_map[spec_slug]

    # Partial match: spec_slug contains title_slug or vice versa
    for title_slug, item in slug_from_title_map.items():
        if spec_slug in title_slug or title_slug in spec_slug:
            return item

    return None


def get_existing_spec_files(spec_dir: Path) -> dict:
    """Check which spec files exist in the directory."""
    files = {}
    spec_slug = spec_dir.name

    file_mappings = [
        ('ideationPath', '01-ideation.md'),
        ('specPath', '02-specification.md'),
        ('tasksPath', '03-tasks.md'),
        ('implementationPath', '04-implementation.md'),
    ]

    for key, filename in file_mappings:
        filepath = spec_dir / filename
        if filepath.exists():
            files[key] = f"specs/{spec_slug}/{filename}"

    return files


def link_all_specs(dry_run: bool = False) -> dict:
    """Link all spec directories to roadmap items."""
    project_root = Path(get_project_root())
    specs_dir = project_root / 'specs'

    if not specs_dir.exists():
        print("Error: specs/ directory not found")
        return {'linked': 0, 'skipped': 0, 'not_found': 0}

    roadmap = load_roadmap()
    if not roadmap:
        print("Error: Could not load roadmap.json")
        return {'linked': 0, 'skipped': 0, 'not_found': 0}

    items = roadmap.get('items', [])
    stats = {'linked': 0, 'skipped': 0, 'not_found': 0}
    changes_made = False

    print(f"Scanning specs/ directory...")
    print(f"Found {len(items)} roadmap items")
    print()

    for spec_dir in sorted(specs_dir.iterdir()):
        if not spec_dir.is_dir():
            continue

        spec_slug = spec_dir.name

        # Skip if no spec files exist
        existing_files = get_existing_spec_files(spec_dir)
        if not existing_files:
            continue

        # Try to extract roadmapId from spec files
        roadmap_id = extract_roadmap_id_from_spec(spec_dir)

        # Find matching roadmap item
        item = find_matching_item(items, spec_slug, roadmap_id)

        if not item:
            print(f"  {spec_slug}: No matching roadmap item found")
            stats['not_found'] += 1
            continue

        # Check if already linked with all files
        current_linked = item.get('linkedArtifacts', {})
        needs_update = False

        # Check if specSlug is set
        if current_linked.get('specSlug') != spec_slug:
            needs_update = True

        # Check if all existing files are linked
        for key, path in existing_files.items():
            if current_linked.get(key) != path:
                needs_update = True
                break

        if not needs_update:
            print(f"  {spec_slug}: Already linked to '{item.get('title')}'")
            stats['skipped'] += 1
            continue

        # Build updated linkedArtifacts
        new_linked = {'specSlug': spec_slug, **existing_files}

        if dry_run:
            print(f"  {spec_slug}: Would link to '{item.get('title')}'")
            for key, value in new_linked.items():
                print(f"    - {key}: {value}")
            stats['linked'] += 1
        else:
            item['linkedArtifacts'] = new_linked
            item['updatedAt'] = datetime.now(timezone.utc).isoformat()
            changes_made = True
            print(f"  {spec_slug}: Linked to '{item.get('title')}'")
            for key, value in new_linked.items():
                print(f"    - {key}: {value}")
            stats['linked'] += 1

    if changes_made and not dry_run:
        roadmap['lastUpdated'] = datetime.now(timezone.utc).isoformat()
        if save_roadmap(roadmap):
            print()
            print("Roadmap updated successfully")
        else:
            print()
            print("Error: Failed to save roadmap.json")

    return stats


def main():
    dry_run = '--dry-run' in sys.argv

    if dry_run:
        print("DRY RUN - No changes will be made")
        print()

    stats = link_all_specs(dry_run)

    print()
    print("Summary:")
    print(f"  - Linked: {stats['linked']}")
    print(f"  - Already linked (skipped): {stats['skipped']}")
    print(f"  - No matching item: {stats['not_found']}")

    if stats['not_found'] > 0:
        print()
        print("Tip: Specs without matching roadmap items may need to be")
        print("linked manually using: /roadmap add or link_spec.py")


if __name__ == '__main__':
    main()
