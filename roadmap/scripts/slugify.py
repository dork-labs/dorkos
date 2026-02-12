#!/usr/bin/env python3
"""Generate URL-safe slug from roadmap item title."""

import sys
import re
from typing import Optional
from utils import load_roadmap


def slugify(text: str) -> str:
    """Convert text to URL-safe slug."""
    # Convert to lowercase
    slug = text.lower()
    # Replace spaces and underscores with hyphens
    slug = re.sub(r'[\s_]+', '-', slug)
    # Remove non-alphanumeric characters (except hyphens)
    slug = re.sub(r'[^a-z0-9-]', '', slug)
    # Remove multiple consecutive hyphens
    slug = re.sub(r'-+', '-', slug)
    # Remove leading/trailing hyphens
    slug = slug.strip('-')
    return slug


def get_slug_for_item(item_id: str) -> Optional[str]:
    """Get slug for a roadmap item by ID."""
    roadmap = load_roadmap()
    if not roadmap:
        return None

    for item in roadmap.get('items', []):
        if item.get('id') == item_id:
            return slugify(item.get('title', ''))

    return None


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 slugify.py <text-or-item-id>")
        sys.exit(1)

    arg = sys.argv[1]

    # Check if it's a UUID (roadmap item ID)
    uuid_pattern = r'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    if re.match(uuid_pattern, arg):
        slug = get_slug_for_item(arg)
        if slug:
            print(slug)
        else:
            print(f"Error: Item with ID '{arg}' not found", file=sys.stderr)
            sys.exit(1)
    else:
        print(slugify(arg))
