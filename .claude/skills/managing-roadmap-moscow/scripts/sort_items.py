#!/usr/bin/env python3
"""Sort roadmap items by various criteria."""

import argparse
import sys
from pathlib import Path

# Add parent directory to path for utils import
sys.path.insert(0, str(Path(__file__).parent))
from utils import load_roadmap, save_roadmap, get_sort_key


def main():
    parser = argparse.ArgumentParser(description='Sort roadmap items')
    parser.add_argument('--by', choices=['moscow', 'status', 'horizon'], default='moscow',
                        help='Sort criteria (default: moscow)')
    parser.add_argument('--save', action='store_true', help='Save sorted items back to file')
    args = parser.parse_args()

    try:
        data = load_roadmap()
    except FileNotFoundError:
        print("ERROR: roadmap.json not found")
        sys.exit(1)

    items = data.get('items', [])
    sorted_items = sorted(items, key=lambda x: get_sort_key(x, args.by))

    if args.save:
        data['items'] = sorted_items
        save_roadmap(data)
        print(f"Sorted {len(sorted_items)} items by {args.by} and saved")
    else:
        print(f"Sorted {len(sorted_items)} items by {args.by}:")
        for item in sorted_items:
            print(f"  [{item.get('moscow', '?'):12}] [{item.get('timeHorizon', '?'):5}] {item.get('title', 'Untitled')}")


if __name__ == '__main__':
    main()
