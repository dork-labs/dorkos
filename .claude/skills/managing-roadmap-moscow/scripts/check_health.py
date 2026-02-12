#!/usr/bin/env python3
"""Check roadmap health and report issues."""

import sys
from pathlib import Path

# Add parent directory to path for utils import
sys.path.insert(0, str(Path(__file__).parent))
from utils import load_roadmap


def main():
    try:
        data = load_roadmap()
    except FileNotFoundError:
        print("ERROR: roadmap.json not found")
        sys.exit(1)

    items = data.get('items', [])

    # Calculate Must-Have percentage
    total_effort = sum(item.get('effort', 0) for item in items)
    must_have_effort = sum(item.get('effort', 0) for item in items if item.get('moscow') == 'must-have')

    must_have_percent = (must_have_effort / total_effort * 100) if total_effort > 0 else 0

    # Find issues
    at_risk = [i for i in items if i.get('health') in ['at-risk', 'off-track', 'blocked']]
    missing_effort = [i for i in items if i.get('effort') is None and i.get('moscow') == 'must-have']
    in_progress = [i for i in items if i.get('status') == 'in-progress']

    # Report
    print("=" * 50)
    print("ROADMAP HEALTH CHECK")
    print("=" * 50)
    print()

    # Must-Have percentage
    status = "WARNING" if must_have_percent > 60 else "OK"
    print(f"Must-Have Effort: {must_have_percent:.1f}% [{status}]")
    if must_have_percent > 60:
        print("  ! Must-Have items exceed 60% threshold")
        print("  ! Consider moving some items to Should-Have")
    print()

    # Items at risk
    print(f"At Risk / Blocked: {len(at_risk)} items")
    for item in at_risk:
        print(f"  - [{item.get('health'):8}] {item.get('title')}")
    print()

    # Missing effort estimates
    print(f"Missing Effort (Must-Have): {len(missing_effort)} items")
    for item in missing_effort:
        print(f"  - {item.get('title')}")
    print()

    # Summary
    print(f"Total Items: {len(items)}")
    print(f"In Progress: {len(in_progress)}")
    print(f"Total Effort: {total_effort}")
    print()

    # Exit code based on health
    if must_have_percent > 60 or len(at_risk) > 0:
        sys.exit(1)
    sys.exit(0)


if __name__ == '__main__':
    main()
