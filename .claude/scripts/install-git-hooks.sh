#!/bin/bash
#
# install-git-hooks.sh - Install DorkOS git hooks
#
# This script installs git hooks that enhance the development workflow:
#   - post-commit: Auto-populates changelog from conventional commits
#
# Usage:
#   .claude/scripts/install-git-hooks.sh [--uninstall]
#
# The hooks are installed as symlinks, so updates to the source files
# are automatically reflected.

set -e

# Find vault root (script is in .claude/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VAULT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

HOOKS_SOURCE="$VAULT_ROOT/.claude/hooks"
GIT_HOOKS="$VAULT_ROOT/.git/hooks"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

# Hook definitions: "source_file:git_hook_name"
# Using simple array for bash 3.2 compatibility (macOS default)
HOOK_DEFS=(
    "changelog-populator.py:post-commit"
)

install_hooks() {
    echo "Installing DorkOS git hooks..."
    echo ""

    # Check if .git directory exists
    if [ ! -d "$GIT_HOOKS" ]; then
        echo -e "${RED}Error: .git/hooks directory not found${NC}"
        echo "Are you in a git repository?"
        exit 1
    fi

    local installed=0
    local skipped=0

    for hook_def in "${HOOK_DEFS[@]}"; do
        local source_file="${hook_def%%:*}"
        local hook_name="${hook_def##*:}"
        local source_path="$HOOKS_SOURCE/$source_file"
        local target_path="$GIT_HOOKS/$hook_name"

        # Check source exists
        if [ ! -f "$source_path" ]; then
            echo -e "${YELLOW}Warning: Source not found: $source_file${NC}"
            continue
        fi

        # Check if hook already exists
        if [ -e "$target_path" ]; then
            if [ -L "$target_path" ]; then
                # It's a symlink, check if it points to our file
                local current_target=$(readlink "$target_path")
                local expected_target="../../.claude/hooks/$source_file"

                if [ "$current_target" = "$expected_target" ]; then
                    echo -e "${GREEN}✓${NC} $hook_name already installed (symlink)"
                    skipped=$((skipped + 1))
                    continue
                fi
            fi

            # Backup existing hook
            local backup_path="${target_path}.backup.$(date +%Y%m%d%H%M%S)"
            echo -e "${YELLOW}Backing up existing $hook_name to ${backup_path##*/}${NC}"
            mv "$target_path" "$backup_path"
        fi

        # Create relative symlink
        cd "$GIT_HOOKS"
        ln -sf "../../.claude/hooks/$source_file" "$hook_name"
        cd - > /dev/null

        # Ensure executable
        chmod +x "$source_path"

        echo -e "${GREEN}✓${NC} Installed $hook_name -> $source_file"
        installed=$((installed + 1))
    done

    echo ""
    echo "Installation complete: $installed installed, $skipped already present"
    echo ""
    echo "Git hooks are now active. Conventional commits will auto-update the changelog."
    echo ""
    echo "Commit format examples:"
    echo "  feat: Add new feature      -> ### Added"
    echo "  fix: Fix bug               -> ### Fixed"
    echo "  docs: Update docs          -> ### Changed"
    echo "  chore: Maintenance         -> (skipped)"
}

uninstall_hooks() {
    echo "Uninstalling DorkOS git hooks..."
    echo ""

    local removed=0

    for hook_def in "${HOOK_DEFS[@]}"; do
        local source_file="${hook_def%%:*}"
        local hook_name="${hook_def##*:}"
        local target_path="$GIT_HOOKS/$hook_name"

        if [ -L "$target_path" ]; then
            local current_target=$(readlink "$target_path")
            local expected_target="../../.claude/hooks/$source_file"

            if [ "$current_target" = "$expected_target" ]; then
                rm "$target_path"
                echo -e "${GREEN}✓${NC} Removed $hook_name"
                removed=$((removed + 1))
            else
                echo -e "${YELLOW}Skipped $hook_name (not our symlink)${NC}"
            fi
        elif [ -e "$target_path" ]; then
            echo -e "${YELLOW}Skipped $hook_name (not a symlink)${NC}"
        else
            echo "  $hook_name not installed"
        fi
    done

    echo ""
    echo "Uninstall complete: $removed hooks removed"

    # Check for backups
    local backups=$(ls "$GIT_HOOKS"/*.backup.* 2>/dev/null | wc -l | tr -d ' ')
    if [ "$backups" -gt 0 ]; then
        echo ""
        echo "Note: $backups backup file(s) remain in $GIT_HOOKS"
        echo "Remove manually if no longer needed."
    fi
}

show_status() {
    echo "DorkOS Git Hooks Status"
    echo "======================"
    echo ""

    for hook_def in "${HOOK_DEFS[@]}"; do
        local source_file="${hook_def%%:*}"
        local hook_name="${hook_def##*:}"
        local source_path="$HOOKS_SOURCE/$source_file"
        local target_path="$GIT_HOOKS/$hook_name"

        printf "%-20s " "$hook_name:"

        if [ ! -f "$source_path" ]; then
            echo -e "${RED}source missing${NC}"
        elif [ -L "$target_path" ]; then
            local current_target=$(readlink "$target_path")
            local expected_target="../../.claude/hooks/$source_file"

            if [ "$current_target" = "$expected_target" ]; then
                echo -e "${GREEN}installed (symlink)${NC}"
            else
                echo -e "${YELLOW}symlink exists (different target)${NC}"
            fi
        elif [ -e "$target_path" ]; then
            echo -e "${YELLOW}exists (not symlink)${NC}"
        else
            echo "not installed"
        fi
    done
}

# Parse arguments
case "${1:-}" in
    --uninstall|-u)
        uninstall_hooks
        ;;
    --status|-s)
        show_status
        ;;
    --help|-h)
        echo "Usage: $0 [OPTIONS]"
        echo ""
        echo "Install or manage DorkOS git hooks."
        echo ""
        echo "Options:"
        echo "  (none)        Install hooks (default)"
        echo "  --uninstall   Remove installed hooks"
        echo "  --status      Show installation status"
        echo "  --help        Show this help"
        ;;
    "")
        install_hooks
        ;;
    *)
        echo "Unknown option: $1"
        echo "Run '$0 --help' for usage"
        exit 1
        ;;
esac
