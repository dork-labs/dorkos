---
description: Remove custom VS Code color scheme
allowed-tools: Read, Edit
---

# Reset VS Code IDE Color Scheme

Remove the custom `workbench.colorCustomizations` from `.vscode/settings.json`, restoring VS Code to its default theme colors.

## Scope

**IMPORTANT: This command ONLY modifies project-level settings.**

| Setting | Path | Modified? |
|---------|------|-----------|
| Project settings | `.vscode/settings.json` | YES |
| User settings | `~/.config/Code/User/settings.json` | **NEVER** |
| User settings (macOS) | `~/Library/Application Support/Code/User/settings.json` | **NEVER** |

**NEVER read, write, or modify any file outside the project's `.vscode/` directory.**

## Steps

### Step 1: Read Project Settings

Read `.vscode/settings.json` (project-level ONLY) to check if custom colors exist.

If the file doesn't exist, inform the user there's nothing to reset.

**CRITICAL: Do NOT read or check any user-level VS Code settings files.**

### Step 2: Check for Custom Colors

Look for the `workbench.colorCustomizations` key in the settings object.

If it doesn't exist or is empty, inform the user there's no custom color scheme to remove.

### Step 3: Remove Color Customizations

If `workbench.colorCustomizations` exists:

1. Remove the entire `workbench.colorCustomizations` key and its contents
2. Preserve ALL other settings in the file (e.g., `terminal.integrated.tabs.title`, editor settings, etc.)
3. Write the updated settings back to the file with proper JSON formatting

### Step 4: Handle Empty Settings

If removing `workbench.colorCustomizations` leaves only `{}`, keep the file with the empty object rather than deleting it.

## Output

**If colors were removed:**

```
IDE Theme Reset

Status: Custom colors removed
File: .vscode/settings.json

VS Code will now use its default theme colors.
Restart VS Code if the change doesn't take effect immediately.
```

**If no custom colors found:**

```
IDE Theme Reset

Status: No custom colors found
File: .vscode/settings.json

The file has no custom color scheme to remove.
VS Code is already using its default theme colors.
```

**If settings file doesn't exist:**

```
IDE Theme Reset

Status: No settings file found
File: .vscode/settings.json (does not exist)

There's no custom configuration to reset.
```
