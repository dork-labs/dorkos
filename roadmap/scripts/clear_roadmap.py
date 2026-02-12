#!/usr/bin/env python3
"""Clear the roadmap and reset it with a new project name and summary.

Usage:
    python3 roadmap/scripts/clear_roadmap.py "Project Name" "Project summary description"
    python3 roadmap/scripts/clear_roadmap.py --help

This script:
- Removes all items from the roadmap
- Updates projectName and projectSummary
- Updates lastUpdated timestamp
- Preserves timeHorizons structure
- Validates the result
"""

import sys
from datetime import datetime, timezone

from utils import load_roadmap, save_roadmap


def clear_roadmap(project_name: str, project_summary: str) -> bool:
    """Clear the roadmap and set new project metadata.

    Args:
        project_name: The new project name
        project_summary: The new project summary/description

    Returns:
        True if successful, False otherwise
    """
    data = load_roadmap()
    if data is None:
        return False

    # Update project metadata
    data['projectName'] = project_name
    data['projectSummary'] = project_summary
    data['lastUpdated'] = datetime.now(timezone.utc).isoformat()

    # Clear all items (preserves timeHorizons structure)
    data['items'] = []

    if save_roadmap(data):
        print(f"✅ Roadmap cleared successfully")
        print(f"   Project: {project_name}")
        print(f"   Summary: {project_summary}")
        print(f"   Items: 0")
        return True

    return False


def print_usage():
    """Print usage instructions."""
    print("Usage: python3 roadmap/scripts/clear_roadmap.py <project-name> <project-summary>")
    print()
    print("Arguments:")
    print("  project-name     The new project name (required)")
    print("  project-summary  Brief description of the project (required)")
    print()
    print("Examples:")
    print('  python3 roadmap/scripts/clear_roadmap.py "My App" "A modern web application"')
    print('  python3 roadmap/scripts/clear_roadmap.py "E-commerce Platform" "Online store with payments"')
    print()
    print("This will:")
    print("  - Remove all existing roadmap items")
    print("  - Update project name and summary")
    print("  - Update lastUpdated timestamp")
    print("  - Preserve timeHorizons configuration")


def main():
    if len(sys.argv) < 3:
        if len(sys.argv) == 2 and sys.argv[1] in ('--help', '-h'):
            print_usage()
            sys.exit(0)
        print("Error: Missing required arguments")
        print()
        print_usage()
        sys.exit(1)

    project_name = sys.argv[1]
    project_summary = sys.argv[2]

    if not project_name.strip():
        print("Error: Project name cannot be empty")
        sys.exit(1)

    if not project_summary.strip():
        print("Error: Project summary cannot be empty")
        sys.exit(1)

    if clear_roadmap(project_name, project_summary):
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == '__main__':
    main()
