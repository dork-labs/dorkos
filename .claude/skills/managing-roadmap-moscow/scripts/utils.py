#!/usr/bin/env python3
"""Shared utilities for roadmap scripts."""

import json
import os
from pathlib import Path
from datetime import datetime
from typing import Any


# Find project root (contains roadmap/ directory)
def get_project_root() -> Path:
    """Find the project root directory."""
    current = Path(__file__).resolve()
    while current != current.parent:
        if (current / 'roadmap' / 'roadmap.json').exists():
            return current
        current = current.parent
    raise FileNotFoundError("Could not find project root with roadmap/roadmap.json")


def get_roadmap_path() -> Path:
    """Get path to roadmap.json."""
    return get_project_root() / 'roadmap' / 'roadmap.json'


def get_schema_path() -> Path:
    """Get path to schema.json."""
    return get_project_root() / 'roadmap' / 'schema.json'


def load_roadmap() -> dict[str, Any]:
    """Load and parse roadmap.json."""
    with open(get_roadmap_path(), 'r') as f:
        return json.load(f)


def save_roadmap(data: dict[str, Any]) -> None:
    """Save roadmap data back to file."""
    data['lastUpdated'] = datetime.utcnow().isoformat() + 'Z'
    with open(get_roadmap_path(), 'w') as f:
        json.dump(data, f, indent=2)


def load_schema() -> dict[str, Any]:
    """Load and parse schema.json."""
    with open(get_schema_path(), 'r') as f:
        return json.load(f)


# MoSCoW priority order
MOSCOW_ORDER = ['must-have', 'should-have', 'could-have', 'wont-have']

# Status order
STATUS_ORDER = ['in-progress', 'not-started', 'on-hold', 'completed']

# Horizon order
HORIZON_ORDER = ['now', 'next', 'later']


def get_sort_key(item: dict, sort_by: str) -> tuple:
    """Get sort key for an item based on sort criteria."""
    if sort_by == 'moscow':
        try:
            moscow_idx = MOSCOW_ORDER.index(item.get('moscow', 'wont-have'))
        except ValueError:
            moscow_idx = len(MOSCOW_ORDER)
        return (moscow_idx, item.get('title', ''))

    elif sort_by == 'status':
        try:
            status_idx = STATUS_ORDER.index(item.get('status', 'not-started'))
        except ValueError:
            status_idx = len(STATUS_ORDER)
        return (status_idx, item.get('title', ''))

    elif sort_by == 'horizon':
        try:
            horizon_idx = HORIZON_ORDER.index(item.get('timeHorizon', 'later'))
        except ValueError:
            horizon_idx = len(HORIZON_ORDER)
        return (horizon_idx, item.get('title', ''))

    else:
        return (item.get('title', ''),)
