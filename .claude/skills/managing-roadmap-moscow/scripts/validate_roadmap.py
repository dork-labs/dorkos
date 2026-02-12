#!/usr/bin/env python3
"""Validate roadmap.json against the JSON schema."""

import sys
import json
import re
from pathlib import Path

# Add parent directory to path for utils import
sys.path.insert(0, str(Path(__file__).parent))
from utils import load_roadmap, load_schema


def validate_uuid(value: str) -> bool:
    """Validate UUID v4 format."""
    pattern = r'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    return bool(re.match(pattern, value, re.IGNORECASE))


def validate_datetime(value: str) -> bool:
    """Validate ISO 8601 datetime format."""
    # Supports formats like:
    # 2025-12-09T18:00:00Z
    # 2025-12-10T01:48:20.684583+00:00
    # 2025-12-10T01:48:20.684583Z
    pattern = r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$'
    return bool(re.match(pattern, value))


def validate_enum(value: str, allowed: list) -> bool:
    """Validate value is in allowed list."""
    return value in allowed


def validate_item(item: dict, idx: int) -> tuple[list[str], list[str]]:
    """Validate a single roadmap item. Returns (errors, warnings)."""
    errors = []
    warnings = []

    # Required fields
    required = ['id', 'title', 'type', 'moscow', 'status', 'health', 'timeHorizon', 'createdAt', 'updatedAt']
    for field in required:
        if field not in item:
            errors.append(f"Item {idx}: missing required field '{field}'")

    # ID validation
    if 'id' in item and not validate_uuid(item['id']):
        errors.append(f"Item {idx}: invalid UUID format for 'id'")

    # Title length
    if 'title' in item:
        if len(item['title']) < 3:
            errors.append(f"Item {idx}: title too short (min 3 chars)")
        if len(item['title']) > 200:
            errors.append(f"Item {idx}: title too long (max 200 chars)")

    # Enum validations
    if 'type' in item and not validate_enum(item['type'], ['feature', 'bugfix', 'technical-debt', 'research', 'epic']):
        errors.append(f"Item {idx}: invalid type '{item['type']}'")

    if 'moscow' in item and not validate_enum(item['moscow'], ['must-have', 'should-have', 'could-have', 'wont-have']):
        errors.append(f"Item {idx}: invalid moscow '{item['moscow']}'")

    if 'status' in item and not validate_enum(item['status'], ['not-started', 'in-progress', 'completed', 'on-hold']):
        errors.append(f"Item {idx}: invalid status '{item['status']}'")

    if 'health' in item and not validate_enum(item['health'], ['on-track', 'at-risk', 'off-track', 'blocked']):
        errors.append(f"Item {idx}: invalid health '{item['health']}'")

    if 'timeHorizon' in item and not validate_enum(item['timeHorizon'], ['now', 'next', 'later']):
        errors.append(f"Item {idx}: invalid timeHorizon '{item['timeHorizon']}'")

    # Datetime validation
    for field in ['createdAt', 'updatedAt']:
        if field in item and not validate_datetime(item[field]):
            errors.append(f"Item {idx}: invalid datetime format for '{field}'")

    # Effort must be non-negative
    if 'effort' in item and item['effort'] < 0:
        errors.append(f"Item {idx}: effort must be non-negative")

    # Dependencies must be array of strings
    if 'dependencies' in item:
        if not isinstance(item['dependencies'], list):
            errors.append(f"Item {idx}: dependencies must be an array")
        elif not all(isinstance(d, str) for d in item['dependencies']):
            errors.append(f"Item {idx}: all dependencies must be strings")

    # Labels must be array of strings
    if 'labels' in item:
        if not isinstance(item['labels'], list):
            errors.append(f"Item {idx}: labels must be an array")
        elif not all(isinstance(l, str) for l in item['labels']):
            errors.append(f"Item {idx}: all labels must be strings")

    # Warning: completed/in-progress items should have linkedArtifacts
    status = item.get('status')
    linked = item.get('linkedArtifacts', {})
    title = item.get('title', f'Item {idx}')

    if status == 'completed':
        if not linked:
            warnings.append(f"'{title}': completed but no linkedArtifacts (run link_all_specs.py)")
        elif not linked.get('specSlug'):
            warnings.append(f"'{title}': completed but missing specSlug")
        elif not linked.get('implementationPath'):
            warnings.append(f"'{title}': completed but missing implementationPath")

    elif status == 'in-progress':
        if not linked:
            warnings.append(f"'{title}': in-progress but no linkedArtifacts")
        elif not linked.get('specSlug'):
            warnings.append(f"'{title}': in-progress but missing specSlug")

    return errors, warnings


def validate_roadmap(data: dict) -> tuple[list[str], list[str]]:
    """Validate the entire roadmap structure. Returns (errors, warnings)."""
    errors = []
    warnings = []

    # Required top-level fields
    required = ['projectName', 'projectSummary', 'lastUpdated', 'timeHorizons', 'items']
    for field in required:
        if field not in data:
            errors.append(f"Missing required field '{field}'")

    # Validate timeHorizons
    if 'timeHorizons' in data:
        for horizon in ['now', 'next', 'later']:
            if horizon not in data['timeHorizons']:
                errors.append(f"Missing timeHorizon '{horizon}'")
            elif 'label' not in data['timeHorizons'][horizon]:
                errors.append(f"Missing 'label' for timeHorizon '{horizon}'")

    # Validate items
    if 'items' in data:
        if not isinstance(data['items'], list):
            errors.append("'items' must be an array")
        else:
            # Check for duplicate IDs
            ids = [item.get('id') for item in data['items'] if 'id' in item]
            if len(ids) != len(set(ids)):
                errors.append("Duplicate item IDs found")

            # Validate each item
            for idx, item in enumerate(data['items']):
                item_errors, item_warnings = validate_item(item, idx)
                errors.extend(item_errors)
                warnings.extend(item_warnings)

            # Validate dependency references
            valid_ids = set(ids)
            for idx, item in enumerate(data['items']):
                for dep_id in item.get('dependencies', []):
                    if dep_id not in valid_ids:
                        errors.append(f"Item {idx}: dependency '{dep_id}' references non-existent item")

    return errors, warnings


def main():
    """Main entry point."""
    try:
        data = load_roadmap()
    except FileNotFoundError:
        print("ERROR: roadmap.json not found")
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"ERROR: Invalid JSON - {e}")
        sys.exit(1)

    errors, warnings = validate_roadmap(data)

    if errors:
        print("Validation FAILED:")
        for error in errors:
            print(f"  - {error}")
        sys.exit(1)
    else:
        print("Validation PASSED")
        print(f"  - {len(data.get('items', []))} items validated")

        if warnings:
            print()
            print(f"Warnings ({len(warnings)}):")
            for warning in warnings:
                print(f"  - {warning}")
            print()
            print("Tip: Run 'python3 roadmap/scripts/link_all_specs.py' to fix missing linkedArtifacts")

        sys.exit(0)


if __name__ == '__main__':
    main()
