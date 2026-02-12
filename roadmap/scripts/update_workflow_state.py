#!/usr/bin/env python3
"""Update workflowState for a roadmap item.

Usage:
    python3 roadmap/scripts/update_workflow_state.py <item-id> <key=value> [key=value ...]

Examples:
    # Set phase to implementing
    python3 roadmap/scripts/update_workflow_state.py abc123 phase=implementing

    # Set multiple fields
    python3 roadmap/scripts/update_workflow_state.py abc123 phase=testing attempts=0 tasksCompleted=5

    # Add blockers (JSON array)
    python3 roadmap/scripts/update_workflow_state.py abc123 'blockers=["Test failure in auth.test.ts"]'

    # Reset to not-started
    python3 roadmap/scripts/update_workflow_state.py abc123 phase=not-started attempts=0 blockers=[]
"""

import sys
import json
from datetime import datetime, timezone
from utils import load_roadmap, save_roadmap


def update_workflow_state(item_id: str, updates: dict) -> bool:
    """Update workflowState fields for a roadmap item.

    Args:
        item_id: The UUID of the roadmap item
        updates: Dictionary of workflowState fields to update

    Returns:
        True if item was found and updated, False otherwise
    """
    roadmap = load_roadmap()
    if roadmap is None:
        return False

    for item in roadmap['items']:
        if item['id'] == item_id:
            # Initialize workflowState if not present
            if 'workflowState' not in item:
                item['workflowState'] = {}

            # Apply updates
            item['workflowState'].update(updates)

            # Always update lastSession timestamp
            item['workflowState']['lastSession'] = datetime.now(timezone.utc).isoformat()

            # Update item's updatedAt
            item['updatedAt'] = datetime.now(timezone.utc).isoformat()

            # Update roadmap lastUpdated
            roadmap['lastUpdated'] = datetime.now(timezone.utc).isoformat()

            save_roadmap(roadmap)
            print(f"Updated workflowState for '{item['title']}' ({item_id})")
            print(f"  Current state: {json.dumps(item['workflowState'], indent=2)}")
            return True

    return False


def parse_value(value_str: str):
    """Parse a value string, attempting JSON decode for arrays/objects/numbers."""
    try:
        return json.loads(value_str)
    except json.JSONDecodeError:
        return value_str


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    item_id = sys.argv[1]
    updates = {}

    for arg in sys.argv[2:]:
        if '=' not in arg:
            print(f"Error: Invalid argument '{arg}'. Must be in key=value format.")
            sys.exit(1)

        key, value = arg.split('=', 1)
        updates[key] = parse_value(value)

    if update_workflow_state(item_id, updates):
        print("Success!")
    else:
        print(f"Error: Item not found: {item_id}")
        sys.exit(1)
