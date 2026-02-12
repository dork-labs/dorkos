---
description: Show notification sound status at user and project levels
allowed-tools: Bash
---

# Notification Sound Status

Check the notification sound configuration at both user and project levels.

## Check Status

Run the following to check both levels:

```bash
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              Notification Sound Status                       ║"
echo "╠══════════════════════════════════════════════════════════════╣"

# Check user level
echo "║"
echo "║  User Level (~/.claude/settings.json)"
if [ -f ~/.claude/settings.json ]; then
  if grep -q "afplay" ~/.claude/settings.json 2>/dev/null; then
    echo "║  Status: ✓ ENABLED"
    # Extract the sound file being used
    SOUND=$(grep -o 'afplay [^"]*' ~/.claude/settings.json 2>/dev/null | head -1 | sed 's/afplay //')
    echo "║  Sound:  $SOUND"
  else
    echo "║  Status: ✗ DISABLED"
  fi
else
  echo "║  Status: ✗ DISABLED (no settings file)"
fi

echo "║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║"

# Check project level
echo "║  Project Level (.claude/settings.json)"
if [ -f .claude/settings.json ]; then
  if grep -q "afplay" .claude/settings.json 2>/dev/null; then
    echo "║  Status: ✓ ENABLED"
    # Extract the sound file being used
    SOUND=$(grep -o 'afplay [^"]*' .claude/settings.json 2>/dev/null | head -1 | sed 's/afplay //')
    echo "║  Sound:  $SOUND"
  else
    echo "║  Status: ✗ DISABLED"
  fi
else
  echo "║  Status: ✗ DISABLED (no settings file)"
fi

echo "║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║"
echo "║  Commands:"
echo "║    /cc:notify:on   - Enable notification sound"
echo "║    /cc:notify:off  - Disable notification sound"
echo "║"
echo "╚══════════════════════════════════════════════════════════════╝"
```

## Notes

- **User level** applies to all Claude Code sessions
- **Project level** applies only to this project
- Project-level settings override user-level settings
- Restart Claude Code after changes for them to take effect
