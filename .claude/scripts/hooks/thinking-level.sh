#!/usr/bin/env bash
# Injects thinking level keywords based on configuration

CONFIG_FILE=".claude/hooks-config.json"
LEVEL=2  # Default to megathink

if [ -f "$CONFIG_FILE" ]; then
  LEVEL=$(node -e "const c=require('./$CONFIG_FILE'); console.log(c['thinking-level']?.level ?? 2)" 2>/dev/null || echo "2")
fi

# Map level to keyword
case "$LEVEL" in
  0) KEYWORD="" ;;
  1) KEYWORD="think" ;;
  2) KEYWORD="megathink" ;;
  3) KEYWORD="ultrathink" ;;
  *) KEYWORD="megathink" ;;
esac

# Output JSON response if keyword is set
if [ -n "$KEYWORD" ]; then
  cat << EOF
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"$KEYWORD"}}
EOF
fi

exit 0
