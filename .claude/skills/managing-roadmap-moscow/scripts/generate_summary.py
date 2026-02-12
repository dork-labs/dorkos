#!/usr/bin/env python3
"""Generate a text summary of the roadmap."""

import sys
from pathlib import Path

# Add parent directory to path for utils import
sys.path.insert(0, str(Path(__file__).parent))
from utils import load_roadmap, MOSCOW_ORDER, HORIZON_ORDER


def main():
    try:
        data = load_roadmap()
    except FileNotFoundError:
        print("ERROR: roadmap.json not found")
        sys.exit(1)

    items = data.get('items', [])

    print(f"# {data.get('projectName', 'Product Roadmap')}")
    print()
    print(data.get('projectSummary', ''))
    print()
    print(f"Last Updated: {data.get('lastUpdated', 'Unknown')}")
    print()

    # Group by time horizon
    for horizon in HORIZON_ORDER:
        horizon_items = [i for i in items if i.get('timeHorizon') == horizon]
        if not horizon_items:
            continue

        horizon_config = data.get('timeHorizons', {}).get(horizon, {})
        label = horizon_config.get('label', horizon.title())

        print(f"## {label}")
        print()

        # Sub-group by MoSCoW
        for moscow in MOSCOW_ORDER:
            moscow_items = [i for i in horizon_items if i.get('moscow') == moscow]
            if not moscow_items:
                continue

            moscow_label = moscow.replace('-', ' ').title()
            print(f"### {moscow_label}")
            print()

            for item in moscow_items:
                status = item.get('status', 'unknown').replace('-', ' ').title()
                health = item.get('health', 'unknown').replace('-', ' ').title()
                effort = f" ({item.get('effort')} pts)" if item.get('effort') else ""

                print(f"- **{item.get('title')}** [{status}] [{health}]{effort}")
                if item.get('description'):
                    print(f"  {item.get('description')[:100]}...")
            print()

    # Statistics
    total_effort = sum(i.get('effort', 0) for i in items)
    must_have_effort = sum(i.get('effort', 0) for i in items if i.get('moscow') == 'must-have')
    must_have_percent = (must_have_effort / total_effort * 100) if total_effort > 0 else 0

    print("## Statistics")
    print()
    print(f"- Total Items: {len(items)}")
    print(f"- Must-Have %: {must_have_percent:.1f}%")
    print(f"- In Progress: {len([i for i in items if i.get('status') == 'in-progress'])}")
    print(f"- At Risk: {len([i for i in items if i.get('health') in ['at-risk', 'off-track', 'blocked']])}")


if __name__ == '__main__':
    main()
