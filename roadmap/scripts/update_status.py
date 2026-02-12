#!/usr/bin/env python3
"""Update roadmap item status."""

import sys
from datetime import datetime, timezone
from utils import load_roadmap, save_roadmap

VALID_STATUSES = ['not-started', 'in-progress', 'completed', 'on-hold']

VALID_TRANSITIONS = {
    'not-started': ['in-progress', 'on-hold'],
    'in-progress': ['completed', 'on-hold', 'not-started'],  # Allow restart
    'completed': ['in-progress'],  # Allow reopening
    'on-hold': ['not-started', 'in-progress']
}


def validate_transition(current: str, new: str, force: bool = False) -> bool:
    """Validate status transition is allowed."""
    if force:
        return True
    if current == new:
        return True  # No change
    allowed = VALID_TRANSITIONS.get(current, [])
    return new in allowed


def update_status(item_id: str, new_status: str, force: bool = False) -> bool:
    """Update status of a roadmap item by ID."""
    if new_status not in VALID_STATUSES:
        print(f"Error: Invalid status '{new_status}'. Valid: {VALID_STATUSES}")
        return False

    roadmap = load_roadmap()
    if not roadmap:
        print("Error: Could not load roadmap.json")
        return False

    for item in roadmap.get('items', []):
        if item.get('id') == item_id:
            old_status = item.get('status', 'not-started')

            if not validate_transition(old_status, new_status, force):
                print(f"Error: Cannot transition from '{old_status}' to '{new_status}'")
                print(f"Valid transitions from '{old_status}': {VALID_TRANSITIONS.get(old_status, [])}")
                print("Use --force to override transition validation")
                return False

            item['status'] = new_status
            item['updatedAt'] = datetime.now(timezone.utc).isoformat()
            roadmap['lastUpdated'] = datetime.now(timezone.utc).isoformat()

            if save_roadmap(roadmap):
                print(f"Updated '{item.get('title')}': {old_status} -> {new_status}")
                return True
            else:
                print("Error: Failed to save roadmap.json")
                return False

    print(f"Error: Item with ID '{item_id}' not found")
    return False


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print("Usage: python3 update_status.py <item-id> <new-status> [--force]")
        print(f"Valid statuses: {VALID_STATUSES}")
        sys.exit(1)

    force = '--force' in sys.argv
    args = [a for a in sys.argv[1:] if a != '--force']

    if len(args) != 2:
        print("Usage: python3 update_status.py <item-id> <new-status> [--force]")
        sys.exit(1)

    success = update_status(args[0], args[1], force)
    sys.exit(0 if success else 1)
