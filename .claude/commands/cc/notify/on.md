---
description: Enable notification sound when Claude finishes responding
allowed-tools: Read, Bash, AskUserQuestion
---

# Enable Notification Sound

Enable a sound notification when Claude finishes responding.

## Step 1: Ask User for Scope

Use AskUserQuestion to determine where to enable notifications:

```
Question: "Where should notifications be enabled?"
Options:
- "User level (all projects)" - Applies to all Claude Code sessions
- "Project level (this project only)" - Only applies when working in this project
```

## Step 2: Apply the Setting

### User Level (~/.claude/settings.json)

If user selected "User level":

1. Read the current settings:
   ```bash
   cat ~/.claude/settings.json 2>/dev/null || echo '{}'
   ```

2. Check if Stop hook already exists. If not, add it.

3. Use a script to safely merge the Stop hook:
   ```bash
   # Create the hook configuration
   node -e "
   const fs = require('fs');
   const path = require('path');
   const settingsPath = path.join(process.env.HOME, '.claude', 'settings.json');

   let settings = {};
   try {
     settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
   } catch (e) {
     settings = {};
   }

   // Ensure hooks object exists
   if (!settings.hooks) settings.hooks = {};

   // Add Stop hook with sound
   settings.hooks.Stop = [
     {
       hooks: [
         {
           type: 'command',
           command: 'afplay /System/Library/Sounds/Glass.aiff'
         }
       ]
     }
   ];

   fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
   console.log('Notification sound enabled at user level (~/.claude/settings.json)');
   "
   ```

### Project Level (.claude/settings.json)

If user selected "Project level":

1. Read the current project settings:
   ```bash
   cat .claude/settings.json 2>/dev/null || echo '{}'
   ```

2. Use a script to safely merge the Stop hook:
   ```bash
   node -e "
   const fs = require('fs');
   const settingsPath = '.claude/settings.json';

   let settings = {};
   try {
     settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
   } catch (e) {
     settings = {};
   }

   // Ensure hooks object exists
   if (!settings.hooks) settings.hooks = {};

   // Add Stop hook with sound
   settings.hooks.Stop = [
     {
       hooks: [
         {
           type: 'command',
           command: 'afplay /System/Library/Sounds/Glass.aiff'
         }
       ]
     }
   ];

   fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
   console.log('Notification sound enabled at project level (.claude/settings.json)');
   "
   ```

## Step 3: Confirm

Report to the user:
- Where notifications were enabled
- Remind them to restart Claude Code for changes to take effect

## Output Format

```
Notifications Enabled

Scope: [User level / Project level]
File: [path to settings.json]

Note: Restart Claude Code for changes to take effect.
```
