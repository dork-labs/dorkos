#!/usr/bin/env python3
"""Shared utilities for roadmap scripts."""

import json
import os
import subprocess
from pathlib import Path
from typing import Optional


def get_project_root() -> str:
    """Find the project root directory."""
    try:
        result = subprocess.run(
            ['git', 'rev-parse', '--show-toplevel'],
            capture_output=True,
            text=True,
            check=True
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        # Fallback: walk up from script location
        current = Path(__file__).resolve().parent
        while current != current.parent:
            if (current / 'roadmap').is_dir():
                return str(current)
            current = current.parent
        return os.getcwd()


def get_roadmap_path() -> str:
    """Get the path to roadmap.json."""
    project_root = get_project_root()
    return os.path.join(project_root, 'roadmap', 'roadmap.json')


def load_roadmap() -> Optional[dict]:
    """Load and parse roadmap.json."""
    roadmap_path = get_roadmap_path()
    try:
        with open(roadmap_path, 'r') as f:
            return json.load(f)
    except FileNotFoundError:
        print(f"Error: Could not find {roadmap_path}")
        return None
    except json.JSONDecodeError as e:
        print(f"Error: Failed to parse roadmap.json: {e}")
        return None


def save_roadmap(data: dict) -> bool:
    """Save roadmap data to roadmap.json."""
    roadmap_path = get_roadmap_path()
    try:
        with open(roadmap_path, 'w') as f:
            json.dump(data, f, indent=2)
            f.write('\n')  # Add trailing newline
        return True
    except IOError as e:
        print(f"Error: Failed to save roadmap.json: {e}")
        return False
