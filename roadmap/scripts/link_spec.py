#!/usr/bin/env python3
"""Link spec files to a roadmap item."""

import sys
import os
from datetime import datetime, timezone
from utils import load_roadmap, save_roadmap, get_project_root


def link_spec(item_id: str, spec_slug: str) -> bool:
    """Link spec files to a roadmap item by ID."""
    roadmap = load_roadmap()
    if not roadmap:
        print("Error: Could not load roadmap.json")
        return False

    project_root = get_project_root()
    spec_dir = os.path.join(project_root, 'specs', spec_slug)

    if not os.path.isdir(spec_dir):
        print(f"Warning: Spec directory '{spec_dir}' does not exist yet")

    for item in roadmap.get('items', []):
        if item.get('id') == item_id:
            # Build linkedArtifacts object
            linked = {'specSlug': spec_slug}

            # Check which files exist
            ideation_path = f"specs/{spec_slug}/01-ideation.md"
            spec_path = f"specs/{spec_slug}/02-specification.md"
            tasks_path = f"specs/{spec_slug}/03-tasks.md"
            impl_path = f"specs/{spec_slug}/04-implementation.md"

            if os.path.isfile(os.path.join(project_root, ideation_path)):
                linked['ideationPath'] = ideation_path
            if os.path.isfile(os.path.join(project_root, spec_path)):
                linked['specPath'] = spec_path
            if os.path.isfile(os.path.join(project_root, tasks_path)):
                linked['tasksPath'] = tasks_path
            if os.path.isfile(os.path.join(project_root, impl_path)):
                linked['implementationPath'] = impl_path

            item['linkedArtifacts'] = linked
            item['updatedAt'] = datetime.now(timezone.utc).isoformat()
            roadmap['lastUpdated'] = datetime.now(timezone.utc).isoformat()

            if save_roadmap(roadmap):
                print(f"Linked '{item.get('title')}' to specs/{spec_slug}/")
                for key, value in linked.items():
                    print(f"  - {key}: {value}")
                return True
            else:
                print("Error: Failed to save roadmap.json")
                return False

    print(f"Error: Item with ID '{item_id}' not found")
    return False


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("Usage: python3 link_spec.py <item-id> <spec-slug>")
        print("Example: python3 link_spec.py 550e8400-... transaction-sync")
        sys.exit(1)

    success = link_spec(sys.argv[1], sys.argv[2])
    sys.exit(0 if success else 1)
