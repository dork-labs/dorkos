#!/bin/sh
# A local full run defaults to four workers. Accept a smaller requested pool
# on a shared machine. In CI, leave worker selection to Vitest and its config.
if [ -n "${CI:-}" ]; then
  exit 0
fi

case "${VITEST_MAX_WORKERS:-}" in
  1|2|3) printf '%s\n' "$VITEST_MAX_WORKERS" ;;
  *) printf '4\n' ;;
esac
