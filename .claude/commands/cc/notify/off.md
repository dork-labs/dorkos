---
description: Disable notification sound when Claude finishes responding
allowed-tools: Read, Bash
---

# Disable Notification Sound

Disable the notification sound at both user and project levels.

## Step 1: Check Both Levels

Check which level(s) have notifications enabled:

```bash
# Check user level
echo "=== User Level (~/.claude/settings.json) ==="
if [ -f ~/.claude/settings.json ]; then
  grep -q "afplay" ~/.claude/settings.json && echo "ENABLED" || echo "DISABLED"
else
  echo "DISABLED (file not found)"
fi

# Check project level
echo "=== Project Level (.claude/settings.json) ==="
if [ -f .claude/settings.json ]; then
  grep -q "afplay" .claude/settings.json && echo "ENABLED" || echo "DISABLED"
else
  echo "DISABLED (file not found)"
fi
```

## Step 2: Remove from User Level (if enabled)

```bash
node -e "
const fs = require('fs');
const path = require('path');
const settingsPath = path.join(process.env.HOME, '.claude', 'settings.json');

try {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  if (settings.hooks && settings.hooks.Stop) {
    // Remove Stop hooks that contain afplay
    settings.hooks.Stop = settings.hooks.Stop.filter(hookGroup => {
      if (hookGroup.hooks) {
        hookGroup.hooks = hookGroup.hooks.filter(hook =>
          !(hook.command && hook.command.includes('afplay'))
        );
        return hookGroup.hooks.length > 0;
      }
      return true;
    });

    // Clean up empty Stop array
    if (settings.hooks.Stop.length === 0) {
      delete settings.hooks.Stop;
    }

    // Clean up empty hooks object
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log('User level: Notification sound disabled');
  } else {
    console.log('User level: No notification sound was configured');
  }
} catch (e) {
  console.log('User level: No settings file or not configured');
}
"
```

## Step 3: Remove from Project Level (if enabled)

```bash
node -e "
const fs = require('fs');
const settingsPath = '.claude/settings.json';

try {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  if (settings.hooks && settings.hooks.Stop) {
    // Remove Stop hooks that contain afplay
    settings.hooks.Stop = settings.hooks.Stop.filter(hookGroup => {
      if (hookGroup.hooks) {
        hookGroup.hooks = hookGroup.hooks.filter(hook =>
          !(hook.command && hook.command.includes('afplay'))
        );
        return hookGroup.hooks.length > 0;
      }
      return true;
    });

    // Clean up empty Stop array
    if (settings.hooks.Stop.length === 0) {
      delete settings.hooks.Stop;
    }

    // Clean up empty hooks object
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log('Project level: Notification sound disabled');
  } else {
    console.log('Project level: No notification sound was configured');
  }
} catch (e) {
  console.log('Project level: No settings file or not configured');
}
"
```

## Step 4: Report Results

Summarize what was changed:

```
Notifications Disabled

User level (~/.claude/settings.json): [Disabled / Was not enabled]
Project level (.claude/settings.json): [Disabled / Was not enabled]

Note: Restart Claude Code for changes to take effect.
```
