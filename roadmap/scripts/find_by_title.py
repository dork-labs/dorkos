#!/usr/bin/env python3
"""Find roadmap items by title."""

import sys
import json
from typing import List, Dict
from utils import load_roadmap


def find_by_title(query: str) -> List[Dict]:
    """Find roadmap items matching title query (case-insensitive)."""
    roadmap = load_roadmap()
    if not roadmap:
        return []

    query_lower = query.lower()
    matches = []

    for item in roadmap.get('items', []):
        title = item.get('title', '').lower()
        if query_lower in title:
            matches.append({
                'id': item.get('id'),
                'title': item.get('title'),
                'status': item.get('status'),
                'moscow': item.get('moscow')
            })

    return matches


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 find_by_title.py <title-query>")
        sys.exit(1)

    query = ' '.join(sys.argv[1:])
    matches = find_by_title(query)

    if not matches:
        print(f"No items found matching '{query}'", file=sys.stderr)
        sys.exit(1)
    elif len(matches) == 1:
        print(matches[0]['id'])
    else:
        # Multiple matches - output JSON for caller to handle
        print(json.dumps(matches, indent=2))
        sys.exit(2)  # Exit code 2 = multiple matches
